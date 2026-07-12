/**
 * Yahoo Finance fundamentals provider — fetches company financial data via quoteSummary.
 *
 * Covers: P/E, P/B, PEG, ROE, ROA, debt/equity, margins, revenue/earnings growth,
 * quarterly results, balance sheet, cash flow, analyst estimates, recommendations.
 *
 * Symbol convention: canonical "NSE:TICKER" → auto-mapped to "TICKER.NS" for Yahoo.
 */

import YahooFinance from 'yahoo-finance2';
import { parseSymbol } from '../providers/types.js';

// Reuse same instance pattern as yahoo.js provider
const yahooFinance = new YahooFinance({ validation: { logErrors: false, logOptionsErrors: false } });
try { yahooFinance.suppressNotices(['yahooSurvey', 'ripHistorical', 'quoteSummary']); } catch { /* */ }
// Suppress noisy console output from yahoo-finance2 internals
const _origWarn = console.warn;
const _origLog = console.log;
const YF_NOISE = /yahoo|yf|finance|validation|historical|QuoteSummary|fundamentalsTimeSeries/i;
function quietYf(orig, args) {
  const msg = args[0];
  if (typeof msg === 'string' && YF_NOISE.test(msg)) return;
  orig.apply(console, args);
}
console.warn = (...args) => quietYf(_origWarn, args);
console.log = (...args) => quietYf(_origLog, args);

/**
 * Convert canonical symbol to Yahoo format.
 */
function toYahooSymbol(symbol) {
  const { exchange, ticker, raw } = parseSymbol(symbol);
  if (!exchange) return raw;
  if (exchange === 'NSE') return `${ticker}.NS`;
  if (exchange === 'BSE') return `${ticker}.BO`;
  return raw;
}

/**
 * Yahoo quoteSummary modules to fetch (excluding deprecated financial statement modules).
 */
const MODULES = [
  'price',
  'summaryDetail',
  'defaultKeyStatistics',
  'financialData',
  'earnings',
  'earningsHistory',
  'earningsTrend',
  'recommendationTrend',
  'upgradeDowngradeHistory',
  'assetProfile',
  'majorHoldersBreakdown',
];

/**
 * Safely get a numeric value or null.
 */
function num(v) {
  if (v == null || typeof v === 'object') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * Compute CAGR from an array of annual values (oldest first).
 */
function cagr(values) {
  const valid = values.filter(v => v != null && v > 0);
  if (valid.length < 2) return null;
  const years = valid.length - 1;
  const ratio = valid[valid.length - 1] / valid[0];
  if (ratio <= 0) return null;
  return (Math.pow(ratio, 1 / years) - 1) * 100;
}

/**
 * ROCE = EBIT / Capital Employed, where Capital Employed = Total Assets − Current Liabilities.
 * @param {object} incomeRow — annual income row with .ebit
 * @param {object} bsRow — annual balance sheet row with .totalAssets, .currentLiabilities
 * @returns {number|null} ROCE percentage
 */
function computeRoce(incomeRow, bsRow) {
  const ebit = incomeRow?.ebit ?? incomeRow?.operatingIncome;
  if (ebit == null || !bsRow) return null;
  if (bsRow.totalAssets == null || bsRow.currentLiabilities == null) return null;
  const capitalEmployed = bsRow.totalAssets - bsRow.currentLiabilities;
  if (!capitalEmployed || capitalEmployed <= 0) return null;
  return (ebit / capitalEmployed) * 100;
}

/**
 * Average of a numeric array, ignoring nulls. Returns null if empty.
 */
function avg(values) {
  const valid = values.filter(v => v != null && isFinite(v));
  if (valid.length === 0) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

/**
 * Extract quarterly results series from Yahoo earnings / income statement data.
 */
function extractQuarterlySeries(incomeQtr, earnings) {
  const series = [];

  // From incomeStatementHistoryQuarterly (most detailed)
  if (incomeQtr?.incomeStatementHistory?.length) {
    for (const stmt of incomeQtr.incomeStatementHistory) {
      series.push({
        date: stmt.endDate ? new Date(stmt.endDate).toISOString().slice(0, 10) : null,
        revenue: num(stmt.totalRevenue),
        grossProfit: num(stmt.grossProfit),
        operatingIncome: num(stmt.operatingIncome),
        netIncome: num(stmt.netIncome),
        ebit: num(stmt.ebit),
        interestExpense: num(stmt.interestExpense),
      });
    }
  }

  // Supplement with earnings quarterly data if income statement is sparse
  if (series.length === 0 && earnings?.financialsChart?.quarterly?.length) {
    for (const q of earnings.financialsChart.quarterly) {
      series.push({
        date: q.date || null,
        revenue: num(q.revenue),
        netIncome: num(q.earnings),
        grossProfit: null,
        operatingIncome: null,
        ebit: null,
        interestExpense: null,
      });
    }
  }

  return series.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

/**
 * Extract annual P&L series from incomeStatementHistory.
 */
function extractAnnualSeries(incomeAnnual) {
  if (!incomeAnnual?.incomeStatementHistory?.length) return [];
  return incomeAnnual.incomeStatementHistory.map(stmt => ({
    date: stmt.endDate ? new Date(stmt.endDate).toISOString().slice(0, 10) : null,
    revenue: num(stmt.totalRevenue),
    grossProfit: num(stmt.grossProfit),
    operatingIncome: num(stmt.operatingIncome),
    netIncome: num(stmt.netIncome),
    ebit: num(stmt.ebit),
    interestExpense: num(stmt.interestExpense),
  })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

/**
 * Extract balance sheet data.
 */
function extractBalanceSheet(bs) {
  if (!bs?.balanceSheetStatements?.length) return [];
  return bs.balanceSheetStatements.map(stmt => ({
    date: stmt.endDate ? new Date(stmt.endDate).toISOString().slice(0, 10) : null,
    totalAssets: num(stmt.totalAssets),
    totalLiabilities: num(stmt.totalLiab),
    totalEquity: num(stmt.totalStockholderEquity),
    totalDebt: num(stmt.longTermDebt || stmt.totalDebt),
    longTermDebt: num(stmt.longTermDebt),
    shortTermDebt: num(stmt.shortLongTermDebt || stmt.shortTermBorrowings),
    currentAssets: num(stmt.totalCurrentAssets),
    currentLiabilities: num(stmt.totalCurrentLiabilities),
    cash: num(stmt.cash),
    inventory: num(stmt.inventory),
    receivables: num(stmt.netReceivables),
    sharesOutstanding: num(stmt.commonStock || stmt.commonStockSharesOutstanding),
  })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

/**
 * Extract cash flow data.
 */
function extractCashFlow(cf) {
  if (!cf?.cashflowStatements?.length) return [];
  return cf.cashflowStatements.map(stmt => ({
    date: stmt.endDate ? new Date(stmt.endDate).toISOString().slice(0, 10) : null,
    operatingCashflow: num(stmt.totalCashFromOperatingActivities),
    capitalExpenditure: num(stmt.capitalExpenditures),
    freeCashflow: num(stmt.totalCashFromOperatingActivities) != null && num(stmt.capitalExpenditures) != null
      ? num(stmt.totalCashFromOperatingActivities) + num(stmt.capitalExpenditures) // capex is negative
      : null,
    depreciation: num(stmt.depreciation),
  })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

/**
 * Compute QoQ and YoY growth for the latest quarter.
 * Uses date-based matching (not positional indexing) so gaps/missing quarters
 * in the series don't misalign the QoQ (~90d back) or YoY (~365d back) reference.
 */
function computeQuarterlyGrowth(series) {
  if (series.length < 2) return { netProfitQoQ: null, revenueQoQ: null, netProfitYoY: null, revenueYoY: null };

  const pctChange = (curr, base) => {
    if (curr == null || base == null || base === 0) return null;
    return ((curr - base) / Math.abs(base)) * 100;
  };

  // Latest quarter that actually has data (skip trailing null/gap rows).
  let latest = null;
  let latestIdx = -1;
  for (let k = series.length - 1; k >= 0; k--) {
    if (series[k]?.date && (series[k].netIncome != null || series[k].revenue != null)) {
      latest = series[k];
      latestIdx = k;
      break;
    }
  }
  if (!latest) return { netProfitQoQ: null, revenueQoQ: null, netProfitYoY: null, revenueYoY: null };

  const latestT = new Date(latest.date).getTime();
  // Find the reference entry closest to `latestT - offsetDays`, within tolerance.
  const findRef = (offsetDays, toleranceDays) => {
    const targetT = latestT - offsetDays * 86400000;
    const tol = toleranceDays * 86400000;
    let best = null, bestDelta = Infinity;
    for (let k = 0; k < latestIdx; k++) {
      const e = series[k];
      if (!e?.date || (e.netIncome == null && e.revenue == null)) continue;
      const delta = Math.abs(new Date(e.date).getTime() - targetT);
      if (delta < bestDelta) { bestDelta = delta; best = e; }
    }
    return bestDelta <= tol ? best : null;
  };

  const prev = findRef(91, 45);   // previous quarter (~3 months back)
  const yoyRef = findRef(365, 45); // same quarter last year (~12 months back)

  return {
    netProfitQoQ: prev ? pctChange(latest.netIncome, prev.netIncome) : null,
    revenueQoQ: prev ? pctChange(latest.revenue, prev.revenue) : null,
    netProfitYoY: yoyRef ? pctChange(latest.netIncome, yoyRef.netIncome) : null,
    revenueYoY: yoyRef ? pctChange(latest.revenue, yoyRef.revenue) : null,
  };
}

/**
 * Determine margin trend from quarterly series.
 */
function marginTrend(series) {
  if (series.length < 3) return 'unknown';
  const margins = series.slice(-4).map(q => {
    if (q.revenue && q.operatingIncome) return q.operatingIncome / q.revenue;
    return null;
  }).filter(m => m != null);
  if (margins.length < 2) return 'unknown';
  const first = margins[0];
  const last = margins[margins.length - 1];
  const diff = last - first;
  if (diff > 0.02) return 'up';
  if (diff < -0.02) return 'down';
  return 'flat';
}

/**
 * Count consecutive quarters of positive/growing net income.
 */
function consecutiveGrowthQuarters(series) {
  let count = 0;
  for (let i = series.length - 1; i >= 1; i--) {
    if (series[i].netIncome != null && series[i - 1].netIncome != null &&
        series[i].netIncome > series[i - 1].netIncome) {
      count++;
    } else break;
  }
  return count;
}

/**
 * Extract earnings surprise data.
 */
function extractEarningsSurprise(earningsHistory) {
  if (!earningsHistory?.history?.length) return { surprisePct: null, surprises: [] };
  const surprises = earningsHistory.history.map(h => ({
    date: h.quarter ? new Date(h.quarter).toISOString().slice(0, 10) : null,
    actual: num(h.epsActual),
    estimate: num(h.epsEstimate),
    surprise: num(h.epsDifference),
    surprisePct: num(h.surprisePercent),
  }));
  const latest = surprises[surprises.length - 1];
  return { surprisePct: latest?.surprisePct ?? null, surprises };
}

/**
 * Extract estimate revision trend.
 */
function extractEstimateTrend(earningsTrend) {
  if (!earningsTrend?.trend?.length) return { estimateRevisionTrend: 'unknown', estimates: [] };
  const estimates = earningsTrend.trend.map(t => ({
    period: t.period,
    growth: num(t.growth),
    earningsEstimate: num(t.earningsEstimate?.avg),
    revenueEstimate: num(t.revenueEstimate?.avg),
    revisionsUp: num(t.epsTrend?.current) > num(t.epsTrend?.['7daysAgo']) ? 1 : 0,
  }));
  // Check if current estimates are higher than 30/90 days ago
  const curr = earningsTrend.trend[0];
  if (curr?.epsTrend) {
    const current = num(curr.epsTrend.current);
    const ago30 = num(curr.epsTrend['30daysAgo']);
    if (current != null && ago30 != null) {
      if (current > ago30 * 1.02) return { estimateRevisionTrend: 'up', estimates };
      if (current < ago30 * 0.98) return { estimateRevisionTrend: 'down', estimates };
    }
  }
  return { estimateRevisionTrend: 'flat', estimates };
}

/**
 * Extract analyst recommendation trend.
 */
function extractRecommendations(recTrend, upgradeHistory) {
  const recommendations = [];
  if (recTrend?.trend?.length) {
    for (const t of recTrend.trend) {
      recommendations.push({
        period: t.period,
        strongBuy: num(t.strongBuy),
        buy: num(t.buy),
        hold: num(t.hold),
        sell: num(t.sell),
        strongSell: num(t.strongSell),
      });
    }
  }

  const recentUpgrades = [];
  if (upgradeHistory?.history?.length) {
    const cutoff = Date.now() - 90 * 86400000; // last 90 days
    for (const u of upgradeHistory.history) {
      if (u.epochGradeDate && u.epochGradeDate * 1000 > cutoff) {
        recentUpgrades.push({
          firm: u.firm,
          toGrade: u.toGrade,
          fromGrade: u.fromGrade,
          action: u.action,
        });
      }
    }
  }

  return { recommendations, recentUpgrades };
}

/**
 * Extract income statement series from fundamentalsTimeSeries rows.
 * Falls back to earnings.financialsChart if timeSeries is empty.
 */
function extractTimeSeriesIncome(tsRows, earnings) {
  const series = [];
  if (tsRows && tsRows.length > 0) {
    for (const row of tsRows) {
      if (!row.date) continue;
      series.push({
        date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
        revenue: num(row.totalRevenue),
        grossProfit: num(row.grossProfit),
        operatingIncome: num(row.operatingIncome),
        netIncome: num(row.netIncome),
        ebit: num(row.EBIT || row.ebit || row.operatingIncome),
        ebitda: num(row.EBITDA || row.normalizedEBITDA || row.ebitda || row.normalizedEbitda),
        pretaxIncome: num(row.pretaxIncome),
        otherIncome: num(row.otherNonOperatingIncomeExpenses || row.otherIncomeExpense || row.totalOtherFinanceCost),
        interestExpense: num(row.interestExpense),
        depreciation: num(row.reconciledDepreciation || row.depreciationAndAmortizationInIncomeStatement || row.depreciationIncomeStatement),
      });
    }
  }

  // Fallback: use earnings.financialsChart for quarterly if timeSeries is empty
  if (series.length === 0 && earnings?.financialsChart?.quarterly?.length) {
    for (const q of earnings.financialsChart.quarterly) {
      series.push({
        date: q.date || null,
        revenue: num(q.revenue),
        netIncome: num(q.earnings),
        grossProfit: null,
        operatingIncome: null,
        ebit: null,
        ebitda: null,
        pretaxIncome: null,
        otherIncome: null,
        interestExpense: null,
        depreciation: null,
      });
    }
  }

  return series.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

/**
 * Extract balance sheet from fundamentalsTimeSeries rows.
 */
function extractTimeSeriesBalanceSheet(tsRows) {
  if (!tsRows || tsRows.length === 0) return [];
  return tsRows.filter(r => r.date).map(row => ({
    date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
    totalAssets: num(row.totalAssets),
    totalEquity: num(row.stockholdersEquity),
    totalDebt: num(row.totalDebt),
    longTermDebt: num(row.longTermDebt),
    currentAssets: num(row.currentAssets),
    currentLiabilities: num(row.currentLiabilities),
    cash: num(row.cashAndCashEquivalents || row.cashEquivalents),
    inventory: num(row.inventory),
    receivables: num(row.grossAccountsReceivable || row.accountsReceivable),
    sharesOutstanding: num(row.sharesIssued || row.ordinarySharesNumber),
  })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

/**
 * Extract cash flow from fundamentalsTimeSeries rows.
 */
function extractTimeSeriesCashFlow(tsRows) {
  if (!tsRows || tsRows.length === 0) return [];
  return tsRows.filter(r => r.date && (r.operatingCashFlow != null || r.capitalExpenditure != null)).map(row => ({
    date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
    operatingCashflow: num(row.operatingCashFlow),
    capitalExpenditure: num(row.capitalExpenditure),
    freeCashflow: (num(row.operatingCashFlow) != null && num(row.capitalExpenditure) != null)
      ? num(row.operatingCashFlow) + num(row.capitalExpenditure) : num(row.freeCashFlow),
    depreciation: num(row.depreciation || row.depreciationAndAmortization),
  })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

/**
 * Fetch fundamentals for a single symbol.
 * @param {string} symbol — Canonical "NSE:TICKER"
 * @returns {Promise<object>} FundamentalSnapshot
 */
export async function fetchFundamentals(symbol) {
  const yahooSymbol = toYahooSymbol(symbol);

  // Fetch quoteSummary (ratios, profile, estimates) and fundamentalsTimeSeries (financials) in parallel
  let data;
  try {
    data = await yahooFinance.quoteSummary(yahooSymbol, { modules: MODULES });
  } catch (err) {
    if (err.result) {
      data = err.result;
    } else {
      throw err;
    }
  }

  // Fetch financial statements via fundamentalsTimeSeries (replaces deprecated quoteSummary modules)
  let annualTS = [], quarterlyTS = [];
  try {
    const period1 = new Date(Date.now() - 5 * 365 * 86400000).toISOString().slice(0, 10);
    [annualTS, quarterlyTS] = await Promise.all([
      yahooFinance.fundamentalsTimeSeries(yahooSymbol, { period1, type: 'annual', module: 'all' }).catch(() => []),
      yahooFinance.fundamentalsTimeSeries(yahooSymbol, { period1, type: 'quarterly', module: 'all' }).catch(() => []),
    ]);
  } catch { /* fallback to empty */ }

  const price = data.price || {};
  const summary = data.summaryDetail || {};
  const keyStats = data.defaultKeyStatistics || {};
  const finData = data.financialData || {};
  const earnings = data.earnings || {};
  const earningsHist = data.earningsHistory || {};
  const earningsTrend = data.earningsTrend || {};
  const recTrend = data.recommendationTrend || {};
  const upgradeHist = data.upgradeDowngradeHistory || {};
  const profile = data.assetProfile || {};
  const majorHolders = data.majorHoldersBreakdown || {};

  // Extract series from fundamentalsTimeSeries
  const quarterlySeries = extractTimeSeriesIncome(quarterlyTS, earnings);
  const annualSeries = extractTimeSeriesIncome(annualTS);
  const balanceSheetSeries = extractTimeSeriesBalanceSheet(annualTS);
  const cashFlowSeries = extractTimeSeriesCashFlow(annualTS);

  // Growth computations
  const qtrGrowth = computeQuarterlyGrowth(quarterlySeries);
  const annualRevenues = annualSeries.map(a => a.revenue).filter(v => v != null);
  const annualProfits = annualSeries.map(a => a.netIncome).filter(v => v != null);

  // Earnings quality
  const latestCF = cashFlowSeries[cashFlowSeries.length - 1];
  const latestAnnual = annualSeries[annualSeries.length - 1];
  const cfoToProfit = (latestCF?.operatingCashflow != null && latestAnnual?.netIncome != null && latestAnnual.netIncome !== 0)
    ? (latestCF.operatingCashflow / latestAnnual.netIncome) * 100 : null;

  // Balance sheet health
  const latestBS = balanceSheetSeries[balanceSheetSeries.length - 1];
  const prevBS = balanceSheetSeries.length >= 2 ? balanceSheetSeries[balanceSheetSeries.length - 2] : null;
  const currentRatio = (latestBS?.currentAssets && latestBS?.currentLiabilities)
    ? latestBS.currentAssets / latestBS.currentLiabilities : null;

  // Dilution: shares outstanding change
  const sharesLatest = latestBS?.sharesOutstanding || num(keyStats.sharesOutstanding);
  const sharesPrev = prevBS?.sharesOutstanding;
  const dilutionPct = (sharesLatest && sharesPrev && sharesPrev > 0)
    ? ((sharesLatest - sharesPrev) / sharesPrev) * 100 : null;

  // Receivable & inventory days (annualized)
  const receivableDays = (latestBS?.receivables && latestAnnual?.revenue)
    ? (latestBS.receivables / latestAnnual.revenue) * 365 : null;
  const inventoryDays = (latestBS?.inventory && latestAnnual?.revenue)
    ? (latestBS.inventory / latestAnnual.revenue) * 365 : null;

  // Interest coverage
  const interestCoverage = (latestAnnual?.ebit && latestAnnual?.interestExpense && latestAnnual.interestExpense !== 0)
    ? Math.abs(latestAnnual.ebit / latestAnnual.interestExpense) : null;

  // ROCE (Terry Smith capital efficiency): latest + 5y average, paired by date
  const bsByDate = new Map(balanceSheetSeries.map(b => [b.date, b]));
  const roceSeries = annualSeries
    .map(a => computeRoce(a, bsByDate.get(a.date)))
    .filter(v => v != null);
  const roce = latestAnnual ? computeRoce(latestAnnual, latestBS) : null;
  const roce5yAvg = roceSeries.length >= 2 ? avg(roceSeries) : null;

  // Operating margin per year → 5y average (margin stability / consistency)
  const opmSeries = annualSeries
    .map(a => (a.revenue && a.operatingIncome != null ? (a.operatingIncome / a.revenue) * 100 : null))
    .filter(v => v != null);
  const opm5yAvg = opmSeries.length >= 2 ? avg(opmSeries) : null;

  // Long-horizon growth (5y CAGR; Yahoo free tier caps ~5y annual)
  const revenueCAGR5y = cagr(annualRevenues.slice(-6));
  const epsCAGR5y = cagr(annualProfits.slice(-6));

  // CANSLIM earnings/sales acceleration: latest quarter vs same quarter last year
  const epsQtrYoY = qtrGrowth.netProfitYoY;
  const salesQtrYoY = qtrGrowth.revenueYoY;
  const canslimAccel = (epsQtrYoY != null && epsQtrYoY >= 30 && salesQtrYoY != null && salesQtrYoY >= 20);


  // Earnings surprise & estimates
  const { surprisePct, surprises } = extractEarningsSurprise(earningsHist);
  const { estimateRevisionTrend, estimates } = extractEstimateTrend(earningsTrend);
  const { recommendations, recentUpgrades } = extractRecommendations(recTrend, upgradeHist);

  // EBITDA (from financialData or derive from operating income + depreciation)
  const ebitda = num(finData.ebitda) ?? (latestAnnual?.operatingIncome && latestCF?.depreciation
    ? latestAnnual.operatingIncome + Math.abs(latestCF.depreciation) : null);
  const ebitdaMargin = (ebitda && latestAnnual?.revenue) ? (ebitda / latestAnnual.revenue) * 100 : null;

  // Tax rate
  const effectiveTaxRate = (latestAnnual?.netIncome != null && latestAnnual?.operatingIncome != null
    && latestAnnual.operatingIncome > 0)
    ? ((latestAnnual.operatingIncome - latestAnnual.netIncome) / latestAnnual.operatingIncome) * 100
    : null;

  // Other income proportion (approximation: PBT - operating income ≈ other income)
  const otherIncomePct = (latestAnnual?.operatingIncome != null && latestAnnual?.netIncome != null
    && latestAnnual.operatingIncome > 0)
    ? null // Yahoo doesn't separate other income cleanly; will be enriched from Screener
    : null;

  return {
    symbol,
    name: price.shortName || price.longName || null,
    sector: profile.sector || null,
    industry: profile.industry || null,
    exchange: price.exchangeName || null,

    // Price & market
    price: num(price.regularMarketPrice),
    marketCap: num(price.marketCap),
    fiftyTwoWeekHigh: num(summary.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(summary.fiftyTwoWeekLow),
    priceVs52wHigh: (num(price.regularMarketPrice) && num(summary.fiftyTwoWeekHigh))
      ? (num(price.regularMarketPrice) / num(summary.fiftyTwoWeekHigh)) * 100 : null,

    // Valuation
    pe: num(summary.trailingPE),
    forwardPe: num(summary.forwardPE || keyStats.forwardPE),
    pb: num(summary.priceToBook || keyStats.priceToBook),
    peg: num(keyStats.pegRatio),
    evToEbitda: num(keyStats.enterpriseToEbitda),
    bookValue: num(keyStats.bookValue),

    // Profitability
    roe: num(finData.returnOnEquity) != null ? num(finData.returnOnEquity) * 100 : null,
    roa: num(finData.returnOnAssets) != null ? num(finData.returnOnAssets) * 100 : null,
    roce: roce != null ? Math.round(roce * 100) / 100 : null,
    roce5yAvg: roce5yAvg != null ? Math.round(roce5yAvg * 100) / 100 : null,
    grossMargin: num(finData.grossMargins) != null ? num(finData.grossMargins) * 100 : null,
    operatingMargin: num(finData.operatingMargins) != null ? num(finData.operatingMargins) * 100 : null,
    opm5yAvg: opm5yAvg != null ? Math.round(opm5yAvg * 100) / 100 : null,
    netMargin: num(finData.profitMargins) != null ? num(finData.profitMargins) * 100 : null,

    // Growth
    revenueGrowth: num(finData.revenueGrowth) != null ? num(finData.revenueGrowth) * 100 : null,
    earningsGrowth: num(finData.earningsGrowth) != null ? num(finData.earningsGrowth) * 100 : null,
    revenueCAGR3y: cagr(annualRevenues.slice(-4)),
    epsCAGR3y: cagr(annualProfits.slice(-4)),
    revenueCAGR5y: revenueCAGR5y != null ? Math.round(revenueCAGR5y * 100) / 100 : null,
    epsCAGR5y: epsCAGR5y != null ? Math.round(epsCAGR5y * 100) / 100 : null,

    // CANSLIM acceleration (latest quarter vs same quarter prior year)
    epsQtrYoY: epsQtrYoY != null ? Math.round(epsQtrYoY * 100) / 100 : null,
    salesQtrYoY: salesQtrYoY != null ? Math.round(salesQtrYoY * 100) / 100 : null,
    canslimAccel,

    // EBITDA
    ebitda,
    ebitdaMargin,

    // Health
    debtToEquity: num(finData.debtToEquity),
    currentRatio: currentRatio ? Math.round(currentRatio * 100) / 100 : null,
    interestCoverage,

    // Earnings quality
    cfoToProfit,
    effectiveTaxRate,
    otherIncomePct,
    receivableDays: receivableDays ? Math.round(receivableDays) : null,
    inventoryDays: inventoryDays ? Math.round(inventoryDays) : null,
    dilutionPct: dilutionPct ? Math.round(dilutionPct * 100) / 100 : null,
    freeCashflow: num(finData.freeCashflow),

    // Quarterly momentum
    ...qtrGrowth,
    marginTrend: marginTrend(quarterlySeries),
    consecutiveGrowthQuarters: consecutiveGrowthQuarters(quarterlySeries),
    earningsSurprisePct: surprisePct,

    // Estimates & analyst
    estimateRevisionTrend,
    recentUpgrades: recentUpgrades.length,

    // Series data (for detail view)
    quarterlySeries,
    annualSeries,
    balanceSheetSeries,
    cashFlowSeries,
    earningsSurprises: surprises,
    estimates,
    recommendations,

    // Shares
    sharesOutstanding: sharesLatest,

    // Dividend
    dividendYield: num(summary.dividendYield) != null ? num(summary.dividendYield) * 100 : null,
    dividendRate: num(summary.dividendRate),

    // Yahoo-sourced ownership (fallback when NSE unavailable)
    yahooOwnership: {
      insidersPercentHeld: num(majorHolders.insidersPercentHeld) != null ? num(majorHolders.insidersPercentHeld) * 100 : null,
      institutionsPercentHeld: num(majorHolders.institutionsPercentHeld) != null ? num(majorHolders.institutionsPercentHeld) * 100 : null,
      institutionsFloatPercentHeld: num(majorHolders.institutionsFloatPercentHeld) != null ? num(majorHolders.institutionsFloatPercentHeld) * 100 : null,
      institutionsCount: num(majorHolders.institutionsCount),
    },

    // Meta
    fetchedAt: new Date().toISOString(),
    source: 'yahoo',
    dataCompleteness: computeCompleteness({
      pe: num(summary.trailingPE), roe: num(finData.returnOnEquity),
      debtToEquity: num(finData.debtToEquity), quarterlySeries, annualSeries,
    }),
  };
}

/**
 * Compute a data completeness score (0-100) to gate low-quality data.
 */
function computeCompleteness({ pe, roe, debtToEquity, quarterlySeries, annualSeries }) {
  let score = 0;
  if (pe != null) score += 15;
  if (roe != null) score += 15;
  if (debtToEquity != null) score += 15;
  if (quarterlySeries.length >= 4) score += 25;
  else if (quarterlySeries.length >= 2) score += 15;
  if (annualSeries.length >= 3) score += 30;
  else if (annualSeries.length >= 1) score += 15;
  return Math.min(score, 100);
}

export default { fetchFundamentals, toYahooSymbol };
