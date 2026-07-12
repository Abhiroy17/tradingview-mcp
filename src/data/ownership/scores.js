/**
 * Ownership score computations — pure, deterministic, unit-testable.
 *
 * Given a current shareholding snapshot and (optionally) the previous quarter,
 * derive:
 *   - Quarter-over-quarter changes (percentage points)
 *   - Smart Money Score       — institutional conviction (FII+DII+MF weighted)
 *   - Institutional Accumulation Score — direction/strength of inst. buying
 *   - Promoter Confidence Score — promoter stake level + pledge + trend
 *
 * All scores are 0-100 (higher = more bullish ownership signal). Missing inputs
 * degrade gracefully to a neutral 50 rather than throwing.
 */

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Compute per-bucket QoQ change (percentage points) between two snapshots.
 * @param {object} curr — current-quarter holding percentages
 * @param {object|null} prev — previous-quarter holding percentages
 */
export function computeChanges(curr, prev) {
  // bucket key → change key (mutualFund → mfChange to match DB columns)
  const buckets = {
    promoter: 'promoterChange', fii: 'fiiChange', dii: 'diiChange',
    mutualFund: 'mfChange', insurance: 'insuranceChange', hni: 'hniChange',
    retail: 'retailChange',
  };
  const out = {};
  for (const [b, key] of Object.entries(buckets)) {
    const c = num(curr?.[b]);
    const p = num(prev?.[b]);
    out[key] = (c != null && p != null) ? round(c - p, 4) : null;
  }
  return out;
}

/**
 * Smart Money Score — weighted institutional presence.
 * FII + DII + MF holdings, level-based, with a QoQ momentum kicker.
 */
export function smartMoneyScore(curr, changes) {
  const fii = num(curr?.fii) ?? 0;
  const dii = num(curr?.dii) ?? 0;
  const mf = num(curr?.mutualFund) ?? 0;
  const insurance = num(curr?.insurance) ?? 0;

  // Level component: institutional footprint. ~40% inst. holding => full marks.
  const instLevel = fii + dii + mf + insurance;
  const levelScore = clamp((instLevel / 40) * 100);

  // Momentum component: are they adding? (percentage-point deltas)
  const dFii = num(changes?.fiiChange) ?? 0;
  const dDii = num(changes?.diiChange) ?? 0;
  const dMf = num(changes?.mfChange) ?? 0;
  const netAdd = dFii + dDii + dMf; // pp added by smart money this quarter
  // +2pp in a quarter is strong accumulation => +25 momentum swing.
  const momentumScore = clamp(50 + (netAdd / 2) * 25, 0, 100);

  // Blend: 60% level, 40% momentum.
  return round(clamp(levelScore * 0.6 + momentumScore * 0.4), 2);
}

/**
 * Institutional Accumulation Score — pure direction/strength of inst. buying
 * over the available quarters. Focuses on the trend, not the level.
 * @param {Array<object>} history — chronological snapshots (oldest→newest), each
 *   with fii/dii/mutualFund fields.
 */
export function institutionalAccumScore(history) {
  if (!Array.isArray(history) || history.length < 2) return 50;
  const inst = history.map((h) =>
    (num(h?.fii) ?? 0) + (num(h?.dii) ?? 0) + (num(h?.mutualFund) ?? 0));

  // Sum of quarter-over-quarter deltas across the window.
  let netDelta = 0;
  let positiveQuarters = 0;
  for (let i = 1; i < inst.length; i++) {
    const d = inst[i] - inst[i - 1];
    netDelta += d;
    if (d > 0.1) positiveQuarters++;
  }
  const consistency = positiveQuarters / (inst.length - 1); // 0..1

  // Net +4pp over the window => strong; scale to 0..100 around neutral 50.
  const magnitudeScore = clamp(50 + (netDelta / 4) * 40);
  const consistencyScore = consistency * 100;

  return round(clamp(magnitudeScore * 0.6 + consistencyScore * 0.4), 2);
}

/**
 * Promoter Confidence Score — stake level, pledge penalty, trend.
 */
export function promoterConfidenceScore(curr, changes) {
  const promoter = num(curr?.promoter);
  if (promoter == null) return 50;

  // Level: 50%+ promoter holding is a strong skin-in-the-game signal.
  const levelScore = clamp((promoter / 55) * 100);

  // Pledge penalty: any pledge is bad; 25%+ pledged is severe.
  const pledge = num(curr?.pledgedPct) ?? 0;
  const pledgePenalty = clamp((pledge / 25) * 40, 0, 40);

  // Trend: promoters increasing stake is bullish, dumping is bearish.
  const dProm = num(changes?.promoterChange) ?? 0;
  const trendAdj = clamp(dProm * 10, -20, 20); // +2pp => +20

  return round(clamp(levelScore - pledgePenalty + trendAdj), 2);
}

/**
 * Full derivation: takes current snapshot + chronological history and returns
 * changes + all three scores + a plain summary.
 * @param {object} curr — current snapshot holding percentages
 * @param {Array<object>} history — chronological (oldest→newest) incl. current
 */
export function deriveOwnershipScores(curr, history = []) {
  const prev = history.length >= 2 ? history[history.length - 2] : null;
  const changes = computeChanges(curr, prev);
  const smart = smartMoneyScore(curr, changes);
  const accum = institutionalAccumScore(history);
  const promoterConf = promoterConfidenceScore(curr, changes);

  const trend =
    accum >= 65 ? 'accumulating' : accum <= 35 ? 'distributing' : 'stable';

  return {
    changes,
    smartMoneyScore: smart,
    institutionalAccumScore: accum,
    promoterConfidenceScore: promoterConf,
    institutionalTrend: trend,
  };
}

function round(n, dp = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
