/**
 * Multibagger scorer — 7-axis fundamental scoring engine.
 *
 * Axes:
 *  1. Growth (revenue/EPS CAGR, secular trend)
 *  2. Profitability (ROE, ROCE, ROA, margins)
 *  3. Financial Health (debt/equity, interest coverage, F-Score, current ratio)
 *  4. Valuation (P/E, PEG, P/B — sector-relative + vs own history)
 *  5. Results-momentum (QoQ/YoY profit, margin trend, consistency)
 *  6. Near-term catalyst (inflection, cheap+accelerating, estimates, institutional)
 *  7. Earnings Quality (CFO/NP, accruals, receivable/inventory days, dilution)
 *
 * Each axis: 0–100 subscore. Weighted composite → multibaggerScore.
 * Tier: strong|good|neutral|weak|avoid. Red/green flags.
 */

import { computeFScore } from './fscore.js';

// ── Axis weights (tunable) ────────────────────────────────────────────────

export const DEFAULT_WEIGHTS = Object.freeze({
  growth: 0.13,
  profitability: 0.10,
  health: 0.08,
  valuation: 0.05,           // Reduced — P/E alone is misleading for growth stocks
  resultsMomentum: 0.38,     // Dominant — explosive profit growth is THE stock price driver
  catalyst: 0.17,
  earningsQuality: 0.09,
});

// ── Utility ───────────────────────────────────────────────────────────────

function clamp(v, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }
function normalize(v, low, high) {
  if (v == null || !isFinite(v)) return 50; // neutral if missing/invalid
  if (high === low) return 50; // avoid division by zero
  return clamp(((v - low) / (high - low)) * 100);
}
function invertNormalize(v, low, high) {
  // Lower is better (e.g. P/E, debt/equity)
  if (v == null || !isFinite(v)) return 50;
  if (high === low) return 50; // avoid division by zero
  return clamp(100 - ((v - low) / (high - low)) * 100);
}

// ── Axis scorers ──────────────────────────────────────────────────────────

function scoreGrowth(snap) {
  const scores = [];
  const weights = [];
  // Revenue CAGR 3y (0-50% → 0-100)
  if (snap.revenueCAGR3y != null) { scores.push(normalize(snap.revenueCAGR3y, 0, 50)); weights.push(1); }
  // EPS CAGR 3y
  if (snap.epsCAGR3y != null) { scores.push(normalize(snap.epsCAGR3y, 0, 50)); weights.push(1); }
  // Revenue CAGR 5y — long-horizon consistency (Lynch/Smith durable compounder)
  if (snap.revenueCAGR5y != null) { scores.push(normalize(snap.revenueCAGR5y, 0, 40)); weights.push(1.5); }
  // EPS CAGR 5y — highest weight; sustained multi-year EPS compounding is the multibagger DNA
  if (snap.epsCAGR5y != null) { scores.push(normalize(snap.epsCAGR5y, 0, 40)); weights.push(1.5); }
  // TTM revenue growth
  if (snap.revenueGrowth != null) { scores.push(normalize(snap.revenueGrowth, 0, 40)); weights.push(1); }
  // TTM earnings growth
  if (snap.earningsGrowth != null) { scores.push(normalize(snap.earningsGrowth, 0, 50)); weights.push(1); }

  if (scores.length === 0) return 50;
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  return Math.round(scores.reduce((s, v, i) => s + v * weights[i], 0) / totalWeight);
}

function scoreProfitability(snap) {
  const scores = [];
  const weights = [];
  // ROCE (Terry Smith's key capital-efficiency metric; >20% is elite) — highest weight
  if (snap.roce != null) { scores.push(normalize(snap.roce, 5, 35)); weights.push(2); }
  // ROCE 5y average — rewards consistency, not a one-off good year
  if (snap.roce5yAvg != null) { scores.push(normalize(snap.roce5yAvg, 5, 30)); weights.push(1.5); }
  // ROE (0-30% → 0-100)
  if (snap.roe != null) { scores.push(normalize(snap.roe, 0, 30)); weights.push(1.5); }
  // ROA (0-15% → 0-100)
  if (snap.roa != null) { scores.push(normalize(snap.roa, 0, 15)); weights.push(1); }
  // Operating margin (0-30% → 0-100)
  if (snap.operatingMargin != null) { scores.push(normalize(snap.operatingMargin, 0, 30)); weights.push(1); }
  // Operating margin 5y average — margin stability (durable moat proxy)
  if (snap.opm5yAvg != null) { scores.push(normalize(snap.opm5yAvg, 0, 25)); weights.push(1); }
  // Net margin (0-20% → 0-100)
  if (snap.netMargin != null) { scores.push(normalize(snap.netMargin, 0, 20)); weights.push(1); }

  if (scores.length === 0) return 50;
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  return Math.round(scores.reduce((s, v, i) => s + v * weights[i], 0) / totalWeight);
}

function scoreHealth(snap, fscoreResult) {
  const scores = [];
  // Debt/equity — lower is better (0-200 → 100-0)
  if (snap.debtToEquity != null) scores.push(invertNormalize(snap.debtToEquity, 0, 200));
  // Interest coverage (higher = safer, 0-10 → 0-100)
  if (snap.interestCoverage != null) scores.push(normalize(snap.interestCoverage, 0, 10));
  // Current ratio (1.0-3.0 → 0-100)
  if (snap.currentRatio != null) scores.push(normalize(snap.currentRatio, 0.5, 3));
  // F-Score (0-9 → 0-100)
  if (fscoreResult) scores.push(normalize(fscoreResult.score, 0, 9));

  if (scores.length === 0) return 50;
  return Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
}

function scoreValuation(snap, sectorMedians) {
  const scores = [];
  const weights = [];

  const isHighGrowth = (snap.netProfitYoY != null && snap.netProfitYoY > 80) || (snap.earningsGrowth != null && snap.earningsGrowth > 50);

  // Forward P/E — more accurate than trailing (reflects expected growth)
  if (snap.forwardPe != null) {
    if (isHighGrowth) {
      scores.push(invertNormalize(snap.forwardPe, 5, 80));
    } else {
      scores.push(invertNormalize(snap.forwardPe, 5, 60));
    }
    weights.push(2); // Forward P/E weighted higher than trailing
  }

  // Trailing P/E — reduced importance (high P/E ≠ overvalued for growth stocks)
  if (snap.pe != null && sectorMedians?.pe) {
    const relPe = snap.pe / sectorMedians.pe;
    scores.push(invertNormalize(relPe, 0.3, 2.5));
    weights.push(1);
  } else if (snap.pe != null) {
    if (isHighGrowth) {
      scores.push(invertNormalize(snap.pe, 10, 120)); // Very lenient for high-growth
    } else {
      scores.push(invertNormalize(snap.pe, 5, 80));
    }
    weights.push(0.8); // Low weight — P/E alone is misleading
  }

  // PEG — best single valuation metric for growth stocks
  if (snap.peg != null) {
    scores.push(invertNormalize(snap.peg, 0, 3));
    weights.push(2.5); // Highest weight — PEG captures growth-adjusted value
  } else if (isHighGrowth && snap.pe != null && snap.netProfitYoY != null && snap.netProfitYoY > 0) {
    // Synthetic PEG: PE / growth%. For 643% growth with PE 50 → PEG = 0.08 (extremely cheap)
    const syntheticPeg = snap.pe / Math.min(snap.netProfitYoY, 200);
    scores.push(invertNormalize(syntheticPeg, 0, 2));
    weights.push(2.5);
  }

  // EV/EBITDA — enterprise value metric, less distorted than P/E
  if (snap.evToEbitda != null) {
    scores.push(invertNormalize(snap.evToEbitda, 3, 40));
    weights.push(1.5);
  }

  // P/B — lower vs sector
  if (snap.pb != null && sectorMedians?.pb) {
    const relPb = snap.pb / sectorMedians.pb;
    scores.push(invertNormalize(relPb, 0.3, 3));
    weights.push(1);
  } else if (snap.pb != null) {
    scores.push(invertNormalize(snap.pb, 0.5, 10));
    weights.push(0.8);
  }

  // Earnings yield vs risk-free rate proxy (inverse P/E > 5% = attractive)
  if (snap.pe != null && isFinite(snap.pe) && snap.pe > 0) {
    const earningsYield = (1 / snap.pe) * 100; // in %
    scores.push(normalize(earningsYield, 1, 15)); // 1% yield = bad, 15% = great
    weights.push(1);
  }

  if (scores.length === 0) return 50;
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  return Math.round(scores.reduce((s, v, i) => s + v * weights[i], 0) / totalWeight);
}

function scoreResultsMomentum(snap) {
  const scores = [];
  const weights = [];

  // Net profit YoY — THE key turnaround signal. Explosive growth gets near-max score.
  // Scale: -30% → 0, 30% → 40, 80% → 60, 150% → 80, 300% → 90, 500%+ → 98
  if (snap.netProfitYoY != null) {
    let s;
    if (snap.netProfitYoY >= 300) s = clamp(90 + normalize(snap.netProfitYoY, 300, 1000) * 0.10, 90, 100);
    else if (snap.netProfitYoY >= 150) s = 80 + normalize(snap.netProfitYoY, 150, 300) * 0.10;
    else if (snap.netProfitYoY >= 80) s = 60 + normalize(snap.netProfitYoY, 80, 150) * 0.20;
    else if (snap.netProfitYoY >= 30) s = 40 + normalize(snap.netProfitYoY, 30, 80) * 0.20;
    else s = normalize(snap.netProfitYoY, -30, 30) * 0.40;
    scores.push(s);
    weights.push(snap.netProfitYoY > 150 ? 6 : snap.netProfitYoY > 80 ? 5 : 3); // 6x weight for >150% YoY — explosive growth dominates
  }

  // Net profit QoQ — sequential acceleration, strong signal for hidden gems
  if (snap.netProfitQoQ != null) {
    let s;
    if (snap.netProfitQoQ >= 100) s = clamp(80 + normalize(snap.netProfitQoQ, 100, 500) * 0.20, 80, 100);
    else if (snap.netProfitQoQ >= 30) s = 50 + normalize(snap.netProfitQoQ, 30, 100) * 0.30;
    else s = normalize(snap.netProfitQoQ, -30, 30);
    scores.push(s);
    weights.push(snap.netProfitQoQ > 50 ? 3.5 : 2.5); // high weight for QoQ acceleration
  }

  // Revenue YoY
  if (snap.revenueYoY != null) {
    scores.push(normalize(snap.revenueYoY, -10, 80));
    weights.push(1);
  }

  // Margin trend
  if (snap.marginTrend === 'up') { scores.push(90); weights.push(1.5); }
  else if (snap.marginTrend === 'flat') { scores.push(50); weights.push(1); }
  else if (snap.marginTrend === 'down') { scores.push(15); weights.push(1); }

  // Consecutive growth quarters (0-5+ → 0-100) — durability proof
  if (snap.consecutiveGrowthQuarters != null) {
    scores.push(normalize(snap.consecutiveGrowthQuarters, 0, 5));
    weights.push(snap.consecutiveGrowthQuarters >= 3 ? 1.5 : 1);
  }

  // EBITDA margin
  if (snap.ebitdaMargin != null) {
    scores.push(normalize(snap.ebitdaMargin, 0, 30));
    weights.push(0.5);
  }

  if (scores.length === 0) return 50;
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  return Math.round(scores.reduce((s, v, i) => s + v * weights[i], 0) / totalWeight);
}

function scoreCatalyst(snap, sectorMedians) {
  const scores = [];

  // Earnings inflection / turnaround (massive QoQ jump or loss → profit)
  if (snap.netProfitQoQ != null && snap.netProfitQoQ > 30) {
    scores.push(clamp(60 + normalize(snap.netProfitQoQ, 30, 300) * 0.40, 60, 100));
  }

  // Explosive YoY growth + still cheap = highest conviction re-rating setup
  if (snap.netProfitYoY != null && snap.netProfitYoY > 100 && snap.pe != null && snap.pe < 40) {
    scores.push(95); // Massive growth + reasonable P/E = hidden gem
  }

  // Cheap + accelerating combo (P/E < sector median AND earnings growing)
  if (snap.pe != null && sectorMedians?.pe && snap.earningsGrowth != null) {
    if (snap.pe < sectorMedians.pe && snap.earningsGrowth > 15) {
      scores.push(85); // Strong re-rating signal
    }
  }

  // Earnings surprise
  if (snap.earningsSurprisePct != null && snap.earningsSurprisePct > 5) {
    scores.push(normalize(snap.earningsSurprisePct, 0, 30));
  }

  // Estimate revisions
  if (snap.estimateRevisionTrend === 'up') scores.push(80);
  else if (snap.estimateRevisionTrend === 'flat') scores.push(50);
  else if (snap.estimateRevisionTrend === 'down') scores.push(20);

  // Recent analyst upgrades
  if (snap.recentUpgrades > 0) scores.push(normalize(snap.recentUpgrades, 0, 5));

  // Margin inflection (down → up transition in recent quarters)
  if (snap.marginTrend === 'up') scores.push(70);

  // Price vs 52w high (proximity = momentum confirmation)
  if (snap.priceVs52wHigh != null && snap.priceVs52wHigh > 80) {
    scores.push(normalize(snap.priceVs52wHigh, 80, 100));
  }

  if (scores.length === 0) return 50;
  return Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
}

function scoreEarningsQuality(snap) {
  const scores = [];

  // CFO / Net Profit (higher = better cash backing; 50-150% ideal)
  if (snap.cfoToProfit != null) {
    scores.push(normalize(snap.cfoToProfit, 0, 150));
  }

  // Receivable days trend — lower is better (30-200)
  if (snap.receivableDays != null) {
    scores.push(invertNormalize(snap.receivableDays, 20, 200));
  }

  // Inventory days — lower is better (30-300)
  if (snap.inventoryDays != null) {
    scores.push(invertNormalize(snap.inventoryDays, 20, 300));
  }

  // Dilution — no dilution is good, heavy dilution is bad
  if (snap.dilutionPct != null) {
    scores.push(invertNormalize(snap.dilutionPct, -5, 20)); // -5% (buyback) = great, 20% = terrible
  }

  // Tax rate normality — abnormally low could be one-off
  if (snap.effectiveTaxRate != null) {
    // Normal corporate tax 20-30%, below 10% is suspicious
    if (snap.effectiveTaxRate >= 15 && snap.effectiveTaxRate <= 35) scores.push(80);
    else if (snap.effectiveTaxRate < 10) scores.push(30); // suspicious
    else scores.push(50);
  }

  if (scores.length === 0) return 50;
  return Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
}

// ── Quality composite (Terry Smith style) ──────────────────────────────────

/**
 * Terry Smith quality composite: high ROCE, low leverage, strong cash conversion,
 * stable margins. Returns a 0–100 score plus the criteria met (for flags/preset fit).
 */
function computeQualityComposite(snap) {
  const checks = [];
  // High ROCE (>20% elite, >15% good)
  if (snap.roce != null) checks.push({ label: 'roce', met: snap.roce >= 20, score: normalize(snap.roce, 8, 30) });
  // Consistent ROCE across 5y
  if (snap.roce5yAvg != null) checks.push({ label: 'roce5y', met: snap.roce5yAvg >= 18, score: normalize(snap.roce5yAvg, 8, 28) });
  // High ROE
  if (snap.roe != null) checks.push({ label: 'roe', met: snap.roe >= 18, score: normalize(snap.roe, 8, 28) });
  // Low leverage (D/E < 30)
  if (snap.debtToEquity != null) checks.push({ label: 'lowDebt', met: snap.debtToEquity < 30, score: invertNormalize(snap.debtToEquity, 0, 100) });
  // Cash conversion CFO > NP
  if (snap.cfoToProfit != null) checks.push({ label: 'cashConv', met: snap.cfoToProfit >= 90, score: normalize(snap.cfoToProfit, 40, 120) });
  // Margin stability (5y OPM healthy)
  if (snap.opm5yAvg != null) checks.push({ label: 'marginStable', met: snap.opm5yAvg >= 15, score: normalize(snap.opm5yAvg, 5, 25) });

  if (checks.length === 0) return { score: 50, metCount: 0, total: 0 };
  const score = Math.round(checks.reduce((s, c) => s + c.score, 0) / checks.length);
  const metCount = checks.filter(c => c.met).length;
  return { score, metCount, total: checks.length };
}

// ── Flags ─────────────────────────────────────────────────────────────────

function computeFlags(snap, fscoreResult, scores) {
  const greenFlags = [];
  const redFlags = [];

  // Green flags
  if (snap.netProfitYoY != null && snap.netProfitYoY > 200) greenFlags.push(`🚀 Explosive profit growth +${snap.netProfitYoY.toFixed(0)}% YoY`);
  else if (snap.netProfitYoY != null && snap.netProfitYoY > 30) greenFlags.push(`Net profit growth YoY +${snap.netProfitYoY.toFixed(0)}%`);
  if (snap.netProfitQoQ != null && snap.netProfitQoQ > 100) greenFlags.push(`🚀 Profit surge +${snap.netProfitQoQ.toFixed(0)}% QoQ`);
  else if (snap.netProfitQoQ != null && snap.netProfitQoQ > 30) greenFlags.push(`Profit acceleration +${snap.netProfitQoQ.toFixed(0)}% QoQ`);
  if (snap.netProfitYoY != null && snap.netProfitYoY > 100 && snap.pe != null && snap.pe < 40)
    greenFlags.push('💎 Hidden gem: explosive growth + reasonable P/E');
  // CANSLIM earnings + sales acceleration (latest quarter vs year-ago quarter)
  if (snap.canslimAccel) greenFlags.push('⚡ CANSLIM: EPS + sales accelerating vs year-ago quarter');
  // Terry Smith quality: elite capital efficiency
  if (snap.roce != null && snap.roce >= 20) greenFlags.push(`💠 High ROCE ${snap.roce.toFixed(0)}% (capital efficient)`);
  if (snap.roce5yAvg != null && snap.roce5yAvg >= 18) greenFlags.push(`Consistent ROCE 5y avg ${snap.roce5yAvg.toFixed(0)}%`);
  // Lynch GARP: growth at reasonable price
  if (snap.peg != null && snap.peg > 0 && snap.peg < 1) greenFlags.push(`GARP: PEG ${snap.peg.toFixed(2)} (< 1)`);
  // Long-horizon compounding
  if (snap.epsCAGR5y != null && snap.epsCAGR5y > 20) greenFlags.push(`Sustained EPS CAGR 5y: ${snap.epsCAGR5y.toFixed(0)}%`);
  if (snap.marginTrend === 'up') greenFlags.push('Margin expansion');
  if (snap.consecutiveGrowthQuarters >= 3) greenFlags.push(`${snap.consecutiveGrowthQuarters} consecutive growth quarters`);
  if (fscoreResult && fscoreResult.score >= 7) greenFlags.push(`Piotroski F-Score ${fscoreResult.score}/9`);
  if (snap.debtToEquity != null && snap.debtToEquity < 20) greenFlags.push('Almost debt-free');
  if (snap.roe != null && snap.roe > 20) greenFlags.push(`High ROE ${snap.roe.toFixed(1)}%`);
  if (snap.revenueCAGR3y != null && snap.revenueCAGR3y > 20) greenFlags.push(`Revenue CAGR 3y: ${snap.revenueCAGR3y.toFixed(0)}%`);
  if (snap.estimateRevisionTrend === 'up') greenFlags.push('Analyst estimates revised up');
  if (snap.recentUpgrades > 0) greenFlags.push(`${snap.recentUpgrades} recent analyst upgrades`);
  if (snap.earningsSurprisePct != null && snap.earningsSurprisePct > 10) greenFlags.push('Strong earnings beat');
  if (snap.cfoToProfit != null && snap.cfoToProfit > 80) greenFlags.push('Strong cash backing');

  // Red flags
  if (snap.netProfitYoY != null && snap.netProfitYoY < -30) redFlags.push(`⛔ Severe profit decline ${snap.netProfitYoY.toFixed(0)}% YoY`);
  else if (snap.netProfitYoY != null && snap.netProfitYoY < -10) redFlags.push(`Net profit declining ${snap.netProfitYoY.toFixed(0)}% YoY`);
  else if (snap.netProfitYoY != null && snap.netProfitYoY >= 0 && snap.netProfitYoY < 10) redFlags.push(`Stagnant profit growth +${snap.netProfitYoY.toFixed(0)}% YoY`);
  if (snap.netProfitQoQ != null && snap.netProfitQoQ < -15) redFlags.push(`Profit declining ${snap.netProfitQoQ.toFixed(0)}% QoQ`);
  if (snap.marginTrend === 'down') redFlags.push('Margin compression');
  if (snap.debtToEquity != null && snap.debtToEquity > 150) redFlags.push(`High debt/equity ${snap.debtToEquity.toFixed(0)}`);
  if (fscoreResult && fscoreResult.score <= 3) redFlags.push(`Weak F-Score ${fscoreResult.score}/9`);
  if (snap.cfoToProfit != null && snap.cfoToProfit < 30) redFlags.push('Weak cash conversion');
  if (snap.dilutionPct != null && snap.dilutionPct > 5) redFlags.push(`Equity dilution +${snap.dilutionPct.toFixed(1)}%`);
  if (snap.receivableDays != null && snap.receivableDays > 150) redFlags.push(`High receivable days (${snap.receivableDays})`);
  if (snap.effectiveTaxRate != null && snap.effectiveTaxRate < 10) redFlags.push('Abnormally low tax rate');
  if (snap.pe != null && snap.pe > 80) redFlags.push(`Expensive P/E ${snap.pe.toFixed(0)}`);
  if (snap.dataCompleteness < 40) redFlags.push('Insufficient fundamental data');
  // Quality exit signals (Terry Smith style deterioration)
  if (snap.roce != null && snap.roce < 12) redFlags.push(`Low ROCE ${snap.roce.toFixed(0)}% (weak capital efficiency)`);
  if (snap.opm5yAvg != null && snap.operatingMargin != null && snap.operatingMargin < snap.opm5yAvg - 5)
    redFlags.push('Operating margin below 5y average');

  return { greenFlags, redFlags };
}

// ── Tier classification ───────────────────────────────────────────────────

function computeTier(score) {
  if (score >= 75) return 'strong';
  if (score >= 60) return 'good';
  if (score >= 45) return 'neutral';
  if (score >= 30) return 'weak';
  return 'avoid';
}

// ── Growth durability ─────────────────────────────────────────────────────

function assessGrowthDurability(snap) {
  // Sustainable = multiple consecutive quarters of growth, not one-off
  const qtrGrowth = snap.consecutiveGrowthQuarters || 0;
  const hasConsistentMargins = snap.marginTrend === 'up' || snap.marginTrend === 'flat';
  const hasMultiYearGrowth = (snap.revenueCAGR3y != null && snap.revenueCAGR3y > 10);

  if (qtrGrowth >= 3 && hasConsistentMargins && hasMultiYearGrowth) return 'sustainable';
  if (qtrGrowth >= 2 || hasMultiYearGrowth) return 'moderate';
  return 'one-off';
}

// ── Main scorer ───────────────────────────────────────────────────────────

/**
 * Score a FundamentalSnapshot across all 7 axes.
 * @param {object} snap — FundamentalSnapshot
 * @param {object} [sectorMedians] — { pe, pb, roe } sector medians for relative valuation
 * @param {object} [weights] — Axis weights override
 * @returns {object} Scored result
 */
export function scoreFundamentals(snap, sectorMedians = null, weights = DEFAULT_WEIGHTS) {
  // F-Score
  const fscoreResult = computeFScore(snap);

  // Axis subscores
  const axes = {
    growth: scoreGrowth(snap),
    profitability: scoreProfitability(snap),
    health: scoreHealth(snap, fscoreResult),
    valuation: scoreValuation(snap, sectorMedians),
    resultsMomentum: scoreResultsMomentum(snap),
    catalyst: scoreCatalyst(snap, sectorMedians),
    earningsQuality: scoreEarningsQuality(snap),
  };

  // Composite scores
  const qualityScore = Math.round(
    (axes.growth * 0.30 + axes.profitability * 0.25 + axes.health * 0.20 + axes.valuation * 0.25)
  );
  const momentumScore = Math.round(
    (axes.resultsMomentum * 0.50 + axes.catalyst * 0.50)
  );
  let multibaggerScore = Math.round(
    axes.growth * weights.growth +
    axes.profitability * weights.profitability +
    axes.health * weights.health +
    axes.valuation * weights.valuation +
    axes.resultsMomentum * weights.resultsMomentum +
    axes.catalyst * weights.catalyst +
    axes.earningsQuality * weights.earningsQuality
  );

  // Explosive-growth bonus: when profit growth is exceptional, lift the composite
  // because other "steady-state" metrics (profitability, health) haven't caught up yet.
  // This is the MOST important driver of stock re-rating from current price levels.
  if (snap.netProfitYoY != null && snap.netProfitYoY > 50 && axes.resultsMomentum >= 60) {
    let growthBonus;
    if (snap.netProfitYoY >= 500) growthBonus = 18;
    else if (snap.netProfitYoY >= 300) growthBonus = 15;
    else if (snap.netProfitYoY >= 150) growthBonus = 12;
    else if (snap.netProfitYoY >= 100) growthBonus = 8;
    else growthBonus = 5; // 50-100% YoY still gets a boost
    // Extra kicker if QoQ is also accelerating — confirms the trend isn't one-off
    if (snap.netProfitQoQ != null && snap.netProfitQoQ > 30) growthBonus += 3;
    multibaggerScore = Math.min(100, multibaggerScore + growthBonus);
  } else if (snap.netProfitQoQ != null && snap.netProfitQoQ > 80 && snap.consecutiveGrowthQuarters >= 2) {
    multibaggerScore = Math.min(100, multibaggerScore + 7);
  }

  // Net profit growth penalty: declining or stagnant profit growth is a dealbreaker
  if (snap.netProfitYoY != null) {
    if (snap.netProfitYoY < -30) {
      // Severe decline — heavy penalty, this is NOT a multibagger candidate
      multibaggerScore = Math.max(0, multibaggerScore - 15);
    } else if (snap.netProfitYoY < -10) {
      // Moderate decline — meaningful penalty
      multibaggerScore = Math.max(0, multibaggerScore - 10);
    } else if (snap.netProfitYoY < 0) {
      // Slight decline — minor penalty
      multibaggerScore = Math.max(0, multibaggerScore - 5);
    } else if (snap.netProfitYoY < 10) {
      // Stagnant growth (<10% YoY) — small penalty, not exciting enough
      multibaggerScore = Math.max(0, multibaggerScore - 3);
    }
  }
  // Double penalty: if QoQ is also declining, compound the damage
  if (snap.netProfitQoQ != null && snap.netProfitQoQ < -15) {
    const qoqPenalty = snap.netProfitQoQ < -40 ? 8 : 4;
    multibaggerScore = Math.max(0, multibaggerScore - qoqPenalty);
  }

  const tier = computeTier(multibaggerScore);
  const { greenFlags, redFlags } = computeFlags(snap, fscoreResult, axes);
  const growthDurability = assessGrowthDurability(snap);
  const quality = computeQualityComposite(snap);

  return {
    symbol: snap.symbol,
    name: snap.name,
    sector: snap.sector,
    industry: snap.industry,
    price: snap.price,
    marketCap: snap.marketCap,

    // Scores
    multibaggerScore,
    qualityScore,
    momentumScore,
    qualityComposite: quality.score,
    qualityCriteriaMet: quality.metCount,
    qualityCriteriaTotal: quality.total,
    tier,

    // Axis breakdown
    axes,

    // F-Score
    fScore: fscoreResult.score,
    fScoreBreakdown: fscoreResult.breakdown,

    // Flags
    greenFlags,
    redFlags,

    // Growth assessment
    growthDurability,

    // Key metrics surfaced for screening tables
    pe: snap.pe,
    peg: snap.peg,
    roce: snap.roce,
    roce5yAvg: snap.roce5yAvg,
    opm5yAvg: snap.opm5yAvg,
    revenueCAGR5y: snap.revenueCAGR5y,
    epsCAGR5y: snap.epsCAGR5y,
    netProfitYoY: snap.netProfitYoY,
    canslimAccel: snap.canslimAccel,

    // Data quality
    dataCompleteness: snap.dataCompleteness,
  };
}

/**
 * Compute sector medians from a batch of snapshots.
 * @param {object[]} snapshots — Array of FundamentalSnapshots
 * @returns {Map<string, {pe, pb, roe}>}
 */
export function computeSectorMedians(snapshots) {
  const sectors = new Map();

  for (const snap of snapshots) {
    const sector = snap.sector || 'Unknown';
    if (!sectors.has(sector)) sectors.set(sector, { pe: [], pb: [], roe: [] });
    const s = sectors.get(sector);
    if (snap.pe != null && snap.pe > 0 && snap.pe < 200) s.pe.push(snap.pe);
    if (snap.pb != null && snap.pb > 0 && snap.pb < 50) s.pb.push(snap.pb);
    if (snap.roe != null) s.roe.push(snap.roe);
  }

  const medians = new Map();
  for (const [sector, data] of sectors) {
    const median = arr => {
      if (arr.length === 0) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    medians.set(sector, {
      pe: median(data.pe),
      pb: median(data.pb),
      roe: median(data.roe),
    });
  }

  return medians;
}

export default { scoreFundamentals, computeSectorMedians, DEFAULT_WEIGHTS };
