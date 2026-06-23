/**
 * Multi-window matrix runner.
 *
 * Orchestrates backtests across multiple time windows ('1y', '6m', '3m', '1m')
 * for one or many (code, symbol, timeframe) cells. Two providers:
 *
 *   - 'js'  : uses runStrategy() from contract.js. Pure JS execution. Fast.
 *             Parallelizes across cells (p-limit). Honors cost overrides.
 *   - 'tv'  : uses runTvBacktest() from tv-runner.js. Drives TradingView Desktop.
 *             Serializes (chart is shared global state). Native TV commission
 *             model — cost-profile overrides are ignored.
 *
 * Output shape — uniform across providers — is consumed by ranker v2 and the
 * persistence layer (recordBacktestResult with windowLabel).
 */
import pLimit from 'p-limit';
import { runStrategy, DEFAULT_EXECUTION } from './contract.js';
import { runTvBacktest } from './tv-runner.js';
import { getStrategy } from './registry.js';

/** Standard time windows: longest first so the ranker can apply recency weighting. */
export const TIME_WINDOWS = Object.freeze([
  { label: '1y', days: 365 },
  { label: '6m', days: 183 },
  { label: '3m', days: 91 },
  { label: '1m', days: 30 },
]);

/**
 * HFT-mode TF/window matrix (Phase 8.7). Real-time alert focus:
 *
 *   Intraday : 5m + 15m TFs. 5m runs both 3M + 6M lookbacks for recency
 *              comparison; 15m runs 6M only as anchor.
 *   Swing    : 15m / 1H / 4H / Daily, all on 6M lookback.
 *
 * The 3m TF is intentionally omitted (no provider supplies it natively and
 * we declined aggregation per design). 2H is omitted for the same reason.
 *
 * Each entry is { tf, windows: [{label, days}, ...] }. Run order is
 * longest-window-first so the data router caches benefit downstream.
 */
export const INTRADAY_MATRIX = Object.freeze([
  { tf: '5m',  windows: [{ label: '6M', days: 183 }, { label: '3M', days: 91 }] },
  { tf: '15m', windows: [{ label: '6M', days: 183 }] },
]);

export const SWING_MATRIX = Object.freeze([
  { tf: '1D',  windows: [{ label: '6M', days: 183 }] },
  { tf: '4h',  windows: [{ label: '6M', days: 183 }] },
  { tf: '1h',  windows: [{ label: '6M', days: 183 }] },
  { tf: '15m', windows: [{ label: '6M', days: 183 }] },
]);

/**
 * Provider intraday depth caps — Yahoo limits 5m/15m/30m to ~60 days.
 * Used by runMatrixModes() to clamp lookbacks and flag truncated runs.
 */
export const PROVIDER_INTRADAY_CAPS = Object.freeze({
  yahoo: { '1m': 7, '5m': 60, '15m': 60, '30m': 60, '1h': 730, '4h': 730 },
  upstox: { '1m': 365, '5m': 365, '15m': 365, '30m': 365, '1h': 365 * 3, '4h': 365 * 3 },
});

/**
 * Two cost profiles. Cost-stress (Phase 8.6) runs strategies under both and
 * flags those that collapse — a hint that the backtest edge is too thin to
 * survive realistic friction.
 */
export const COST_PROFILES = Object.freeze({
  base:   { txnCostBps: 10, slippageBps: 5 },   // realistic retail
  stress: { txnCostBps: 25, slippageBps: 15 },  // pessimistic / institutional friction
});

function isoDate(d) { return d.toISOString().slice(0, 10); }

function windowDates(days, now = new Date()) {
  const to = new Date(now);
  const from = new Date(now.getTime() - days * 86400e3);
  return { dateFrom: isoDate(from), dateTo: isoDate(to), days };
}

/**
 * Run a single (code, symbol, timeframe) on one window.
 * Internal helper — callers should use runMultiWindow or runMatrix.
 */
async function _runOneWindow({ code, symbol, timeframe, window, provider, costProfile }) {
  const { dateFrom, dateTo, days } = windowDates(window.days);

  if (provider === 'tv') {
    return runTvBacktest({ code, symbol, timeframe, dateFrom, dateTo });
  }

  // JS path: optionally override execution to apply cost-stress
  const execution = costProfile && COST_PROFILES[costProfile]
    ? { ...DEFAULT_EXECUTION, ...COST_PROFILES[costProfile] }
    : undefined;

  return runStrategy({ code, symbol, timeframe, lookbackDays: days, execution });
}

/**
 * Run a single cell across all configured time windows.
 *
 * @param {Object} args
 * @param {string} args.code
 * @param {string} args.symbol
 * @param {string} args.timeframe
 * @param {'js'|'tv'} [args.provider='js']
 * @param {Array<{label, days}>} [args.windows]
 * @param {'base'|'stress'} [args.costProfile='base']
 * @returns {Promise<{code, symbol, timeframe, provider, costProfile, windows: Record<string, {ok, windowLabel, days, result?, error?}>}>}
 */
export async function runMultiWindow({
  code, symbol, timeframe,
  provider = 'js',
  windows = TIME_WINDOWS,
  costProfile = 'base',
} = {}) {
  if (!code) throw new Error('runMultiWindow: code required');
  if (!symbol) throw new Error('runMultiWindow: symbol required');
  if (!timeframe) throw new Error('runMultiWindow: timeframe required');

  // Validate provider+strategy compatibility up front
  if (provider === 'tv') {
    const meta = getStrategy(code);
    if (!meta) throw new Error(`Unknown strategy: ${code}`);
    if (!meta.tvBacktestable) {
      throw new Error(`Strategy '${code}' is not TV-backtestable (no Pine source). Use provider='js'.`);
    }
  }

  const out = {
    code, symbol, timeframe, provider, costProfile,
    windows: {},
  };

  // Windows run sequentially even for JS — they share bars cache effectively
  // through the data router, and serial execution gives stable timing reports.
  for (const w of windows) {
    try {
      const result = await _runOneWindow({ code, symbol, timeframe, window: w, provider, costProfile });
      out.windows[w.label] = { ok: true, windowLabel: w.label, days: w.days, result };
    } catch (err) {
      out.windows[w.label] = { ok: false, windowLabel: w.label, days: w.days, error: err?.message || String(err) };
    }
  }

  return out;
}

/**
 * Run a matrix of cells. Each cell = { code, symbol, timeframe }.
 *
 * JS provider parallelizes with p-limit. TV provider is forced to
 * concurrency=1 (the chart is shared global state).
 *
 * @param {Object} args
 * @param {Array<{code, symbol, timeframe}>} args.cells
 * @param {'js'|'tv'} [args.provider='js']
 * @param {Array<{label, days}>} [args.windows]
 * @param {'base'|'stress'} [args.costProfile='base']
 * @param {number} [args.concurrency=4]   - ignored when provider='tv'
 * @param {Function} [args.onProgress]    - ({index, total, code, symbol, timeframe}) => void
 * @returns {Promise<Array>} one entry per cell with the full multi-window result
 */
export async function runMatrix({
  cells,
  provider = 'js',
  windows = TIME_WINDOWS,
  costProfile = 'base',
  concurrency = 4,
  onProgress,
} = {}) {
  if (!Array.isArray(cells) || cells.length === 0) {
    throw new Error('runMatrix: cells[] required');
  }
  if (cells.length > 200) {
    throw new Error('runMatrix: max 200 cells per call');
  }

  const effectiveConcurrency = provider === 'tv' ? 1 : Math.max(1, concurrency);
  const limit = pLimit(effectiveConcurrency);

  let completed = 0;
  const tasks = cells.map((cell, idx) => limit(async () => {
    try {
      const cellResult = await runMultiWindow({
        ...cell,
        provider,
        windows,
        costProfile,
      });
      completed++;
      if (typeof onProgress === 'function') {
        try {
          onProgress({ index: idx, total: cells.length, completed, ...cell });
        } catch (_) { /* swallow user-callback errors */ }
      }
      return cellResult;
    } catch (err) {
      // Individual cell failure should not abort the entire matrix.
      // Return a cell with all windows marked as failed.
      completed++;
      if (typeof onProgress === 'function') {
        try {
          onProgress({ index: idx, total: cells.length, completed, ...cell });
        } catch (_) { /* swallow user-callback errors */ }
      }
      const failedWindows = {};
      for (const w of (windows || TIME_WINDOWS)) {
        failedWindows[w.label] = { ok: false, windowLabel: w.label, days: w.days, error: err?.message || String(err) };
      }
      return {
        code: cell.code, symbol: cell.symbol, timeframe: cell.timeframe,
        provider, costProfile,
        windows: failedWindows,
      };
    }
  }));

  return Promise.all(tasks);
}

/**
 * Cost-stress: run a single cell under both base AND stress profiles,
 * return both. Downstream (ranker / UI) flags divergence — strategies whose
 * profit factor collapses under stress are "yellow flagged" as fragile.
 *
 * Only valid for provider='js' — TV uses its own commission model and we
 * can't override it.
 */
export async function runWithCostStress({
  code, symbol, timeframe,
  windows = TIME_WINDOWS,
} = {}) {
  const [base, stress] = await Promise.all([
    runMultiWindow({ code, symbol, timeframe, provider: 'js', windows, costProfile: 'base' }),
    runMultiWindow({ code, symbol, timeframe, provider: 'js', windows, costProfile: 'stress' }),
  ]);
  return {
    code, symbol, timeframe,
    base,
    stress,
    fragility: detectCostFragility(base, stress),
  };
}

/**
 * Compare base vs stress runs across all windows. Returns per-window
 * fragility flags + a summary.
 *
 *   - 'robust'   : PF stays >= 1.2 under stress
 *   - 'fragile'  : PF drops from >= 1.5 (base) to < 1.0 (stress)
 *   - 'unstable' : PF drops > 30% from base to stress
 *   - 'unknown'  : no successful run in either profile
 */
export function detectCostFragility(baseRun, stressRun) {
  const flags = {};
  let robust = 0, fragile = 0, unstable = 0, unknown = 0;

  for (const label of Object.keys(baseRun?.windows || {})) {
    const b = baseRun.windows[label];
    const s = stressRun?.windows?.[label];
    if (!b?.ok || !s?.ok || !b.result || !s.result) {
      flags[label] = 'unknown';
      unknown++;
      continue;
    }
    const basePf = Number(b.result.profitFactor) || 0;
    const stressPf = Number(s.result.profitFactor) || 0;

    let flag;
    if (basePf >= 1.5 && stressPf < 1.0) flag = 'fragile';
    else if (basePf > 0 && (stressPf / basePf) < 0.7) flag = 'unstable';
    else if (stressPf >= 1.2) flag = 'robust';
    else flag = 'unstable';

    flags[label] = flag;
    if (flag === 'robust') robust++;
    else if (flag === 'fragile') fragile++;
    else if (flag === 'unstable') unstable++;
    else unknown++;
  }

  return {
    flags,
    summary: { robust, fragile, unstable, unknown },
    verdict: fragile > 0 ? 'fragile' : unstable > robust ? 'unstable' : 'robust',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8.7 — HFT Intraday/Swing matrix runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Best-effort guess of which provider the data router will pick for a symbol.
 * Used purely for marking provider-dependent truncation. The actual fetch is
 * still mediated by `src/data/providers/router.js`.
 */
function _providerHintForSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s.startsWith('NSE:') || s.startsWith('BSE:')) return 'upstox';
  return 'yahoo';
}

/**
 * Build the flat list of sub-jobs for a single (code, symbol) cell + mode.
 * When mode='both', INTRADAY_MATRIX and SWING_MATRIX are merged with shared
 * (tf, windowDays) pairs deduped (15m × 6M appears in both).
 *
 * Returns: [{ tf, windowLabel, windowDays, modes: ['intraday'|'swing'] }]
 */
function _buildSubJobs(mode) {
  const matrices = [];
  if (mode === 'intraday' || mode === 'both') {
    matrices.push({ name: 'intraday', matrix: INTRADAY_MATRIX });
  }
  if (mode === 'swing' || mode === 'both') {
    matrices.push({ name: 'swing', matrix: SWING_MATRIX });
  }
  if (matrices.length === 0) {
    throw new Error(`runMatrixModes: invalid mode '${mode}' (expected 'intraday' | 'swing' | 'both')`);
  }

  // key = `${tf}|${days}` → { tf, windowLabel, windowDays, modes: Set }
  const dedup = new Map();
  for (const { name, matrix } of matrices) {
    for (const row of matrix) {
      for (const w of row.windows) {
        const key = `${row.tf}|${w.days}`;
        const entry = dedup.get(key) || { tf: row.tf, windowLabel: w.label, windowDays: w.days, modes: new Set() };
        entry.modes.add(name);
        dedup.set(key, entry);
      }
    }
  }
  return [...dedup.values()].map(e => ({
    tf: e.tf,
    windowLabel: e.windowLabel,
    windowDays: e.windowDays,
    modes: [...e.modes],
  }));
}

/**
 * Apply provider intraday depth caps. Returns clamped days + truncation flag.
 */
function _clampForProvider(symbol, tf, requestedDays) {
  const provider = _providerHintForSymbol(symbol);
  const cap = PROVIDER_INTRADAY_CAPS[provider]?.[tf];
  if (!cap) return { days: requestedDays, truncated: false, providerHint: provider };
  if (requestedDays <= cap) return { days: requestedDays, truncated: false, providerHint: provider };
  return { days: cap, truncated: true, providerHint: provider, requestedDays };
}

/**
 * Run one sub-job (single TF × single window) on the JS engine.
 * Returns the same shape as _runOneWindow but enriched with truncation metadata.
 */
async function _runSubJob({ code, symbol, tf, windowDays, costProfile }) {
  const clamp = _clampForProvider(symbol, tf, windowDays);
  const { dateFrom, dateTo, days } = windowDates(clamp.days);

  const execution = costProfile && COST_PROFILES[costProfile]
    ? { ...DEFAULT_EXECUTION, ...COST_PROFILES[costProfile] }
    : undefined;

  const result = await runStrategy({ code, symbol, timeframe: tf, lookbackDays: days, execution });
  return {
    result,
    dateFrom, dateTo, days,
    bars_truncated: clamp.truncated,
    requested_days: clamp.requestedDays || windowDays,
    actual_days: clamp.days,
    provider_hint: clamp.providerHint,
  };
}

/**
 * Phase 8.7 entry point — run a (code, symbol) cell across the mode-specific
 * TF × window matrix. Each cell expands to 3-7 backtests depending on mode.
 *
 * @param {Object} args
 * @param {Array<{code, symbol}>} args.cells       - no `timeframe` field; backend expands
 * @param {'intraday'|'swing'|'both'} args.mode    - default 'both' so UI can switch without re-running
 * @param {string} [args.provider='js']            - 'tv' is rejected (use legacy runMatrix for TV)
 * @param {'base'|'stress'} [args.costProfile='base']
 * @param {number} [args.concurrency=6]
 * @param {Function} [args.onProgress]             - ({completed, total, code, symbol, tf, windowLabel}) => void
 * @returns {Promise<Array>} one aggregated entry per input cell
 */
export async function runMatrixModes({
  cells,
  mode = 'both',
  provider = 'js',
  costProfile = 'base',
  concurrency = 6,
  onProgress,
} = {}) {
  if (!Array.isArray(cells) || cells.length === 0) {
    throw new Error('runMatrixModes: cells[] required');
  }
  if (cells.length > 50) {
    throw new Error('runMatrixModes: max 50 cells per call');
  }
  if (provider === 'tv') {
    throw new Error('runMatrixModes: TV provider does not support Intraday/Swing modes — use legacy runMatrix() with provider=tv');
  }
  if (provider !== 'js') {
    throw new Error(`runMatrixModes: unsupported provider '${provider}'`);
  }

  const subJobTemplates = _buildSubJobs(mode); // shared across all cells
  const totalSubJobs = cells.length * subJobTemplates.length;

  const limit = pLimit(Math.max(1, concurrency));
  let completed = 0;

  // Flatten: one Promise per (cell, subJobTemplate)
  const tasks = [];
  for (const cell of cells) {
    for (const tpl of subJobTemplates) {
      tasks.push(limit(async () => {
        try {
          const sub = await _runSubJob({
            code: cell.code,
            symbol: cell.symbol,
            tf: tpl.tf,
            windowDays: tpl.windowDays,
            costProfile,
          });
          completed++;
          if (typeof onProgress === 'function') {
            try {
              onProgress({
                completed, total: totalSubJobs,
                code: cell.code, symbol: cell.symbol,
                tf: tpl.tf, windowLabel: tpl.windowLabel,
              });
            } catch (_) { /* swallow */ }
          }
          return { cell, tpl, ok: true, ...sub };
        } catch (err) {
          completed++;
          if (typeof onProgress === 'function') {
            try {
              onProgress({
                completed, total: totalSubJobs,
                code: cell.code, symbol: cell.symbol,
                tf: tpl.tf, windowLabel: tpl.windowLabel,
                error: err?.message,
              });
            } catch (_) { /* swallow */ }
          }
          return { cell, tpl, ok: false, error: err?.message || String(err) };
        }
      }));
    }
  }

  const flat = await Promise.all(tasks);

  // Group results back into one aggregated entry per input cell
  const byKey = new Map();
  for (const cell of cells) {
    const key = `${cell.code}|${cell.symbol}`;
    byKey.set(key, {
      code: cell.code,
      symbol: cell.symbol,
      provider: 'js',
      costProfile,
      mode,
      perTfWindowGrid: {},
      provider_warnings: [],
      modesRun: mode === 'both' ? ['intraday', 'swing'] : [mode],
    });
  }

  for (const r of flat) {
    const key = `${r.cell.code}|${r.cell.symbol}`;
    const aggregate = byKey.get(key);
    if (!aggregate) continue;
    if (!aggregate.perTfWindowGrid[r.tpl.tf]) aggregate.perTfWindowGrid[r.tpl.tf] = {};
    if (r.ok) {
      aggregate.perTfWindowGrid[r.tpl.tf][r.tpl.windowLabel] = {
        ok: true,
        windowLabel: r.tpl.windowLabel,
        windowDays: r.tpl.windowDays,
        actualDays: r.actual_days,
        bars_truncated: r.bars_truncated || false,
        modes: r.tpl.modes,
        result: r.result,
      };
      if (r.bars_truncated) {
        aggregate.provider_warnings.push({
          tf: r.tpl.tf,
          windowLabel: r.tpl.windowLabel,
          reason: 'depth_cap',
          requested_days: r.requested_days,
          actual_days: r.actual_days,
          provider: r.provider_hint,
          message: `${r.provider_hint} caps ${r.tpl.tf} history at ${r.actual_days}d (requested ${r.requested_days}d)`,
        });
      }
    } else {
      aggregate.perTfWindowGrid[r.tpl.tf][r.tpl.windowLabel] = {
        ok: false,
        windowLabel: r.tpl.windowLabel,
        windowDays: r.tpl.windowDays,
        modes: r.tpl.modes,
        error: r.error,
      };
    }
  }

  // Preserve input order
  return cells.map(c => byKey.get(`${c.code}|${c.symbol}`));
}
