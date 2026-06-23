/**
 * Multi-Regime Detection — structured market regime classification.
 *
 * Three orthogonal axes:
 *   • Trend     — direction & strength (ADX + EMA slope)
 *   • Vol       — volatility tier      (ATR percentile)
 *   • Momentum  — short-term velocity  (ROC z-score)
 *
 * Each detector returns a discrete label so strategies can declare affinity:
 *
 *   regimeAffinity: {
 *     trend:    ['trending_up', 'ranging'],
 *     vol:      ['low', 'normal'],
 *     momentum: ['up', 'up_strong'],
 *   }
 *
 * The runner uses `compositeRegime(bars, i)` to gate entries. A strategy fires
 * only when the current bar's regime intersects its declared affinity.
 *
 * For backwards compatibility with Phase 8.7's flat regime label, this module
 * also exports `legacyRegime(bars, i)` which returns the old 5-state label.
 */

import { Quant } from './quant.js';
import { atrSeries, emaSeries, smaSeries } from './indicators.js';

// ── Trend detector ─────────────────────────────────────────────────

/**
 * trendRegime — classify trend at bar `i` using ADX + EMA50 slope.
 * Returns: 'trending_up' | 'trending_down' | 'ranging' | 'mixed' | 'unknown'.
 */
export function trendRegime(bars, i, lookback = 50) {
  if (i < lookback) return 'unknown';
  const slice  = bars.closes.slice(Math.max(0, i - lookback + 1), i + 1);
  const sliceH = bars.highs.slice(Math.max(0, i - lookback + 1), i + 1);
  const sliceL = bars.lows.slice(Math.max(0, i - lookback + 1), i + 1);

  const adxVal = Quant.adx(sliceH, sliceL, slice, 14);
  const ema9   = emaSeries(slice, 9);
  const ema21  = emaSeries(slice, 21);
  const last   = slice.length - 1;
  const trendUp   = ema9[last] && ema21[last] && ema9[last] > ema21[last];
  const trendDown = ema9[last] && ema21[last] && ema9[last] < ema21[last];
  if (adxVal && adxVal > 25 && trendUp)   return 'trending_up';
  if (adxVal && adxVal > 25 && trendDown) return 'trending_down';
  if (adxVal && adxVal < 18) return 'ranging';
  return 'mixed';
}

// ── Vol detector ───────────────────────────────────────────────────

/**
 * volRegime — classify vol at bar `i` by percentile of ATR%(14) over `lookback` bars.
 * Returns: 'low' | 'normal' | 'high' | 'crisis' | 'unknown'.
 *
 * Thresholds (in percentile):
 *   crisis: top 5%      | high: 70-95
 *   normal: 30-70       | low: bottom 30
 */
export function volRegime(bars, i, lookback = 60) {
  if (i < lookback) return 'unknown';
  const atrArr = atrSeries(bars.highs, bars.lows, bars.closes, 14);
  const atrPctNow = bars.closes[i] > 0 ? (atrArr[i] / bars.closes[i]) * 100 : 0;
  const window = [];
  for (let j = Math.max(0, i - lookback + 1); j <= i; j++) {
    if (atrArr[j] && bars.closes[j]) {
      window.push((atrArr[j] / bars.closes[j]) * 100);
    }
  }
  if (window.length < 20) return 'unknown';
  window.sort((a, b) => a - b);
  const pct = percentileRank(window, atrPctNow);
  if (pct >= 95) return 'crisis';
  if (pct >= 70) return 'high';
  if (pct <= 30) return 'low';
  return 'normal';
}

// ── Momentum detector ─────────────────────────────────────────────

/**
 * momentumRegime — short-term velocity via z-score of ROC(rocLen) over `lookback`.
 * Returns: 'up_strong' | 'up' | 'flat' | 'down' | 'down_strong' | 'unknown'.
 */
export function momentumRegime(bars, i, rocLen = 10, lookback = 20) {
  if (i < rocLen + lookback) return 'unknown';
  const rocs = [];
  for (let j = i - lookback + 1; j <= i; j++) {
    if (j >= rocLen) {
      const prev = bars.closes[j - rocLen];
      if (prev > 0) rocs.push(((bars.closes[j] - prev) / prev) * 100);
    }
  }
  if (rocs.length < 10) return 'unknown';
  const stats   = Quant.stats(rocs);
  const current = rocs[rocs.length - 1];
  if (stats.std === 0) return 'flat';
  const z = (current - stats.mean) / stats.std;
  if (z >= 1.5)  return 'up_strong';
  if (z >= 0.5)  return 'up';
  if (z <= -1.5) return 'down_strong';
  if (z <= -0.5) return 'down';
  return 'flat';
}

// ── Composite ──────────────────────────────────────────────────────

/**
 * compositeRegime — return all three component labels in a single object.
 * The runner uses this for gating decisions.
 */
export function compositeRegime(bars, i) {
  return {
    trend:    trendRegime(bars, i),
    vol:      volRegime(bars, i),
    momentum: momentumRegime(bars, i),
  };
}

/**
 * legacyRegime — backwards-compatible 5-state label for Phase 8.7 callers.
 * Equivalent to the original `detectRegimeAt(bars, i)`.
 */
export function legacyRegime(bars, i, lookback = 50) {
  return trendRegime(bars, i, lookback);
}

// ── Affinity matching ──────────────────────────────────────────────

/**
 * matchesRegimeAffinity — does a regime label match any form of regimeAffinity?
 *
 * Handles all three formats that coexist in the codebase:
 *   1. Legacy array:     ['ranging', 'trending_up']
 *   2. Structured object: { trend: ['ranging'], vol: ['low'] }
 *   3. Dashboard score-map: { ranging: 95, volatile: 70 }
 *
 * @param {*} affinity - any regimeAffinity value
 * @param {string} regime - single regime label to test
 * @returns {boolean}
 */
export function matchesRegimeAffinity(affinity, regime) {
  if (!affinity || !regime) return false;
  // 1. Legacy array
  if (Array.isArray(affinity)) return affinity.includes(regime);
  // 2/3. Object — structured {trend:[],vol:[]} or score-map {ranging:95}
  if (typeof affinity === 'object') {
    // Direct key match (works for BOTH structured axes and score-maps)
    if (regime in affinity) return true;
    // Check trend/vol/momentum sub-arrays (structured form)
    if (Array.isArray(affinity.trend) && affinity.trend.includes(regime)) return true;
    if (Array.isArray(affinity.vol) && affinity.vol.includes(regime)) return true;
    if (Array.isArray(affinity.momentum) && affinity.momentum.includes(regime)) return true;
    return false;
  }
  return false;
}

/**
 * passesRegimeGate — true when `regime` (composite or legacy) matches `affinity`.
 *
 *   affinity: ['ranging', 'trending_up']             (legacy array form)
 *   affinity: { trend: ['ranging'], vol: ['low'] }   (structured form)
 *
 * If affinity is null/empty, gate always passes (strategy has no preference).
 * If regime is null (warmup bars), gate denies (conservative — don't trade unknown).
 */
export function passesRegimeGate(regime, affinity) {
  if (!affinity) return true;
  if (regime == null) return false; // warmup / unknown — block

  // Structured form: every declared axis must match
  if (typeof affinity === 'object' && !Array.isArray(affinity)) {
    const r = typeof regime === 'string' ? { trend: regime } : regime;
    if (Array.isArray(affinity.trend)    && r.trend    && !affinity.trend.includes(r.trend))       return false;
    if (Array.isArray(affinity.vol)      && r.vol      && !affinity.vol.includes(r.vol))           return false;
    if (Array.isArray(affinity.momentum) && r.momentum && !affinity.momentum.includes(r.momentum)) return false;
    // If any axis declared but regime missing that axis (e.g. unknown), deny
    if (Array.isArray(affinity.trend)    && !r.trend)    return false;
    if (Array.isArray(affinity.vol)      && !r.vol)      return false;
    if (Array.isArray(affinity.momentum) && !r.momentum) return false;
    return true;
  }

  // Legacy array form: regime is a single string label
  if (Array.isArray(affinity)) {
    if (affinity.length === 0) return true;
    const label = typeof regime === 'string' ? regime : regime.trend;
    return label && affinity.includes(label);
  }

  return true;
}

// ── Helper: percentile rank (where does `x` sit in sorted `arr`?) ─

function percentileRank(sortedArr, x) {
  if (!sortedArr.length) return 0;
  let count = 0;
  for (const v of sortedArr) if (v <= x) count++;
  return (count / sortedArr.length) * 100;
}
