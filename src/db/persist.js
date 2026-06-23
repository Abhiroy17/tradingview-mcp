/**
 * Backtest result persistence layer.
 *
 * Bridges the FLAT result shape from `runBacktest` (and per-window cells from
 * `runMultiWindow`) into the column-shaped `recordBacktestResult` writer in
 * src/db/matrix.js. Persistence is best-effort (fire-and-forget) so a DB
 * outage never affects API latency or correctness.
 *
 * Usage:
 *   import { persistResult, persistMatrixCell } from '../db/persist.js';
 *   persistResult({ symbol, code, name, timeframe, params, result, provider });
 *   persistMatrixCell({ cell, provider });    // cell from runMultiWindow output
 *
 * All functions return a Promise but callers can safely ignore it.
 */

import { isDbConfigured } from './client.js';
import { recordBacktestResult } from './matrix.js';

/** True if persistence layer is usable. Cheap, no I/O. */
export function persistEnabled() {
  return isDbConfigured();
}

/**
 * Convert a flat backtest result to the column-shaped `metrics` object.
 * Field names match `src/db/matrix.js` INSERT INTO backtest_metrics.
 */
export function flatResultToMetrics(result) {
  if (!result || typeof result !== 'object') return null;
  const trades = Array.isArray(result.trades) ? result.trades : [];
  const wins = trades.filter(t => (t.pnl ?? t.pnlPct ?? 0) > 0).length;
  const losses = trades.filter(t => (t.pnl ?? t.pnlPct ?? 0) <= 0).length;

  return {
    totalTrades:   result.totalTrades ?? trades.length,
    wins,
    losses,
    winRate:       toNum(result.winRate),                 // already 0..100
    profitFactor:  toNum(result.profitFactor),
    totalPnlPct:   toNum(result.totalPnl),                // % return on initial cap
    avgWinPct:     toNum(result.avgWin),
    avgLossPct:    toNum(result.avgLoss),
    maxDdPct:      toNum(result.maxDrawdown),             // already 0..100
    expectancy:    toNum(result.expectancy),
    sharpe:        toNum(result.sharpe),
    sortino:       toNum(result.sortino),
    calmar:        toNum(result.calmar),
    ulcer:         toNum(result.ulcer),
    wilsonLb:      toNum(result.wilsonWR),                // wilson lower bound, already 0..100
    psr:           null,                                  // not computed by JS engine yet
    deflatedSharpe: null,                                 // not computed yet
    bootstrapLo:   null,
    bootstrapHi:   null,
    oosTrades:     toNum(result.oos?.trades),
    oosWinRate:    toNum(result.oos?.winRate),
    oosPf:         null,                                  // OOS PF not surfaced — leave null
    avgHoldBars:   avgHoldBarsOf(trades),
  };
}

function avgHoldBarsOf(trades) {
  if (!trades.length) return null;
  const bars = trades.map(t => t.barsHeld).filter(b => typeof b === 'number');
  if (!bars.length) return null;
  return bars.reduce((a, b) => a + b, 0) / bars.length;
}

/**
 * Map the in-memory trade objects (from runner.js) to the trade_log column shape.
 * Filters out trades with null entry/exit timestamps because trade_log.entry_ts /
 * exit_ts are NOT NULL columns and a single bad row would abort the entire
 * persistence transaction (run + metrics + equity all rolled back).
 */
export function tradesToDbShape(trades) {
  const out = [];
  let idx = 0;
  for (const t of trades || []) {
    const entryTs = tsToIso(t.entryTime);
    const exitTs  = tsToIso(t.exitTime);
    if (!entryTs || !exitTs) continue;   // schema requires both
    out.push({
      idx: idx++,
      entryTs,
      exitTs,
      entryPx: toNum(t.entryPrice),
      exitPx:  toNum(t.exitPrice),
      pnlPct:  toNum(t.pnl ?? t.pnlPct),
      barsHeld: t.barsHeld ?? null,
      exitReason: t.exitReason || null,
      regime: t.regime || null,
    });
  }
  return out;
}

/**
 * Compact regimePerformance object → array shape expected by recordBacktestResult.
 */
export function regimeBreakdownOf(result) {
  const rp = result?.regimePerformance;
  if (!rp || typeof rp !== 'object') return [];
  return Object.entries(rp).map(([regime, v]) => ({
    regime,
    trades:  v.trades ?? v.count ?? 0,
    wins:    null,
    winRate: toNum(v.winRate),
    avgPnlPct: toNum(v.avgPnl),
    profitFactor: toNum(v.profitFactor),
  }));
}

/**
 * Compact equity curve → [{t, e}] points (cap at 200 points for storage).
 * `t` is the bar index (or epoch seconds when available); `e` is equity value.
 */
export function equityPointsOf(result) {
  const eq = result?.equity || result?.equityFull || [];
  if (!Array.isArray(eq) || eq.length === 0) return [];

  const target = 200;
  const step = Math.max(1, Math.floor(eq.length / target));
  const out = [];
  const equityValueOf = v => (typeof v === 'number' ? v : (v?.equity ?? v?.value ?? 0));
  const tValueOf      = (v, i) => (typeof v === 'number' ? i : (v?.t ?? v?.time ?? i));
  for (let i = 0; i < eq.length; i += step) {
    out.push({ t: tValueOf(eq[i], i), e: equityValueOf(eq[i]) });
  }
  // Append the final point if downsampling missed it (avoid duplicate when step=1).
  const lastI = eq.length - 1;
  if (out.length === 0 || out[out.length - 1].t !== tValueOf(eq[lastI], lastI)) {
    out.push({ t: tValueOf(eq[lastI], lastI), e: equityValueOf(eq[lastI]) });
  }
  return out;
}

/**
 * Persist a single backtest result. Fire-and-forget — never throws.
 *
 * @param {Object} args
 * @param {string} args.symbol         e.g. 'AAPL'
 * @param {string} args.code           strategy code
 * @param {string} args.name           strategy name (for first-time upsert)
 * @param {string} args.timeframe      '1D' etc
 * @param {Object} [args.params]
 * @param {Object} args.result         flat result from runBacktest
 * @param {string} args.provider       'yahoo' | 'upstox' | 'cdp' | 'tv_strategy_tester'
 * @param {string} [args.windowLabel]  '1y' | '6m' | '3m' | '1m' | 'all' (default 'all')
 * @param {string} [args.dateFrom]     ISO date
 * @param {string} [args.dateTo]       ISO date
 * @returns {Promise<{ok:boolean, runId?:number, error?:string, skipped?:boolean}>}
 */
export async function persistResult({
  symbol, code, name, timeframe, params, result,
  provider = 'yahoo', windowLabel = 'all',
  dateFrom = null, dateTo = null,
}) {
  if (!persistEnabled()) return { ok: false, skipped: true };
  if (!result || !symbol || !code || !timeframe) {
    return { ok: false, error: 'missing required fields' };
  }

  const metrics = flatResultToMetrics(result);
  if (!metrics) return { ok: false, error: 'no metrics' };

  const run = {
    symbol,
    strategy: code,
    strategyName: name || code,
    timeframe,
    params: params || {},
    dateFrom: dateFrom || derivedDateFrom(result),
    dateTo:   dateTo   || derivedDateTo(result),
    sampleSize: result.barsAnalyzed ?? 0,
    provider,
    windowLabel,
  };

  try {
    const runId = await recordBacktestResult(
      run,
      metrics,
      regimeBreakdownOf(result),
      equityPointsOf(result),
      tradesToDbShape(result.trades || []),
    );
    return { ok: true, runId };
  } catch (err) {
    console.warn(`[persist] ${symbol}/${code}/${timeframe}/${windowLabel} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Persist all windows of a matrix cell (from runMultiWindow / runMatrix).
 *
 * @param {Object} args
 * @param {Object} args.cell      one cell from runMatrix/runMultiWindow
 * @param {string} args.provider  data provider ('yahoo'/'upstox'/etc.) or 'tv_strategy_tester'
 */
export async function persistMatrixCell({ cell, provider = 'yahoo' }) {
  if (!persistEnabled()) return { ok: false, skipped: true };
  if (!cell || !cell.windows) return { ok: false, error: 'no windows on cell' };

  const out = { ok: true, persisted: [] };
  const nowIso = new Date().toISOString();
  for (const [windowLabel, win] of Object.entries(cell.windows)) {
    if (!win?.ok || !win.result) continue;
    // Fallback dates: when a window has 0 trades, derive from win.days so the
    // NOT NULL date_from/date_to constraints still get values.
    const fallbackTo   = nowIso;
    const fallbackFrom = win.days
      ? new Date(Date.now() - win.days * 86400_000).toISOString()
      : nowIso;
    const r = await persistResult({
      symbol:      cell.symbol,
      code:        cell.code,
      name:        win.result.name || cell.name,
      timeframe:   cell.timeframe,
      params:      win.result.params || {},
      result:      win.result,
      provider,
      windowLabel,
      dateFrom:    fallbackFrom,
      dateTo:      fallbackTo,
    });
    if (r.ok) out.persisted.push({ windowLabel, runId: r.runId });
    else out.persisted.push({ windowLabel, error: r.error });
  }
  return out;
}

/**
 * Persist a Phase-8.7 multi-TF cell (output of runMatrixModes).
 * Iterates perTfWindowGrid[tf][windowLabel] and writes one row per (tf, window).
 *
 * @param {Object} args
 * @param {Object} args.cell      one cell from runMatrixModes
 * @param {string} args.provider  data provider hint
 */
export async function persistMatrixCellModes({ cell, provider = 'yahoo' }) {
  if (!persistEnabled()) return { ok: false, skipped: true };
  if (!cell || !cell.perTfWindowGrid) return { ok: false, error: 'no perTfWindowGrid on cell' };

  const out = { ok: true, persisted: [] };
  const nowIso = new Date().toISOString();
  for (const [tf, windowMap] of Object.entries(cell.perTfWindowGrid)) {
    for (const [windowLabel, win] of Object.entries(windowMap || {})) {
      if (!win?.ok || !win.result) continue;
      const days = win.actualDays || win.windowDays;
      const fallbackTo = nowIso;
      const fallbackFrom = days
        ? new Date(Date.now() - days * 86400_000).toISOString()
        : nowIso;
      const r = await persistResult({
        symbol:      cell.symbol,
        code:        cell.code,
        name:        win.result.name || cell.name,
        timeframe:   tf,
        params:      win.result.params || {},
        result:      win.result,
        provider,
        windowLabel, // '3M' | '6M'
        dateFrom:    fallbackFrom,
        dateTo:      fallbackTo,
      });
      if (r.ok) out.persisted.push({ tf, windowLabel, runId: r.runId });
      else out.persisted.push({ tf, windowLabel, error: r.error });
    }
  }
  return out;
}

/**
 * Persist a batch of Phase-8.7 mode cells (parallel, best-effort).
 */
export async function persistMatrixModesBatch(cells, provider = 'yahoo', concurrency = 4) {
  if (!persistEnabled() || !Array.isArray(cells) || !cells.length) {
    return { ok: false, skipped: true, count: 0 };
  }
  const queue = [...cells];
  let inFlight = 0;
  let persisted = 0;
  let failed = 0;
  return new Promise(resolve => {
    const tick = () => {
      while (inFlight < concurrency && queue.length) {
        const c = queue.shift();
        inFlight++;
        persistMatrixCellModes({ cell: c, provider })
          .then(r => {
            if (r.ok) persisted += (r.persisted || []).filter(p => !p.error).length;
            else failed++;
          })
          .catch(() => { failed++; })
          .finally(() => {
            inFlight--;
            if (!queue.length && inFlight === 0) resolve({ ok: true, persisted, failed });
            else tick();
          });
      }
    };
    tick();
  });
}

/**
 * Persist a batch of cells in parallel (best-effort).
 *
 * @param {Object[]} cells       cells from runMatrix
 * @param {string} provider
 * @param {number} [concurrency] default 4
 */
export async function persistMatrixBatch(cells, provider = 'yahoo', concurrency = 4) {
  if (!persistEnabled() || !Array.isArray(cells) || !cells.length) {
    return { ok: false, skipped: true, count: 0 };
  }
  const queue = [...cells];
  let inFlight = 0;
  let persisted = 0;
  let failed = 0;
  return new Promise(resolve => {
    const tick = () => {
      while (inFlight < concurrency && queue.length) {
        const c = queue.shift();
        inFlight++;
        persistMatrixCell({ cell: c, provider })
          .then(r => {
            if (r.ok) persisted += (r.persisted || []).filter(p => !p.error).length;
            else failed++;
          })
          .catch(() => { failed++; })
          .finally(() => {
            inFlight--;
            if (!queue.length && inFlight === 0) resolve({ ok: true, persisted, failed });
            else tick();
          });
      }
    };
    tick();
  });
}

/* ── helpers ─────────────────────────────────────────────────────── */

function toNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function tsToIso(ts) {
  if (!ts) return null;
  const n = Number(ts);
  if (!isFinite(n)) return null;
  // Heuristic: treat <1e12 as seconds, ≥1e12 as ms
  const d = new Date(n < 1e12 ? n * 1000 : n);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function derivedDateFrom(result) {
  const eq = result?.equityFull || result?.equity || [];
  const trades = result?.trades || [];
  // Prefer first trade time, fall back to anything we can find
  const firstTrade = trades[0]?.entryTime;
  const firstEq    = eq[0]?.t;
  const fromTrade  = tsToIso(firstTrade) || tsToIso(firstEq);
  if (fromTrade) return fromTrade;
  // Last-resort fallback so NOT NULL constraints don't trip on empty windows:
  // estimate from bars analyzed (~1 bar per day for daily TF).
  const bars = result?.barsAnalyzed;
  if (typeof bars === 'number' && bars > 0) {
    return new Date(Date.now() - bars * 86400_000).toISOString();
  }
  return new Date().toISOString();
}

function derivedDateTo(result) {
  const trades = result?.trades || [];
  const lastTrade = trades[trades.length - 1]?.exitTime;
  return tsToIso(lastTrade) || new Date().toISOString();
}
