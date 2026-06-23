/**
 * Ranker v2 — multi-window, Bayesian-shrunk strategy ranking.
 *
 * Consumes output of `runMultiWindow` / `runMatrix` from matrix-runner.js
 * and produces a confidence-weighted score (0..100) per cell.
 *
 * Pipeline:
 *   1. Score each window (1y, 6m, ...) independently on a 0..1 scale using
 *      a weighted mix of PF + Sortino + Wilson WR – DD penalty.
 *   2. Blend window scores using `windowWeights` (defaults: 0.7 * 1y + 0.3 * 6m).
 *   3. Apply Bayesian shrinkage toward a neutral prior (PF=1) using
 *      sample-size (total trades) as evidence weight. Strategies with few
 *      trades get pulled toward the prior.
 *   4. Multiply by a "recency slope" factor derived from 1M/6M PF ratio:
 *      heating-up gets a small bonus, cooling-down a small penalty.
 *   5. Subtract a cost-fragility penalty if the cell has fragility data
 *      (from `runWithCostStress`) and verdict is 'fragile'.
 *   6. Emit confidence tier ('high' | 'medium' | 'low').
 *
 * v2 is purposely additive — v1 ranker (`rankSignals`) remains and is still
 * used by the existing /api/v2/rank endpoint. Callers that want multi-window
 * ranking import from this module directly.
 */
import { getStrategy } from './registry.js';

export const RANKER_V2_DEFAULTS = Object.freeze({
  // Window blend weights. Must sum to ~1 for the blended score to land in 0..1.
  windowWeights: { '1y': 0.7, '6m': 0.3 },

  // Bayesian shrinkage — "tau" virtual trades pulling the score toward the prior.
  shrinkageTau: 30,
  priorScore: 0.30,            // neutral baseline (~ break-even strategy)

  // Per-metric saturation caps. Values >= cap → fully credited.
  pfCap: 3.0,                  // PF=3 is excellent
  sortinoCap: 3.0,             // Sortino=3 is excellent

  // DD penalty: 0 below `ddCapBase`, linearly ramps to 1 at `ddCapMax`.
  ddCapBase: 10,               // <=10% DD → no penalty
  ddCapMax: 40,                // >=40% DD → max penalty

  // Sub-weights inside scoreWindow(). Sum should be ~1.0 (dd is subtracted).
  scoreWeights: { pf: 0.40, sortino: 0.30, wilson: 0.20, dd: 0.10 },

  // Cost-fragility deduction when stress test flags as 'fragile'.
  fragilityPenalty: 0.10,
});

/**
 * MODE_PROFILES — HFT recency-first scoring (Phase 8.7).
 *
 * Each mode controls:
 *   - windowWeights : how to blend lookback windows within each TF
 *   - tfWeights     : how to blend per-TF scores into the final mode score
 *   - recencySlope  : (optional) numerator/denominator window pair for slope
 *   - confidence    : trade-count + backtests-passed thresholds
 *
 * Backtest matrix per mode lives in matrix-runner.js — see INTRADAY_MATRIX
 * and SWING_MATRIX. The ranker reads `cell.perTfWindowGrid` and applies
 * these profile weights.
 *
 *   intraday : 5m heavy, recency-weighted (3M vs 6M slope), tight thresholds
 *   swing    : 4H + Daily heavy, single-window (no slope), wider thresholds
 */
export const MODE_PROFILES = Object.freeze({
  intraday: {
    windowWeights: { '3M': 0.60, '6M': 0.40 },          // recency-heavy
    tfWeights: { '5m': 0.65, '15m': 0.35 },             // 5m sweet spot
    // Recency slope only meaningful where we have 2 windows
    recencySlope: { tf: '5m', numerator: '3M', denominator: '6M' },
    // Lower thresholds since intraday windows are shorter (fewer trades expected)
    confTradesHigh: 30, confTradesMed: 15,
    confBacktestsHigh: 2, confBacktestsMed: 2,
    // Slightly looser shrinkage prior since we expect fewer trades per cell
    shrinkageTau: 20,
  },
  swing: {
    windowWeights: { '6M': 1.00 },                       // single window per TF
    tfWeights: { '15m': 0.10, '1h': 0.20, '4h': 0.35, '1D': 0.35 },
    recencySlope: null,                                  // no recency in swing
    confTradesHigh: 40, confTradesMed: 20,
    confBacktestsHigh: 3, confBacktestsMed: 2,
    shrinkageTau: 30,
  },
});

function normalize(value, cap) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(v / cap, 1);
}

function ddPenalty(ddPct, base, cap) {
  const v = Number(ddPct);
  if (!Number.isFinite(v) || v <= base) return 0;
  if (v >= cap) return 1;
  return (v - base) / (cap - base);
}

/**
 * Score a single window's flat result on 0..1.
 * Returns { score, components, trades } for transparency.
 */
export function scoreWindow(result, opts = {}) {
  const cfg = { ...RANKER_V2_DEFAULTS, ...opts };
  if (!result || !result.totalTrades) {
    return { score: 0, components: { pf: 0, sortino: 0, wilson: 0, dd: 0 }, trades: 0 };
  }
  const pf = normalize(result.profitFactor, cfg.pfCap);
  const sor = normalize(result.sortino, cfg.sortinoCap);
  const wilson = (Number(result.wilsonWR) || 0) / 100;
  const dd = ddPenalty(result.maxDrawdown, cfg.ddCapBase, cfg.ddCapMax);
  const w = cfg.scoreWeights;
  const raw = (w.pf * pf) + (w.sortino * sor) + (w.wilson * wilson) - (w.dd * dd);
  return {
    score: Math.max(0, Math.min(1, raw)),
    components: {
      pf: Number(pf.toFixed(3)),
      sortino: Number(sor.toFixed(3)),
      wilson: Number(wilson.toFixed(3)),
      dd: Number(dd.toFixed(3)),
    },
    trades: result.totalTrades,
  };
}

/**
 * Recency slope. Compares short-term (1M) vs medium-term (6M) PF.
 *   - 1M PF >= 1.2 × 6M PF → "heating up", bonus up to +15%
 *   - 1M PF <= 0.6 × 6M PF → "cooling down", penalty up to -15%
 *   - between → neutral (1.0)
 */
export function recencySlope(windows) {
  const pf1m = windows?.['1m']?.ok && windows['1m'].result ? Number(windows['1m'].result.profitFactor) || 0 : null;
  const pf6m = windows?.['6m']?.ok && windows['6m'].result ? Number(windows['6m'].result.profitFactor) || 0 : null;
  if (!pf1m || !pf6m) return { multiplier: 1.0, slope: null, reason: 'insufficient_windows' };

  const ratio = pf1m / pf6m;
  let multiplier = 1.0;
  let reason = 'stable';
  if (ratio >= 1.2) {
    multiplier = Math.min(1.15, 1 + 0.15 * Math.min(1, (ratio - 1.2) / 0.5));
    reason = 'heating_up';
  } else if (ratio <= 0.6) {
    multiplier = Math.max(0.85, 1 - 0.15 * Math.min(1, (0.6 - ratio) / 0.4));
    reason = 'cooling_down';
  }
  return {
    multiplier: Number(multiplier.toFixed(4)),
    slope: Number(ratio.toFixed(3)),
    reason,
  };
}

/**
 * Bayesian shrinkage toward the prior. Low-trade-count strategies get pulled
 * toward `priorScore`. As trades → ∞, the measured score dominates.
 */
function applyShrinkage(score, trades, cfg) {
  if (trades <= 0) return cfg.priorScore;
  const w = trades / (trades + cfg.shrinkageTau);
  return w * score + (1 - w) * cfg.priorScore;
}

/**
 * Map (totalTrades, windowsPassed) → confidence label.
 */
function confidenceTier(totalTrades, windowsPassed) {
  if (totalTrades >= 50 && windowsPassed >= 3) return 'high';
  if (totalTrades >= 20 && windowsPassed >= 2) return 'medium';
  return 'low';
}

/**
 * Score one multi-window cell.
 *
 * @param {Object} cellResult - output of runMultiWindow()
 * @param {Object} [opts]     - override RANKER_V2_DEFAULTS
 * @returns {Object} cellResult with `rankingV2` block attached
 */
export function scoreMultiWindow(cellResult, opts = {}) {
  const cfg = { ...RANKER_V2_DEFAULTS, ...opts };
  const windows = cellResult?.windows || {};
  const ww = cfg.windowWeights;

  let blendedNumer = 0;
  let blendedDenom = 0;
  let totalTrades = 0;
  const windowScores = {};

  for (const [label, weight] of Object.entries(ww)) {
    const w = windows[label];
    if (!w?.ok || !w.result) continue;
    const sw = scoreWindow(w.result, cfg);
    windowScores[label] = sw;
    blendedNumer += weight * sw.score;
    blendedDenom += weight;
    totalTrades += sw.trades;
  }

  const blended = blendedDenom > 0 ? blendedNumer / blendedDenom : 0;
  const shrunk = applyShrinkage(blended, totalTrades, cfg);
  const slope = recencySlope(windows);
  let adjusted = shrunk * slope.multiplier;

  // Cost-fragility deduction (only present if cell came from runWithCostStress)
  let fragilityHit = 0;
  if (cellResult?.fragility?.verdict === 'fragile') {
    fragilityHit = cfg.fragilityPenalty;
    adjusted -= fragilityHit;
  }

  const final = Math.max(0, Math.min(1, adjusted));
  const windowsPassed = Object.values(windowScores).filter(s => s.trades > 0).length;

  const meta = getStrategy(cellResult?.code);

  return {
    ...cellResult,
    rankingV2: {
      score: Math.round(final * 100),
      scoreRaw: Number(final.toFixed(4)),
      blended: Number(blended.toFixed(4)),
      shrunk: Number(shrunk.toFixed(4)),
      slope,
      fragilityPenalty: Number(fragilityHit.toFixed(4)),
      totalTrades,
      windowsPassed,
      windowScores,
      confidence: confidenceTier(totalTrades, windowsPassed),
      family: meta?.family || null,
      style: meta?.style || null,
    },
  };
}

/**
 * Rank a list of multi-window cells. Returns sorted by score desc.
 */
export function rankSignalsV2(cells, opts = {}) {
  const enriched = (cells || []).map(c => scoreMultiWindow(c, opts));
  enriched.sort((a, b) => (b.rankingV2?.score ?? 0) - (a.rankingV2?.score ?? 0));
  enriched.forEach((c, i) => { c.rankingV2.rank = i + 1; });
  return enriched;
}

/**
 * Group ranked cells by symbol and return the top N per symbol.
 * Order within each symbol respects the input rank order (already sorted).
 */
export function topNPerSymbolV2(rankedCells, n = 3) {
  const out = {};
  for (const c of rankedCells || []) {
    if (!c?.symbol) continue;
    if (!out[c.symbol]) out[c.symbol] = [];
    if (out[c.symbol].length < n) out[c.symbol].push(c);
  }
  return out;
}

/**
 * Filter to cells whose confidence is 'medium' or 'high'. Useful for
 * surfacing actionable picks to the UI without noise from low-N strategies.
 */
export function highConfidenceOnly(rankedCells) {
  return (rankedCells || []).filter(c =>
    c.rankingV2?.confidence === 'high' || c.rankingV2?.confidence === 'medium',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8.7 — HFT mode-aware scoring (Intraday / Swing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mode-specific recency slope. Reads MODE_PROFILES[mode].recencySlope to
 * find the right (TF, numerator, denominator) tuple. Returns multiplier in
 * [0.85, 1.15] with a reason label suitable for GenAI key_signals.
 */
function modeRecencySlope(perTfWindowGrid, mode) {
  const profile = MODE_PROFILES[mode];
  if (!profile?.recencySlope) {
    return { multiplier: 1.0, slope: null, reason: 'no_slope_for_mode', tf: null };
  }
  const { tf, numerator, denominator } = profile.recencySlope;
  const tfData = perTfWindowGrid?.[tf];
  if (!tfData) {
    return { multiplier: 1.0, slope: null, reason: 'tf_missing', tf };
  }
  const num = tfData[numerator]?.ok && tfData[numerator]?.result
    ? Number(tfData[numerator].result.profitFactor) || 0 : null;
  const den = tfData[denominator]?.ok && tfData[denominator]?.result
    ? Number(tfData[denominator].result.profitFactor) || 0 : null;
  // Trade-count gate: treat as insufficient if either window has <3 trades
  const numTrades = tfData[numerator]?.result?.totalTrades || 0;
  const denTrades = tfData[denominator]?.result?.totalTrades || 0;
  if (!num || !den || numTrades < 3 || denTrades < 3) {
    return { multiplier: 1.0, slope: null, reason: 'insufficient_data', tf };
  }
  const ratio = num / den;
  let multiplier = 1.0, reason = 'stable';
  if (ratio >= 1.2) {
    multiplier = Math.min(1.15, 1 + 0.15 * Math.min(1, (ratio - 1.2) / 0.5));
    reason = 'heating_up';
  } else if (ratio <= 0.6) {
    multiplier = Math.max(0.85, 1 - 0.15 * Math.min(1, (0.6 - ratio) / 0.4));
    reason = 'cooling_down';
  }
  return {
    multiplier: Number(multiplier.toFixed(4)),
    slope: Number(ratio.toFixed(3)),
    reason,
    tf,
    numeratorWindow: numerator,
    denominatorWindow: denominator,
    numeratorPF: Number(num.toFixed(3)),
    denominatorPF: Number(den.toFixed(3)),
  };
}

/**
 * Mode-specific confidence tier from total trades + backtests-passed count.
 * "Backtests passed" = (TF, window) cells with >=3 trades.
 *
 * Reduces by one tier when any window in the cell is bars_truncated.
 */
function modeConfidenceTier({ totalTrades, backtestsPassed, anyTruncated, mode }) {
  const profile = MODE_PROFILES[mode] || MODE_PROFILES.intraday;
  let tier;
  if (totalTrades >= profile.confTradesHigh && backtestsPassed >= profile.confBacktestsHigh) tier = 'high';
  else if (totalTrades >= profile.confTradesMed && backtestsPassed >= profile.confBacktestsMed) tier = 'medium';
  else tier = 'low';
  if (anyTruncated && tier === 'high') tier = 'medium';
  else if (anyTruncated && tier === 'medium') tier = 'low';
  return tier;
}

/**
 * Score one TF (its windows blended) for a given mode.
 *
 * @param {Object} tfWindowMap     - perTfWindowGrid[tf] = { '3M': {...}, '6M': {...} }
 * @param {string} mode            - 'intraday' | 'swing'
 * @param {Object} cfg             - merged RANKER_V2_DEFAULTS
 * @returns {{ score, components, trades, windowsScored, windowDetail }}
 */
function _scoreTfForMode(tfWindowMap, mode, cfg) {
  const profile = MODE_PROFILES[mode];
  const ww = profile.windowWeights;

  let blendedNumer = 0, blendedDenom = 0;
  let totalTrades = 0;
  const windowDetail = {};
  let windowsScored = 0;

  for (const [label, weight] of Object.entries(ww)) {
    const w = tfWindowMap?.[label];
    if (!w?.ok || !w.result) {
      windowDetail[label] = { ok: false, error: w?.error || 'missing' };
      continue;
    }
    const sw = scoreWindow(w.result, cfg);
    windowDetail[label] = {
      ok: true,
      score: sw.score,
      components: sw.components,
      trades: sw.trades,
      bars_truncated: !!w.bars_truncated,
      profitFactor: Number(w.result.profitFactor?.toFixed?.(3) ?? w.result.profitFactor) || 0,
      winRate: Number(w.result.winRate?.toFixed?.(2) ?? w.result.winRate) || 0,
      maxDrawdown: Number(w.result.maxDrawdown?.toFixed?.(2) ?? w.result.maxDrawdown) || 0,
    };
    blendedNumer += weight * sw.score;
    blendedDenom += weight;
    totalTrades += sw.trades;
    windowsScored++;
  }

  const blended = blendedDenom > 0 ? blendedNumer / blendedDenom : 0;

  // Bayesian shrinkage with mode-specific tau
  const tau = profile.shrinkageTau || cfg.shrinkageTau;
  const shrunk = totalTrades > 0
    ? (totalTrades / (totalTrades + tau)) * blended + (tau / (totalTrades + tau)) * cfg.priorScore
    : cfg.priorScore;

  return {
    score: Math.max(0, Math.min(1, shrunk)),
    blendedRaw: Number(blended.toFixed(4)),
    shrunk: Number(shrunk.toFixed(4)),
    trades: totalTrades,
    windowsScored,
    windowDetail,
  };
}

/**
 * Score one cell (output of runMatrixModes) for one mode.
 * Returns the per-mode block: { score, tfScores, slope, confidence, ... }
 */
export function scoreCellForMode({ cell, mode, opts = {} }) {
  if (!cell?.perTfWindowGrid) {
    return {
      score: 0,
      reason: 'no_grid',
      tfScores: {},
      slope: { multiplier: 1.0, reason: 'no_data' },
      confidence: 'low',
      totalTrades: 0,
      backtestsPassed: 0,
      anyTruncated: false,
    };
  }
  const cfg = { ...RANKER_V2_DEFAULTS, ...opts };
  const profile = MODE_PROFILES[mode];
  if (!profile) throw new Error(`scoreCellForMode: unknown mode '${mode}'`);

  const tfWeights = profile.tfWeights;
  const tfScores = {};
  const tfDetails = {};

  let totalTrades = 0;
  let backtestsPassed = 0;
  let anyTruncated = false;

  // Score each TF in this mode's TF set
  let blendedNumer = 0, blendedDenom = 0;
  for (const [tf, weight] of Object.entries(tfWeights)) {
    const tfMap = cell.perTfWindowGrid[tf];
    if (!tfMap) {
      tfScores[tf] = 0;
      tfDetails[tf] = { score: 0, missing: true };
      continue;
    }
    const ts = _scoreTfForMode(tfMap, mode, cfg);
    tfScores[tf] = Number(ts.score.toFixed(4));
    tfDetails[tf] = ts;
    totalTrades += ts.trades;

    // Count backtests-passed at the (tf, window) level (≥3 trades each)
    for (const wd of Object.values(ts.windowDetail)) {
      if (wd?.ok && wd.trades >= 3) backtestsPassed++;
      if (wd?.ok && wd.bars_truncated) anyTruncated = true;
    }
    blendedNumer += weight * ts.score;
    blendedDenom += weight;
  }

  const blendedAcrossTfs = blendedDenom > 0 ? blendedNumer / blendedDenom : 0;
  const slope = modeRecencySlope(cell.perTfWindowGrid, mode);
  let adjusted = blendedAcrossTfs * slope.multiplier;

  // Cost-fragility deduction (preserved)
  let fragilityHit = 0;
  if (cell?.fragility?.verdict === 'fragile') {
    fragilityHit = cfg.fragilityPenalty;
    adjusted -= fragilityHit;
  }

  const finalRaw = Math.max(0, Math.min(1, adjusted));
  const confidence = modeConfidenceTier({ totalTrades, backtestsPassed, anyTruncated, mode });

  return {
    score: Math.round(finalRaw * 100),
    scoreRaw: Number(finalRaw.toFixed(4)),
    blendedAcrossTfs: Number(blendedAcrossTfs.toFixed(4)),
    tfScores,
    tfDetails,
    slope,
    fragilityPenalty: Number(fragilityHit.toFixed(4)),
    totalTrades,
    backtestsPassed,
    anyTruncated,
    confidence,
  };
}

/**
 * Score a multi-TF cell for BOTH modes (intraday + swing). The selected
 * mode's score drives sorting; the other is kept on the cell for instant
 * UI toggling and GenAI consumption.
 */
export function scoreMultiTFCell(cell, opts = {}) {
  if (!cell) return null;
  const meta = getStrategy(cell.code);

  const intraday = scoreCellForMode({ cell, mode: 'intraday', opts });
  const swing = scoreCellForMode({ cell, mode: 'swing', opts });

  // Provider-warning aggregation (already on cell from runMatrixModes)
  const providerWarnings = Array.isArray(cell.provider_warnings) ? cell.provider_warnings : [];

  return {
    ...cell,
    rankingV2: {
      mode: cell.mode || 'both',
      intradayScore: intraday.score,
      swingScore: swing.score,
      intraday,
      swing,
      meta: {
        code: cell.code,
        symbol: cell.symbol,
        family: meta?.family || null,
        style: meta?.style || null,
        totalSubJobs: countSubJobs(cell),
        providerWarnings,
      },
    },
  };
}

function countSubJobs(cell) {
  if (!cell?.perTfWindowGrid) return 0;
  let n = 0;
  for (const tfMap of Object.values(cell.perTfWindowGrid)) {
    n += Object.keys(tfMap || {}).length;
  }
  return n;
}

/**
 * Rank an array of cells (output of runMatrixModes) by the given mode's score.
 * Both intradayScore and swingScore remain on each cell so the UI can re-sort
 * without re-running.
 */
export function rankCellsByMode(cells, mode = 'intraday', opts = {}) {
  const sortKey = mode === 'swing' ? 'swingScore' : 'intradayScore';
  const enriched = (cells || []).map(c => scoreMultiTFCell(c, opts));
  enriched.sort((a, b) => (b.rankingV2?.[sortKey] ?? 0) - (a.rankingV2?.[sortKey] ?? 0));
  enriched.forEach((c, i) => { if (c.rankingV2) c.rankingV2.rank = i + 1; });
  return enriched;
}

/**
 * Top-N per symbol using mode-specific score.
 */
export function topNPerSymbolByMode(rankedCells, mode = 'intraday', n = 3) {
  const out = {};
  for (const c of rankedCells || []) {
    if (!c?.symbol) continue;
    if (!out[c.symbol]) out[c.symbol] = [];
    if (out[c.symbol].length < n) out[c.symbol].push(c);
  }
  // Re-sort each bucket by the active mode's score (defensive)
  const sortKey = mode === 'swing' ? 'swingScore' : 'intradayScore';
  for (const sym of Object.keys(out)) {
    out[sym].sort((a, b) => (b.rankingV2?.[sortKey] ?? 0) - (a.rankingV2?.[sortKey] ?? 0));
  }
  return out;
}

/**
 * Build the GenAI-friendly payload (Phase 8.7 / 6.1 of the plan).
 * Pure transform — no I/O. Produces human/LLM-readable bullets.
 */
export function buildGenAIPayload(rankedCell) {
  if (!rankedCell?.rankingV2) return null;
  const r = rankedCell.rankingV2;

  function modeBlock(modeKey) {
    const block = r[modeKey];
    if (!block) return null;
    const signals = [];
    // Recency-slope fact (intraday only)
    if (block.slope?.reason === 'heating_up' || block.slope?.reason === 'cooling_down') {
      const dir = block.slope.reason === 'heating_up' ? 'heating up' : 'cooling down';
      const pctChange = ((block.slope.multiplier - 1) * 100).toFixed(1);
      signals.push(`${block.slope.tf} ${block.slope.numeratorWindow} PF ${block.slope.numeratorPF} vs ${block.slope.denominatorWindow} PF ${block.slope.denominatorPF} — ${dir} (${pctChange >= 0 ? '+' : ''}${pctChange}%)`);
    }
    // Per-TF fact: best TF
    let bestTf = null, bestScore = -1;
    for (const [tf, score] of Object.entries(block.tfScores || {})) {
      if (score > bestScore) { bestScore = score; bestTf = tf; }
    }
    if (bestTf && block.tfDetails?.[bestTf]) {
      const det = block.tfDetails[bestTf];
      signals.push(`Best TF: ${bestTf} score ${(bestScore * 100).toFixed(0)}, ${det.trades} trades`);
    }
    // Trade-count fact
    signals.push(`Total ${block.totalTrades} trades across ${block.backtestsPassed} valid backtests`);
    // Truncation warning
    if (block.anyTruncated) {
      signals.push(`Some windows truncated by provider data depth — confidence reduced`);
    }
    return {
      score: block.score,
      confidence: block.confidence,
      best_tf: bestTf,
      recency_signal: block.slope?.reason || null,
      key_signals: signals,
      warnings: block.anyTruncated ? ['bars_truncated'] : [],
    };
  }

  const intraday = modeBlock('intraday');
  const swing = modeBlock('swing');

  // Decision hint
  const gap = (intraday?.score || 0) - (swing?.score || 0);
  let decision_hint;
  if ((intraday?.score || 0) < 35 && (swing?.score || 0) < 35) decision_hint = 'avoid';
  else if (gap > 10) decision_hint = 'intraday_preferred';
  else if (gap < -10) decision_hint = 'swing_preferred';
  else decision_hint = 'tie';

  return {
    schema_version: '1.0',
    code: rankedCell.code,
    symbol: rankedCell.symbol,
    family: r.meta?.family,
    style: r.meta?.style,
    intraday,
    swing,
    decision_hint,
    raw_grid: rankedCell.perTfWindowGrid,
    provider_warnings: r.meta?.providerWarnings || [],
  };
}
