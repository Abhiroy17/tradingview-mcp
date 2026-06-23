/**
 * AI Meta-Layer — heuristic signal ranker.
 *
 * Takes results from `scanMatrix()` (or any compatible array of `{ok, code, symbol,
 * timeframe, result}`) and ranks them by composite score.
 *
 * The ranker is a *fact-based* aggregator — it does NOT generate new signals.
 * It scores existing signals using:
 *   - Strategy's regimeAffinity vs current detected regime  (+20 / -10)
 *   - Wilson lower-bound win rate (Wilson > 50% gets bonus)
 *   - Profit factor                                         (PF >= 1.5 bonus, <1 penalty)
 *   - Sharpe ratio                                          (>=1 bonus, <0 penalty)
 *   - Sample size (number of trades)                        (<10 = unreliable penalty)
 *   - OOS win rate consistency                              (~ in-sample = bonus, divergent = penalty)
 *   - Current signal type                                    (BUY/SELL = full, WAIT = 0, IN_TRADE = small bonus)
 *
 * Returns: array of items sorted by `score` desc, each with `score` (0-100), `tier`
 * ('strong' / 'good' / 'weak' / 'avoid'), and `factors` array explaining the score.
 *
 * Optional LLM enrichment is provided via `rankWithLLM(items, opts)` if env keys set.
 */

import { getStrategy } from './registry.js';
import { matchesRegimeAffinity } from './regimes.js';

const DEFAULTS = {
  minTrades: 10,           // anything below this is "unreliable" — capped at 50
  liveSignalWeight: 1.0,   // multiplier for current-signal type bonus
  regimeWeight: 1.0,       // multiplier for regime-affinity bonus
  prefer: null,            // 'mean_reversion' | 'trend_following' etc. — soft bias
};

/**
 * Rank a list of scan results.
 *
 * @param {Array} scanResults - output of scanMatrix() or similar
 * @param {Object} opts - ranking options (see DEFAULTS)
 * @returns {Array} - sorted results with score, tier, factors, ranking
 */
export function rankSignals(scanResults, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const items = scanResults
    .filter(r => r.ok && r.result)
    .map(r => scoreOne(r, cfg))
    .sort((a, b) => b.score - a.score);

  // assign ranks
  for (let i = 0; i < items.length; i++) items[i].rank = i + 1;
  return items;
}

/**
 * Score a single scan result. Returns the result + score/tier/factors metadata.
 *
 * NOTE: runBacktest returns metrics FLAT on the result object (totalTrades,
 * winRate, profitFactor, sharpe, etc.), not under a `metrics` namespace.
 * winRate is in percent (0..100), maxDrawdown is in percent.
 * OOS keys: `oos.trades`, `oos.winRate`, `oos.wilsonWR`, `oos.totalPnl`.
 * Regime is set only for live mode; backtest exposes `regimePerformance` map.
 */
function scoreOne(r, cfg) {
  const meta = getStrategy(r.code) || {};
  const result = r.result || {};
  const cur = result.currentSignal || {};
  const oos = result.oos || null;
  const regime = result.regime
    || dominantRegime(result.regimePerformance);

  // Read FLAT metrics
  const trades = result.totalTrades ?? 0;
  const winRatePct = result.winRate ?? null;        // 0..100
  const profitFactor = result.profitFactor ?? null; // number
  const sharpe = result.sharpe ?? null;
  const maxDDPct = result.maxDrawdown ?? null;      // 0..100
  const wilsonWRPct = result.wilsonWR ?? null;      // 0..100

  let score = 50; // start neutral
  const factors = [];

  // ── 1. Current signal type ──
  if (cur.type === 'BUY' || cur.type === 'SELL') {
    score += 10 * cfg.liveSignalWeight;
    factors.push({ label: `Active ${cur.type} signal`, delta: +10, kind: 'signal' });
  } else if (cur.type === 'IN_TRADE') {
    score += 3 * cfg.liveSignalWeight;
    factors.push({ label: 'Already in trade', delta: +3, kind: 'signal' });
  }

  // ── 2. Regime affinity ──
  if (regime && meta.regimeAffinity) {
    const affMatchesRegime = matchesRegimeAffinity(meta.regimeAffinity, regime);
    const affHasEntries = Array.isArray(meta.regimeAffinity)
      ? meta.regimeAffinity.length > 0
      : typeof meta.regimeAffinity === 'object' ? Object.keys(meta.regimeAffinity).length > 0 : false;
    if (affMatchesRegime) {
      score += 15 * cfg.regimeWeight;
      factors.push({ label: `Affinity for ${regime}`, delta: +15, kind: 'regime' });
    } else if (regime !== 'unknown' && affHasEntries) {
      score -= 8 * cfg.regimeWeight;
      factors.push({ label: `No affinity for ${regime}`, delta: -8, kind: 'regime' });
    }
  }

  // ── 3. Wilson lower-bound win rate (sample-size adjusted) ──
  if (trades >= cfg.minTrades && winRatePct != null) {
    // Prefer the pre-computed Wilson from runner if available
    const wlbPct = wilsonWRPct != null ? wilsonWRPct : wilsonLower(winRatePct / 100, trades) * 100;
    if (wlbPct >= 55) { score += 12; factors.push({ label: `Wilson WR ${wlbPct.toFixed(0)}% (n=${trades})`, delta: +12, kind: 'edge' }); }
    else if (wlbPct >= 45) { score += 4; factors.push({ label: `Wilson WR ${wlbPct.toFixed(0)}% (n=${trades})`, delta: +4, kind: 'edge' }); }
    else if (wlbPct < 40) { score -= 10; factors.push({ label: `Weak Wilson WR ${wlbPct.toFixed(0)}%`, delta: -10, kind: 'edge' }); }
  } else if (trades < cfg.minTrades) {
    score = Math.min(score, 50);
    factors.push({ label: `Only ${trades} trades — unreliable`, delta: 0, kind: 'warn' });
  }

  // ── 4. Profit factor ──
  if (profitFactor != null && trades >= 5) {
    if (profitFactor >= 1.8) { score += 10; factors.push({ label: `PF ${profitFactor.toFixed(2)}`, delta: +10, kind: 'edge' }); }
    else if (profitFactor >= 1.3) { score += 5; factors.push({ label: `PF ${profitFactor.toFixed(2)}`, delta: +5, kind: 'edge' }); }
    else if (profitFactor < 1.0 && profitFactor > 0) { score -= 8; factors.push({ label: `Negative PF ${profitFactor.toFixed(2)}`, delta: -8, kind: 'edge' }); }
  }

  // ── 5. Sharpe ratio ──
  if (sharpe != null && trades >= 10) {
    if (sharpe >= 1.5) { score += 8; factors.push({ label: `Sharpe ${sharpe.toFixed(2)}`, delta: +8, kind: 'risk' }); }
    else if (sharpe >= 0.7) { score += 3; factors.push({ label: `Sharpe ${sharpe.toFixed(2)}`, delta: +3, kind: 'risk' }); }
    else if (sharpe < 0) { score -= 6; factors.push({ label: `Sharpe ${sharpe.toFixed(2)}`, delta: -6, kind: 'risk' }); }
  }

  // ── 6. Max drawdown ──
  if (maxDDPct != null && trades >= 5) {
    if (maxDDPct >= 30) { score -= 8; factors.push({ label: `Max DD ${maxDDPct.toFixed(0)}%`, delta: -8, kind: 'risk' }); }
    else if (maxDDPct >= 20) { score -= 3; factors.push({ label: `Max DD ${maxDDPct.toFixed(0)}%`, delta: -3, kind: 'risk' }); }
  }

  // ── 7. OOS consistency ──
  if (oos && oos.trades >= 3 && winRatePct != null && oos.winRate != null) {
    const drift = Math.abs(oos.winRate - winRatePct); // both in percent
    if (drift < 10) { score += 6; factors.push({ label: 'OOS matches IS', delta: +6, kind: 'edge' }); }
    else if (drift > 25) { score -= 8; factors.push({ label: `OOS drift ${drift.toFixed(0)}%`, delta: -8, kind: 'edge' }); }
  }

  // ── 8. Soft preference (family bias) ──
  if (cfg.prefer && meta.family === cfg.prefer) {
    score += 4;
    factors.push({ label: `Prefers ${cfg.prefer}`, delta: +4, kind: 'preference' });
  }

  // ── 9. Source bias: profitable > untested > loss ──
  if (meta.source === 'profitable') { score += 3; factors.push({ label: 'Curated profitable', delta: +3, kind: 'source' }); }
  else if (meta.source === 'loss') { score -= 5; factors.push({ label: 'Tagged loss-prone', delta: -5, kind: 'source' }); }

  // Clamp to 0..100
  score = Math.max(0, Math.min(100, score));

  return {
    ...r,
    score,
    tier: tierForScore(score),
    factors,
    explanation: synthesizeExplanation(score, factors, meta, cur, regime),
  };
}

/**
 * Pick the regime where the strategy has spent the most bars (backtest mode).
 */
function dominantRegime(regimePerf) {
  if (!regimePerf || typeof regimePerf !== 'object') return null;
  let best = null, bestCount = 0;
  for (const [reg, perf] of Object.entries(regimePerf)) {
    const count = perf?.count ?? perf?.trades ?? 0;
    if (count > bestCount) { bestCount = count; best = reg; }
  }
  return best;
}

function tierForScore(s) {
  if (s >= 75) return 'strong';
  if (s >= 60) return 'good';
  if (s >= 45) return 'neutral';
  if (s >= 30) return 'weak';
  return 'avoid';
}

/**
 * Compute Wilson 95% lower-bound of a binomial proportion.
 * Used to penalise small-sample win rates.
 */
function wilsonLower(p, n, z = 1.96) {
  if (n === 0) return 0;
  const phat = p;
  const denom = 1 + (z * z) / n;
  const center = phat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
  return Math.max(0, (center - margin) / denom);
}

function synthesizeExplanation(score, factors, meta, cur, regime) {
  if (factors.length === 0) return 'No backtest data available.';
  const positives = factors.filter(f => f.delta > 0);
  const negatives = factors.filter(f => f.delta < 0);
  const warns = factors.filter(f => f.kind === 'warn');

  const parts = [];
  if (cur.type === 'BUY' || cur.type === 'SELL') {
    parts.push(`${cur.type} signal active`);
  } else if (cur.type === 'IN_TRADE') {
    parts.push('Already holding');
  } else if (cur.type === 'WAIT') {
    parts.push('No entry');
  }
  if (regime && meta.regimeAffinity) {
    const affMatchesRegime = matchesRegimeAffinity(meta.regimeAffinity, regime);
    if (affMatchesRegime) {
      parts.push(`good fit for ${regime}`);
    }
  }
  if (positives.length > negatives.length + 1) {
    parts.push(`${positives.length} positive factors`);
  } else if (negatives.length > positives.length) {
    parts.push(`${negatives.length} cautions`);
  }
  if (warns.length > 0) {
    parts.push(warns[0].label.toLowerCase());
  }
  return parts.join(' · ');
}

/**
 * Group ranked items by symbol and return top-N per symbol.
 */
export function topNPerSymbol(rankedItems, n = 3) {
  const bySymbol = new Map();
  for (const item of rankedItems) {
    if (!bySymbol.has(item.symbol)) bySymbol.set(item.symbol, []);
    bySymbol.get(item.symbol).push(item);
  }
  const out = {};
  for (const [sym, items] of bySymbol) {
    out[sym] = items.slice(0, n);
  }
  return out;
}

/**
 * Filter ranked items to only actionable ones (BUY/SELL/IN_TRADE).
 */
export function actionableRanked(rankedItems) {
  return rankedItems.filter(item => {
    const t = item.result?.currentSignal?.type;
    return t === 'BUY' || t === 'SELL' || t === 'IN_TRADE';
  });
}
