/**
 * One-stop analysis payload + auto-generated narrative.
 *
 * Produces the full J&K-Bank-style writeup: financials tables, profitability,
 * valuation, health, ownership, drivers, risk block, and plain-English narrative.
 */

import { getFundamentals } from '../../data/fundamentals/index.js';
import { scoreFundamentals, computeSectorMedians } from './scorer.js';
import { computeFScore } from './fscore.js';
import { getOwnership } from '../../data/ownership/index.js';
import { getNews } from '../../data/news/index.js';
import { fetchFiiDiiFlows } from '../../data/ownership/fii-dii-flows.js';
import { auditDataGaps } from './data-gaps.js';

/**
 * Convert an ISO date (YYYY-MM-DD) to an Indian fiscal quarter label like "Q1FY27".
 * Indian FY runs Apr–Mar: Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar.
 * @param {string} dateStr — e.g. "2026-06-30"
 * @returns {string} e.g. "Q1FY27"
 */
function dateToQuarterLabel(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const month = d.getMonth() + 1; // 1-12
  const year = d.getFullYear();
  let q, fy;
  if (month >= 4 && month <= 6) { q = 1; fy = year + 1; }
  else if (month >= 7 && month <= 9) { q = 2; fy = year + 1; }
  else if (month >= 10 && month <= 12) { q = 3; fy = year + 1; }
  else { q = 4; fy = year; } // Jan-Mar
  return `Q${q}FY${String(fy).slice(-2)}`;
}

/**
 * Find the entry representing the same quarter one year earlier, matched by date.
 * Handles gaps in the series (missing quarters) that would break positional i-4
 * indexing. Requires the target to be within ~365±45 days of the current quarter.
 * @param {Array} series — quarterly results with `.date` (ISO string), sorted ascending
 * @param {number} i — index of the current quarter
 * @returns {object|null} the same-quarter-last-year entry, or null if none within tolerance
 */
function findYoYQuarter(series, i) {
  const cur = series[i];
  if (!cur?.date) return null;
  const curT = new Date(cur.date).getTime();
  const targetT = curT - 365 * 86400000; // one year earlier
  const tolerance = 45 * 86400000; // ±45 days
  let best = null;
  let bestDelta = Infinity;
  for (let j = 0; j < i; j++) {
    const e = series[j];
    if (!e?.date) continue;
    const delta = Math.abs(new Date(e.date).getTime() - targetT);
    if (delta < bestDelta) { bestDelta = delta; best = e; }
  }
  return bestDelta <= tolerance ? best : null;
}

/**
 * Generate full one-stop analysis for a symbol.
 * @param {string} symbol — Canonical "NSE:TICKER"
 * @param {object} [opts]
 * @param {Map} [opts.sectorMedians] — Pre-computed sector medians
 * @param {boolean} [opts.includeOwnership=true] — fetch shareholding/ownership
 * @param {boolean} [opts.includeNews=true] — fetch stock/sector news
 * @returns {Promise<object>} Full analysis payload
 */
export async function generateAnalysis(symbol, opts = {}) {
  let snap;
  try {
    snap = await getFundamentals(symbol, { forceRefresh: opts.forceRefresh });
  } catch (e) {
    // Return a minimal error payload instead of crashing
    return {
      success: false,
      symbol,
      error: `Failed to fetch fundamentals: ${e.message}`,
      header: { symbol, name: null, tier: 'unknown', multibaggerScore: 0 },
    };
  }
  if (!snap || (!snap.price && !snap.name)) {
    return {
      success: false,
      symbol,
      error: 'No fundamental data available for this symbol',
      header: { symbol, name: snap?.name || null, tier: 'unknown', multibaggerScore: 0 },
    };
  }

  const sectorMedians = opts.sectorMedians?.get(snap.sector) || null;
  const scored = scoreFundamentals(snap, sectorMedians);
  const fscoreResult = computeFScore(snap);

  // Ownership + news + market flows fetched in parallel (best-effort, non-fatal).
  const includeOwnership = opts.includeOwnership !== false;
  const includeNews = opts.includeNews !== false;
  const [ownershipData, newsData, fiiDiiFlows] = await Promise.all([
    includeOwnership ? getOwnership(symbol, { forceRefresh: opts.forceRefresh }).catch(() => null) : Promise.resolve(null),
    includeNews ? getNews(symbol, { name: snap.name, sector: snap.sector }).catch(() => null) : Promise.resolve(null),
    includeOwnership ? fetchFiiDiiFlows().catch(() => null) : Promise.resolve(null),
  ]);

  // ── Header ──────────────────────────────────────────────────────────────
  const header = {
    symbol: snap.symbol,
    name: snap.name,
    sector: snap.sector,
    industry: snap.industry,
    exchange: snap.exchange,
    price: snap.price,
    marketCap: snap.marketCap,
    marketCapCr: snap.marketCap ? Math.round(snap.marketCap / 1e7) / 10 : null, // in Cr
    fiftyTwoWeekHigh: snap.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: snap.fiftyTwoWeekLow,
    priceVs52wHigh: snap.priceVs52wHigh,
    tier: scored.tier,
    multibaggerScore: scored.multibaggerScore,
    qualityScore: scored.qualityScore,
    momentumScore: scored.momentumScore,
  };

  // ── Financials ──────────────────────────────────────────────────────────
  const quarterlyResults = (snap.quarterlySeries || []).map(q => ({
    ...q,
    quarterLabel: dateToQuarterLabel(q.date),
    opm: (q.revenue && q.operatingIncome) ? Math.round((q.operatingIncome / q.revenue) * 100) : null,
    npm: (q.revenue && q.netIncome) ? Math.round((q.netIncome / q.revenue) * 100) : null,
    ebitdaMargin: (q.revenue && q.ebitda) ? +((q.ebitda / q.revenue) * 100).toFixed(1) : null,
  }));

  // Quarter-by-quarter comparison (QoQ and YoY growth for each quarter)
  // Filter out quarters where Yahoo returned an empty placeholder (all key financials null)
  const validQuarterly = quarterlyResults.filter(q => q.revenue != null || q.netIncome != null || q.ebitda != null);
  const quarterlyComparison = validQuarterly.map((q, i) => {
    // QoQ: find the closest prior valid quarter (skip gaps)
    const prev = i > 0 ? validQuarterly[i - 1] : null;
    // YoY: match the same fiscal quarter one year earlier BY DATE (~365d), not by
    // positional index — the series can have gaps (missing quarters) that would
    // otherwise misalign i-4 onto the wrong quarter.
    const sameQLastYear = findYoYQuarter(validQuarterly, i);
    // Guard: don't compute growth when current value is null/undefined (data gap)
    const hasRev = q.revenue != null;
    const hasNI = q.netIncome != null;
    const hasEbitda = q.ebitda != null;
    const hasPBT = q.pretaxIncome != null;
    return {
      ...q,
      revenueQoQ: hasRev && prev?.revenue && prev.revenue !== 0 ? Math.round(((q.revenue - prev.revenue) / Math.abs(prev.revenue)) * 100) : null,
      revenueYoY: hasRev && sameQLastYear?.revenue && sameQLastYear.revenue !== 0 ? Math.round(((q.revenue - sameQLastYear.revenue) / Math.abs(sameQLastYear.revenue)) * 100) : null,
      netIncomeQoQ: hasNI && prev?.netIncome && prev.netIncome !== 0 ? Math.round(((q.netIncome - prev.netIncome) / Math.abs(prev.netIncome)) * 100) : null,
      netIncomeYoY: hasNI && sameQLastYear?.netIncome && sameQLastYear.netIncome !== 0 ? Math.round(((q.netIncome - sameQLastYear.netIncome) / Math.abs(sameQLastYear.netIncome)) * 100) : null,
      ebitdaQoQ: hasEbitda && prev?.ebitda && prev.ebitda !== 0 ? Math.round(((q.ebitda - prev.ebitda) / Math.abs(prev.ebitda)) * 100) : null,
      ebitdaYoY: hasEbitda && sameQLastYear?.ebitda && sameQLastYear.ebitda !== 0 ? Math.round(((q.ebitda - sameQLastYear.ebitda) / Math.abs(sameQLastYear.ebitda)) * 100) : null,
      pbtQoQ: hasPBT && prev?.pretaxIncome && prev.pretaxIncome !== 0 ? Math.round(((q.pretaxIncome - prev.pretaxIncome) / Math.abs(prev.pretaxIncome)) * 100) : null,
      pbtYoY: hasPBT && sameQLastYear?.pretaxIncome && sameQLastYear.pretaxIncome !== 0 ? Math.round(((q.pretaxIncome - sameQLastYear.pretaxIncome) / Math.abs(sameQLastYear.pretaxIncome)) * 100) : null,
      opmChange: prev && q.opm != null && prev.opm != null ? q.opm - prev.opm : null,
      npmChange: prev && q.npm != null && prev.npm != null ? q.npm - prev.npm : null,
      ebitdaMarginChange: prev && q.ebitdaMargin != null && prev.ebitdaMargin != null ? +(q.ebitdaMargin - prev.ebitdaMargin).toFixed(1) : null,
    };
  });

  // Year-by-year comparison
  const annualPnl = (snap.annualSeries || []).map(a => ({
    ...a,
    opm: (a.revenue && a.operatingIncome) ? Math.round((a.operatingIncome / a.revenue) * 100) : null,
    npm: (a.revenue && a.netIncome) ? Math.round((a.netIncome / a.revenue) * 100) : null,
    ebitdaMargin: (a.revenue && a.ebitda) ? +((a.ebitda / a.revenue) * 100).toFixed(1) : null,
  }));

  const annualComparison = annualPnl.map((a, i) => {
    const prev = annualPnl[i - 1];
    const hasRev = a.revenue != null;
    const hasNI = a.netIncome != null;
    const hasEbitda = a.ebitda != null;
    return {
      ...a,
      revenueGrowth: hasRev && prev?.revenue ? Math.round(((a.revenue - prev.revenue) / Math.abs(prev.revenue)) * 100) : null,
      netIncomeGrowth: hasNI && prev?.netIncome ? Math.round(((a.netIncome - prev.netIncome) / Math.abs(prev.netIncome)) * 100) : null,
      ebitdaGrowth: hasEbitda && prev?.ebitda ? Math.round(((a.ebitda - prev.ebitda) / Math.abs(prev.ebitda)) * 100) : null,
      opmChange: prev && a.opm != null && prev.opm != null ? a.opm - prev.opm : null,
      npmChange: prev && a.npm != null && prev.npm != null ? a.npm - prev.npm : null,
      ebitdaMarginChange: prev && a.ebitdaMargin != null && prev.ebitdaMargin != null ? +(a.ebitdaMargin - prev.ebitdaMargin).toFixed(1) : null,
      grossProfitGrowth: prev?.grossProfit && a.grossProfit ? Math.round(((a.grossProfit - prev.grossProfit) / Math.abs(prev.grossProfit)) * 100) : null,
    };
  });

  const financials = {
    quarterlyResults,
    quarterlyComparison,
    annualPnl,
    annualComparison,
    growth: {
      revenueCAGR3y: snap.revenueCAGR3y,
      epsCAGR3y: snap.epsCAGR3y,
      revenueGrowthTTM: snap.revenueGrowth,
      earningsGrowthTTM: snap.earningsGrowth,
      revenueYoY: snap.revenueYoY,
      revenueQoQ: snap.revenueQoQ,
      netProfitYoY: snap.netProfitYoY,
      netProfitQoQ: snap.netProfitQoQ,
    },
    ebitda: snap.ebitda,
    ebitdaMargin: snap.ebitdaMargin,
    freeCashflow: snap.freeCashflow,
    dividendYield: snap.dividendYield,
    dividendRate: snap.dividendRate,
  };

  // ── Profitability ───────────────────────────────────────────────────────
  const profitability = {
    roe: snap.roe,
    roa: snap.roa,
    roce: snap.roce,
    roce5yAvg: snap.roce5yAvg,
    grossMargin: snap.grossMargin,
    operatingMargin: snap.operatingMargin,
    opm5yAvg: snap.opm5yAvg,
    netMargin: snap.netMargin,
    marginTrend: snap.marginTrend,
  };

  // ── Valuation ───────────────────────────────────────────────────────────
  const valuation = {
    pe: snap.pe,
    forwardPe: snap.forwardPe,
    pb: snap.pb,
    peg: snap.peg,
    evToEbitda: snap.evToEbitda,
    bookValue: snap.bookValue,
    sectorMedianPe: sectorMedians?.pe || null,
    sectorMedianPb: sectorMedians?.pb || null,
    peVsSector: (snap.pe && sectorMedians?.pe) ? Math.round((snap.pe / sectorMedians.pe) * 100) / 100 : null,
  };

  // ── Financial Health ────────────────────────────────────────────────────
  const health = {
    debtToEquity: snap.debtToEquity,
    currentRatio: snap.currentRatio,
    interestCoverage: snap.interestCoverage,
    fScore: fscoreResult.score,
    fScoreBreakdown: fscoreResult.breakdown,
    isDebtFree: snap.debtToEquity != null && snap.debtToEquity < 10,
    balanceSheet: snap.balanceSheetSeries,
    cashFlows: snap.cashFlowSeries,
  };

  // ── Earnings Quality ────────────────────────────────────────────────────
  const earningsQuality = {
    cfoToProfit: snap.cfoToProfit,
    effectiveTaxRate: snap.effectiveTaxRate,
    receivableDays: snap.receivableDays,
    inventoryDays: snap.inventoryDays,
    dilutionPct: snap.dilutionPct,
    sharesOutstanding: snap.sharesOutstanding,
    earningsSurprises: snap.earningsSurprises,
    consecutiveGrowthQuarters: snap.consecutiveGrowthQuarters,
    growthDurability: scored.growthDurability,
  };

  // ── Ownership ───────────────────────────────────────────────────────────
  // Yahoo provides insiders % (≈ promoter) and institutions % as fallback
  const yOwn = snap.yahooOwnership || {};
  let ownership = ownershipData
    ? { ...ownershipData, available: ownershipData.promoterHolding != null || ownershipData.fiiHolding != null, fiiDiiFlows }
    : { available: false, promoterHolding: null, promoterTrend: null, fiiHolding: null, diiHolding: null,
        mutualFundHolding: null, hniHolding: null, retailHolding: null, institutionalTrend: null,
        smartMoneyScore: null, institutionalAccumScore: null, promoterConfidenceScore: null,
        superstars: [], history: [], mutualFundHoldings: null, fiiDiiFlows };

  // Fallback: enrich from Yahoo majorHoldersBreakdown when NSE unavailable
  if (!ownership.available && (yOwn.insidersPercentHeld != null || yOwn.institutionsPercentHeld != null)) {
    ownership = {
      ...ownership,
      available: true,
      promoterHolding: yOwn.insidersPercentHeld,
      fiiHolding: yOwn.institutionsPercentHeld, // Yahoo lumps all institutions
      institutionsCount: yOwn.institutionsCount,
      source: 'yahoo',
      fiiDiiFlows,
    };
  }

  // ── News ────────────────────────────────────────────────────────────────
  const news = newsData || { stock: [], sector: [] };

  // ── Data-gap audit ──────────────────────────────────────────────────────
  const dataGaps = auditDataGaps(snap, ownership, news);


  // ── Estimates & Analyst ─────────────────────────────────────────────────
  const analystView = {
    estimateRevisionTrend: snap.estimateRevisionTrend,
    estimates: snap.estimates,
    recommendations: snap.recommendations,
    recentUpgrades: snap.recentUpgrades,
  };

  // ── Risk / Margin-of-safety ─────────────────────────────────────────────
  const risk = computeRiskBlock(snap, scored, fscoreResult);

  // ── Drivers (axis subscores) ────────────────────────────────────────────
  const drivers = {
    axes: scored.axes,
    greenFlags: scored.greenFlags,
    redFlags: scored.redFlags,
  };

  // ── Narrative ───────────────────────────────────────────────────────────
  const narrative = generateNarrative(snap, scored, fscoreResult, sectorMedians);

  // ── Manual due-diligence checklist + exit signals ───────────────────────
  const dueDiligence = buildDueDiligence(snap, scored, ownership);
  const exitSignals = buildExitSignals(snap);

  return {
    header,
    financials,
    profitability,
    valuation,
    health,
    earningsQuality,
    ownership,
    analystView,
    risk,
    drivers,
    dueDiligence,
    exitSignals,
    news,
    dataGaps,
    narrative,
    dataCompleteness: snap.dataCompleteness,
    fetchedAt: snap.fetchedAt,
  };
}

// ── Industry tailwind heuristics (manual-check prompt) ──────────────────────
const TAILWIND_KEYWORDS = [
  'defence', 'defense', 'aerospace', 'electronic', 'semiconductor', 'ems',
  'renewable', 'solar', 'ev', 'battery', 'railway', 'capital goods',
  'chemical', 'speciality', 'specialty', 'pharma', 'healthcare', 'hospital',
  'data', 'software', 'ai', 'digital', 'infrastructure', 'power',
];

/**
 * Build a manual due-diligence checklist. Uses ownership data when available;
 * marks items as verified/flagged/manual based on actual data.
 */
function buildDueDiligence(snap, scored, ownership) {
  const industry = (snap.industry || snap.sector || '').toLowerCase();
  const industryTailwind = TAILWIND_KEYWORDS.some(k => industry.includes(k));
  const o = ownership || {};

  // Promoter holding check
  const hasPromoter = o.promoterHolding != null;
  const promoterItem = hasPromoter
    ? { item: `Promoter holding: ${o.promoterHolding.toFixed(1)}%${o.promoterHolding >= 50 ? ' ✓' : ' ⚠ below 50%'}`,
        status: o.promoterHolding >= 50 ? 'pass' : 'warn',
        note: o.changes?.promoterChange != null
          ? `QoQ change: ${o.changes.promoterChange > 0 ? '+' : ''}${o.changes.promoterChange.toFixed(2)}pp (${o.promoterTrend || 'stable'})`
          : `Source: ${o.source || 'yahoo'} — no QoQ trend available` }
    : { item: 'Promoter holding > 50% and stable/rising', status: 'manual', note: 'Not available — check Screener.in / exchange filings' };

  // Pledge check
  const hasPledge = o.pledgedPct != null;
  const pledgeItem = hasPledge
    ? { item: `Promoter pledge: ${o.pledgedPct.toFixed(1)}%${o.pledgedPct === 0 ? ' ✓ Zero pledge' : o.pledgedPct > 10 ? ' ⚠ Elevated' : ''}`,
        status: o.pledgedPct === 0 ? 'pass' : o.pledgedPct > 10 ? 'warn' : 'ok',
        note: o.pledgedPct === 0 ? 'Clean — no pledging risk' : `Pledge ${o.pledgedPct.toFixed(1)}% — monitor for margin call risk` }
    : { item: 'Promoter pledged shares = 0', status: 'manual', note: 'Pledge data not available from current source' };

  // FII/DII accumulation
  const hasFii = o.fiiHolding != null;
  const fiiItem = hasFii
    ? { item: `FII/Institutional holding: ${o.fiiHolding.toFixed(1)}%${o.changes?.fiiChange != null ? ` (QoQ ${o.changes.fiiChange > 0 ? '+' : ''}${o.changes.fiiChange.toFixed(2)}pp)` : ''}`,
        status: o.institutionalTrend === 'accumulating' ? 'pass' : o.institutionalTrend === 'distributing' ? 'warn' : 'ok',
        note: o.institutionalTrend ? `Trend: ${o.institutionalTrend}${o.smartMoneyScore != null ? ` — Smart Money Score: ${o.smartMoneyScore}` : ''}` : `Source: ${o.source || 'nse'}` }
    : { item: 'FII/DII accumulation trend', status: 'manual', note: 'Check quarterly shareholding pattern' };

  return {
    industryTailwind,
    industryTailwindNote: industryTailwind
      ? `${snap.industry || snap.sector} may have a structural tailwind — verify order book / capex cycle.`
      : 'No obvious sector tailwind detected — confirm demand drivers manually.',
    checklist: [
      promoterItem,
      pledgeItem,
      { item: 'Durable competitive moat / pricing power', status: 'manual', note: `ROCE ${snap.roce != null ? snap.roce.toFixed(0) + '%' : 'n/a'} is a proxy — verify qualitatively` },
      { item: 'Clean corporate governance / no related-party red flags', status: 'manual', note: 'Review auditor notes and RPT disclosures' },
      fiiItem,
      { item: 'Management guidance vs delivery track record', status: 'manual', note: 'Read recent concall transcripts' },
    ],
    qualityComposite: scored.qualityComposite ?? null,
    qualityCriteriaMet: scored.qualityCriteriaMet ?? null,
    qualityCriteriaTotal: scored.qualityCriteriaTotal ?? null,
  };
}

/**
 * Build a list of exit/deterioration signals (sell-discipline prompts).
 */
function buildExitSignals(snap) {
  const signals = [];
  if (snap.roce != null && snap.roce < 18) signals.push(`ROCE ${snap.roce.toFixed(0)}% below 18% quality threshold`);
  if (snap.roce5yAvg != null && snap.roce != null && snap.roce < snap.roce5yAvg - 5)
    signals.push('ROCE deteriorating vs 5y average');
  if (snap.revenueGrowth != null && snap.revenueGrowth < 10) signals.push(`Revenue growth ${snap.revenueGrowth.toFixed(0)}% slowing below 10%`);
  if (snap.debtToEquity != null && snap.debtToEquity > 60) signals.push(`Debt/equity rising to ${(snap.debtToEquity / 100).toFixed(2)}x`);
  if (snap.cfoToProfit != null && snap.cfoToProfit < 60) signals.push('Cash conversion weakening (CFO < 60% of profit)');
  if (snap.marginTrend === 'down') signals.push('Operating margin compressing');
  if (snap.opm5yAvg != null && snap.operatingMargin != null && snap.operatingMargin < snap.opm5yAvg - 5)
    signals.push('Operating margin below 5y average');
  if (snap.dilutionPct != null && snap.dilutionPct > 10) signals.push(`Heavy equity dilution +${snap.dilutionPct.toFixed(0)}%`);
  return { count: signals.length, signals };
}

/**
 * Compute the risk / margin-of-safety block.
 * Comprehensive assessment across valuation, leverage, profitability,
 * growth sustainability, governance, liquidity, and macro sensitivity.
 */
function computeRiskBlock(snap, scored, fscoreResult) {
  const risks = [];
  const mitigants = [];

  // ── Valuation risk ──────────────────────────────────────────────────────
  if (snap.pe != null && snap.pe > 80) {
    risks.push({ type: 'valuation', severity: 'high', detail: `P/E ${snap.pe.toFixed(0)} — extremely expensive, high derating risk on any earnings miss` });
  } else if (snap.pe != null && snap.pe > 60) {
    risks.push({ type: 'valuation', severity: 'high', detail: `P/E ${snap.pe.toFixed(0)} — expensive, derating risk on any miss` });
  } else if (snap.pe != null && snap.pe > 35) {
    risks.push({ type: 'valuation', severity: 'medium', detail: `P/E ${snap.pe.toFixed(0)} — moderate premium, limited margin of safety` });
  }
  if (snap.pb != null && snap.pb > 10) {
    risks.push({ type: 'valuation', severity: 'medium', detail: `P/B ${snap.pb.toFixed(1)} — trading at steep premium to book value` });
  }
  if (snap.evToEbitda != null && snap.evToEbitda > 40) {
    risks.push({ type: 'valuation', severity: 'medium', detail: `EV/EBITDA ${snap.evToEbitda.toFixed(1)} — elevated enterprise valuation` });
  }

  // ── Leverage / Debt risk ────────────────────────────────────────────────
  if (snap.debtToEquity != null && snap.debtToEquity > 150) {
    risks.push({ type: 'leverage', severity: 'high', detail: `Debt/Equity ${snap.debtToEquity.toFixed(0)} — highly leveraged, vulnerable to rate hikes and margin compression` });
  } else if (snap.debtToEquity != null && snap.debtToEquity > 100) {
    risks.push({ type: 'leverage', severity: 'high', detail: `Debt/Equity ${snap.debtToEquity.toFixed(0)} — rate-sensitive, stress risk in downturns` });
  } else if (snap.debtToEquity != null && snap.debtToEquity > 50) {
    risks.push({ type: 'leverage', severity: 'medium', detail: `Debt/Equity ${snap.debtToEquity.toFixed(0)} — moderate leverage, watch interest coverage` });
  }
  if (snap.interestCoverage != null && snap.interestCoverage < 2) {
    risks.push({ type: 'leverage', severity: 'high', detail: `Interest coverage ${snap.interestCoverage.toFixed(1)}x — earnings barely cover interest, debt service risk` });
  } else if (snap.interestCoverage != null && snap.interestCoverage < 4) {
    risks.push({ type: 'leverage', severity: 'medium', detail: `Interest coverage ${snap.interestCoverage.toFixed(1)}x — tight debt servicing buffer` });
  }
  if (snap.currentRatio != null && snap.currentRatio < 1) {
    risks.push({ type: 'liquidity_ratio', severity: 'high', detail: `Current ratio ${snap.currentRatio.toFixed(2)} — short-term liabilities exceed current assets` });
  } else if (snap.currentRatio != null && snap.currentRatio < 1.3) {
    risks.push({ type: 'liquidity_ratio', severity: 'medium', detail: `Current ratio ${snap.currentRatio.toFixed(2)} — thin liquidity buffer` });
  }

  // ── Earnings quality risk ───────────────────────────────────────────────
  if (snap.cfoToProfit != null && snap.cfoToProfit < 15) {
    risks.push({ type: 'earnings_quality', severity: 'high', detail: `CFO/Profit ${snap.cfoToProfit.toFixed(0)}% — profits not backed by cash, potential accrual manipulation` });
  } else if (snap.cfoToProfit != null && snap.cfoToProfit < 30) {
    risks.push({ type: 'earnings_quality', severity: 'high', detail: `CFO/Profit ${snap.cfoToProfit.toFixed(0)}% — weak cash conversion, earnings quality concern` });
  } else if (snap.cfoToProfit != null && snap.cfoToProfit < 60) {
    risks.push({ type: 'earnings_quality', severity: 'medium', detail: `CFO/Profit ${snap.cfoToProfit.toFixed(0)}% — below-average cash backing of profits` });
  }
  if (snap.effectiveTaxRate != null && snap.effectiveTaxRate < 10) {
    risks.push({ type: 'earnings_quality', severity: 'medium', detail: `Effective tax rate ${snap.effectiveTaxRate.toFixed(0)}% — abnormally low, possible one-off benefit inflating profits` });
  }
  if (snap.receivableDays != null && snap.receivableDays > 120) {
    risks.push({ type: 'earnings_quality', severity: 'medium', detail: `Receivable days ${snap.receivableDays} — slow collection, revenue recognition risk` });
  }
  if (snap.inventoryDays != null && snap.inventoryDays > 150) {
    risks.push({ type: 'earnings_quality', severity: 'medium', detail: `Inventory days ${snap.inventoryDays} — high inventory buildup, potential write-down risk` });
  }

  // ── Dilution risk ───────────────────────────────────────────────────────
  if (snap.dilutionPct != null && snap.dilutionPct > 15) {
    risks.push({ type: 'dilution', severity: 'high', detail: `Shares grew +${snap.dilutionPct.toFixed(1)}% — heavy dilution, per-share value erosion` });
  } else if (snap.dilutionPct != null && snap.dilutionPct > 5) {
    risks.push({ type: 'dilution', severity: 'medium', detail: `Shares grew +${snap.dilutionPct.toFixed(1)}% — moderate equity dilution` });
  }

  // ── Growth sustainability risk ──────────────────────────────────────────
  if (snap.netProfitYoY != null && snap.netProfitYoY < -20) {
    risks.push({ type: 'growth', severity: 'high', detail: `Net profit declining ${snap.netProfitYoY.toFixed(0)}% YoY — growth thesis under pressure` });
  } else if (snap.netProfitYoY != null && snap.netProfitYoY < 0) {
    risks.push({ type: 'growth', severity: 'medium', detail: `Net profit slipping ${snap.netProfitYoY.toFixed(0)}% YoY — growth deceleration` });
  }
  if (snap.netProfitQoQ != null && snap.netProfitQoQ < -30) {
    risks.push({ type: 'growth', severity: 'high', detail: `Net profit fell ${snap.netProfitQoQ.toFixed(0)}% QoQ — sharp sequential deterioration` });
  }
  if (snap.revenueYoY != null && snap.revenueYoY < -10) {
    risks.push({ type: 'growth', severity: 'medium', detail: `Revenue declining ${snap.revenueYoY.toFixed(0)}% YoY — top-line contraction` });
  }
  if (snap.marginTrend === 'down') {
    risks.push({ type: 'profitability', severity: 'medium', detail: 'Margin trend declining — operating leverage weakening or cost pressures rising' });
  }
  if (snap.operatingMargin != null && snap.opm5yAvg != null && snap.operatingMargin < snap.opm5yAvg - 5) {
    risks.push({ type: 'profitability', severity: 'medium', detail: `OPM ${snap.operatingMargin.toFixed(0)}% vs 5y avg ${snap.opm5yAvg.toFixed(0)}% — margins below historical norm` });
  }
  if (snap.consecutiveGrowthQuarters != null && snap.consecutiveGrowthQuarters === 0) {
    risks.push({ type: 'growth', severity: 'medium', detail: 'No consecutive growth quarters — growth not yet established as a trend' });
  }
  if (snap.netProfitYoY != null && snap.netProfitYoY > 300 && snap.consecutiveGrowthQuarters != null && snap.consecutiveGrowthQuarters < 2) {
    risks.push({ type: 'growth', severity: 'medium', detail: `Explosive ${snap.netProfitYoY.toFixed(0)}% YoY profit growth but only ${snap.consecutiveGrowthQuarters} quarter(s) of track record — may be one-off` });
  }

  // ── Governance & promoter risk ──────────────────────────────────────────
  if (snap.pledgedPct != null && snap.pledgedPct > 30) {
    risks.push({ type: 'governance', severity: 'high', detail: `Promoter pledge ${snap.pledgedPct.toFixed(1)}% — margin call risk, potential forced selling` });
  } else if (snap.pledgedPct != null && snap.pledgedPct > 10) {
    risks.push({ type: 'governance', severity: 'medium', detail: `Promoter pledge ${snap.pledgedPct.toFixed(1)}% — moderate pledging raises governance concern` });
  }

  // ── Capital efficiency risk ─────────────────────────────────────────────
  if (snap.roce != null && snap.roce < 8) {
    risks.push({ type: 'profitability', severity: 'high', detail: `ROCE ${snap.roce.toFixed(0)}% — poor capital efficiency, value-destructive if below cost of capital` });
  } else if (snap.roce != null && snap.roce < 12) {
    risks.push({ type: 'profitability', severity: 'medium', detail: `ROCE ${snap.roce.toFixed(0)}% — below-average capital efficiency` });
  }
  if (snap.roe != null && snap.roe < 5) {
    risks.push({ type: 'profitability', severity: 'medium', detail: `ROE ${snap.roe.toFixed(1)}% — weak return on equity` });
  }

  // ── Market / liquidity risk ─────────────────────────────────────────────
  if (snap.marketCap && snap.marketCap < 1e9) {
    risks.push({ type: 'liquidity', severity: 'high', detail: 'Nano-cap (< ₹100 Cr) — extreme liquidity risk, wide bid-ask spreads, potential exit difficulty' });
  } else if (snap.marketCap && snap.marketCap < 2e9) {
    risks.push({ type: 'liquidity', severity: 'medium', detail: 'Micro-cap (< ₹200 Cr) — limited liquidity, impact cost on larger positions' });
  } else if (snap.marketCap && snap.marketCap < 5e9) {
    risks.push({ type: 'liquidity', severity: 'low', detail: 'Small-cap — moderate liquidity, monitor trading volumes' });
  }
  if (snap.priceVs52wHigh != null && snap.priceVs52wHigh < 50) {
    risks.push({ type: 'momentum', severity: 'medium', detail: `Trading at ${snap.priceVs52wHigh.toFixed(0)}% of 52-week high — significant drawdown, trend may be broken` });
  }

  // ── Piotroski F-Score risk ──────────────────────────────────────────────
  if (fscoreResult.score <= 2) {
    risks.push({ type: 'fundamental', severity: 'high', detail: `Piotroski F-Score ${fscoreResult.score}/9 — very weak fundamentals across profitability, leverage, and efficiency` });
  } else if (fscoreResult.score <= 4) {
    risks.push({ type: 'fundamental', severity: 'medium', detail: `Piotroski F-Score ${fscoreResult.score}/9 — below-average fundamental health` });
  }

  // ── Data quality risk ───────────────────────────────────────────────────
  if (snap.dataCompleteness < 30) {
    risks.push({ type: 'data', severity: 'high', detail: `Data completeness only ${snap.dataCompleteness}% — scoring may be unreliable` });
  } else if (snap.dataCompleteness < 50) {
    risks.push({ type: 'data', severity: 'medium', detail: `Data completeness ${snap.dataCompleteness}% — limited visibility, verify key metrics manually` });
  }

  // ── Concentration risk ──────────────────────────────────────────────────
  if (snap.netMargin != null && snap.netMargin > 50) {
    risks.push({ type: 'concentration', severity: 'low', detail: `Net margin ${snap.netMargin.toFixed(0)}% — unusually high, may not be sustainable or indicates low-revenue base` });
  }

  // ── Mitigants ───────────────────────────────────────────────────────────
  if (snap.debtToEquity != null && snap.debtToEquity < 10) mitigants.push('Debt-free balance sheet');
  else if (snap.debtToEquity != null && snap.debtToEquity < 20) mitigants.push('Nearly debt-free');
  if (fscoreResult.score >= 8) mitigants.push(`Excellent F-Score (${fscoreResult.score}/9)`);
  else if (fscoreResult.score >= 7) mitigants.push(`Strong F-Score (${fscoreResult.score}/9)`);
  if (snap.cfoToProfit != null && snap.cfoToProfit > 120) mitigants.push('Excellent cash conversion (CFO > 120% of profit)');
  else if (snap.cfoToProfit != null && snap.cfoToProfit > 80) mitigants.push('Good cash backing of profits');
  if (snap.consecutiveGrowthQuarters >= 4) mitigants.push(`${snap.consecutiveGrowthQuarters} consecutive growth quarters — durable trend`);
  else if (snap.consecutiveGrowthQuarters >= 3) mitigants.push(`${snap.consecutiveGrowthQuarters} consecutive growth quarters`);
  if (snap.currentRatio != null && snap.currentRatio > 2) mitigants.push('Strong short-term liquidity (CR > 2)');
  if (snap.interestCoverage != null && snap.interestCoverage > 10) mitigants.push('Very comfortable debt servicing (IC > 10x)');
  if (snap.roce != null && snap.roce > 25) mitigants.push(`High ROCE ${snap.roce.toFixed(0)}% — strong capital efficiency`);
  if (snap.roe != null && snap.roe > 20) mitigants.push(`High ROE ${snap.roe.toFixed(1)}%`);
  if (snap.marginTrend === 'up') mitigants.push('Margin expanding — improving operating leverage');
  if (snap.netProfitYoY != null && snap.netProfitYoY > 50) mitigants.push(`Strong profit growth +${snap.netProfitYoY.toFixed(0)}% YoY`);
  if (snap.priceVs52wHigh != null && snap.priceVs52wHigh > 85) mitigants.push('Price near 52-week high — strong momentum');
  if (snap.peg != null && snap.peg > 0 && snap.peg < 1) mitigants.push(`PEG ${snap.peg.toFixed(2)} — growth at reasonable price`);
  if (snap.pledgedPct != null && snap.pledgedPct === 0) mitigants.push('Zero promoter pledging');
  if (snap.estimateRevisionTrend === 'up') mitigants.push('Analyst estimates being revised upward');

  // ── Overall risk scoring ────────────────────────────────────────────────
  const highCount = risks.filter(r => r.severity === 'high').length;
  const medCount = risks.filter(r => r.severity === 'medium').length;
  const overallRisk = highCount >= 3 ? 'high'
    : highCount >= 2 ? 'high'
    : highCount >= 1 && medCount >= 2 ? 'high'
    : highCount >= 1 ? 'medium'
    : medCount >= 3 ? 'medium'
    : risks.length > 0 ? 'low' : 'minimal';

  // ── Risk summary ───────────────────────────────────────────────────────
  const riskCategories = {};
  for (const r of risks) {
    if (!riskCategories[r.type]) riskCategories[r.type] = [];
    riskCategories[r.type].push(r);
  }

  return { overallRisk, risks, mitigants, riskCategories, highCount, medCount, totalRisks: risks.length };
}

/**
 * Generate plain-English narrative for why this stock could re-rate.
 */
export function generateNarrative(snap, scored, fscoreResult, sectorMedians) {
  const parts = [];

  // Opening — what the company is
  if (snap.name && snap.sector) {
    parts.push(`${snap.name} (${snap.symbol}) is a ${snap.sector} company`);
    if (snap.marketCap) {
      const mcapCr = Math.round(snap.marketCap / 1e7) / 10;
      parts[0] += ` with a market cap of ₹${mcapCr.toLocaleString()} Cr.`;
    } else {
      parts[0] += '.';
    }
  }

  // Earnings momentum
  const momParts = [];
  if (snap.netProfitQoQ != null && snap.netProfitQoQ > 30) {
    momParts.push(`net profit surged ${snap.netProfitQoQ > 0 ? '+' : ''}${snap.netProfitQoQ.toFixed(0)}% QoQ`);
  }
  if (snap.netProfitYoY != null && snap.netProfitYoY > 20) {
    momParts.push(`${snap.netProfitYoY > 0 ? '+' : ''}${snap.netProfitYoY.toFixed(0)}% YoY`);
  }
  if (snap.revenueYoY != null && snap.revenueYoY > 15) {
    momParts.push(`revenue grew ${snap.revenueYoY.toFixed(0)}% YoY`);
  }
  if (momParts.length > 0) {
    parts.push(`Earnings momentum: ${momParts.join('; ')}.`);
  }

  // Margin story
  if (snap.marginTrend === 'up') {
    parts.push(`Operating margins are expanding — a sign of improving unit economics or operating leverage.`);
  } else if (snap.marginTrend === 'down') {
    parts.push(`⚠️ Margins are compressing — needs monitoring.`);
  }

  // Growth durability
  if (scored.growthDurability === 'sustainable') {
    parts.push(`Growth appears durable with ${snap.consecutiveGrowthQuarters} consecutive quarters of improvement${snap.revenueCAGR3y ? ` and ${snap.revenueCAGR3y.toFixed(0)}% 3-year revenue CAGR` : ''}.`);
  } else if (scored.growthDurability === 'one-off') {
    parts.push(`⚠️ Recent performance may be a one-off spike — track next quarter for confirmation.`);
  }

  // Valuation context
  if (snap.pe != null) {
    if (sectorMedians?.pe && snap.pe < sectorMedians.pe * 0.7) {
      parts.push(`Trades at P/E ${snap.pe.toFixed(0)} vs sector median ${sectorMedians.pe.toFixed(0)} — potential re-rating candidate on sustained delivery.`);
    } else if (snap.pe > 60) {
      parts.push(`P/E of ${snap.pe.toFixed(0)} prices in significant growth — any execution miss could trigger derating.`);
    }
  }

  // F-Score
  if (fscoreResult.score >= 7) {
    parts.push(`Piotroski F-Score ${fscoreResult.score}/9 signals strong financial health.`);
  } else if (fscoreResult.score <= 3) {
    parts.push(`⚠️ Weak F-Score (${fscoreResult.score}/9) — balance sheet concerns.`);
  }

  // Health
  if (snap.debtToEquity != null && snap.debtToEquity < 20) {
    parts.push('Nearly debt-free balance sheet provides strategic flexibility.');
  } else if (snap.debtToEquity != null && snap.debtToEquity > 100) {
    parts.push(`⚠️ Elevated debt/equity (${snap.debtToEquity.toFixed(0)}) — sensitive to rate movements.`);
  }

  // Earnings quality
  if (snap.cfoToProfit != null && snap.cfoToProfit > 80) {
    parts.push('Cash flow well-backs reported profits (high earnings quality).');
  } else if (snap.cfoToProfit != null && snap.cfoToProfit < 30) {
    parts.push('⚠️ Weak cash conversion — reported profits not translating to cash.');
  }

  // Analyst sentiment
  if (snap.estimateRevisionTrend === 'up') {
    parts.push('Analyst estimates are being revised upward — institutional consensus turning positive.');
  }
  if (snap.recentUpgrades > 0) {
    parts.push(`${snap.recentUpgrades} recent analyst upgrade(s) in the last 90 days.`);
  }

  // Catalyst signals
  const catalysts = [];
  if (snap.earningsSurprisePct != null && snap.earningsSurprisePct > 10) catalysts.push('earnings beat');
  if (snap.marginTrend === 'up' && snap.netProfitQoQ > 30) catalysts.push('earnings inflection');
  if (snap.pe != null && sectorMedians?.pe && snap.pe < sectorMedians.pe * 0.6 && snap.earningsGrowth > 15) {
    catalysts.push('cheap + accelerating re-rating setup');
  }
  if (catalysts.length > 0) {
    parts.push(`Near-term catalysts: ${catalysts.join(', ')}.`);
  }

  // Score summary
  parts.push(`\nOverall: Multibagger Score ${scored.multibaggerScore}/100 (${scored.tier.toUpperCase()}) — Quality ${scored.qualityScore}, Momentum ${scored.momentumScore}.`);

  return parts.join('\n\n');
}

export default { generateAnalysis, generateNarrative };
