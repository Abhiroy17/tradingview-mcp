/**
 * test-multibagger.js — Offline sanity tests for the multibagger scorer + F-Score.
 *
 * Uses mocked snapshots (no network). Run: node scripts/test-multibagger.js
 */

import { computeFScore } from '../src/engine/multibagger/fscore.js';
import { scoreFundamentals, computeSectorMedians } from '../src/engine/multibagger/scorer.js';
import { SCREEN_PRESETS, computePresetFit } from '../src/engine/multibagger/screener.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}

// ── Mock snapshot: strong multibagger (J&K Bank-like) ─────────────────────
const strongSnap = {
  symbol: 'NSE:TESTBANK',
  name: 'Test Bank Ltd',
  sector: 'Financial Services',
  industry: 'Banking',
  price: 193,
  marketCap: 21216e7,
  fiftyTwoWeekHigh: 202,
  fiftyTwoWeekLow: 97,
  priceVs52wHigh: 95.5,
  pe: 9,
  forwardPe: 8,
  pb: 1.3,
  peg: 0.5,
  evToEbitda: null,
  bookValue: 152,
  roe: 15,
  roa: 1.2,
  roce: null,
  grossMargin: null,
  operatingMargin: 16,
  netMargin: 18,
  revenueGrowth: 12,
  earningsGrowth: 40,
  revenueCAGR3y: 12,
  epsCAGR3y: 25,
  ebitda: null,
  ebitdaMargin: null,
  debtToEquity: null, // Banks don't use debt/equity in traditional sense
  currentRatio: null,
  interestCoverage: null,
  cfoToProfit: 85,
  effectiveTaxRate: 20,
  otherIncomePct: null,
  receivableDays: null,
  inventoryDays: null,
  dilutionPct: 0,
  freeCashflow: null,
  netProfitYoY: 36,
  netProfitQoQ: 35,
  revenueYoY: 5,
  revenueQoQ: 3,
  marginTrend: 'up',
  consecutiveGrowthQuarters: 3,
  earningsSurprisePct: 8,
  estimateRevisionTrend: 'up',
  recentUpgrades: 2,
  quarterlySeries: [
    { date: '2025-09', revenue: 3206e7, netIncome: 532e7, operatingIncome: 516e7 },
    { date: '2025-12', revenue: 3212e7, netIncome: 585e7, operatingIncome: 550e7 },
    { date: '2026-03', revenue: 3268e7, netIncome: 587e7, operatingIncome: 560e7 },
    { date: '2026-06', revenue: 3272e7, netIncome: 798e7, operatingIncome: 750e7 },
  ],
  annualSeries: [
    { date: '2023', revenue: 11212e7, netIncome: 1767e7, grossProfit: null, operatingIncome: 1777e7 },
    { date: '2024', revenue: 12536e7, netIncome: 2082e7, grossProfit: null, operatingIncome: 1965e7 },
    { date: '2025', revenue: 13145e7, netIncome: 2363e7, grossProfit: null, operatingIncome: 2018e7 },
  ],
  balanceSheetSeries: [
    { date: '2024', totalAssets: 169468e7, totalEquity: 14252e7, longTermDebt: 2383e7, currentAssets: null, currentLiabilities: null, sharesOutstanding: 1101e6 },
    { date: '2025', totalAssets: 189194e7, totalEquity: 16750e7, longTermDebt: 3431e7, currentAssets: null, currentLiabilities: null, sharesOutstanding: 1101e6 },
  ],
  cashFlowSeries: [
    { date: '2024', operatingCashflow: 2718e7, capitalExpenditures: -102e7, depreciation: 168e7 },
    { date: '2025', operatingCashflow: -1132e7, capitalExpenditures: -302e7, depreciation: 0 },
  ],
  earningsSurprises: [],
  estimates: [],
  recommendations: [],
  sharesOutstanding: 1101e6,
  fetchedAt: new Date().toISOString(),
  source: 'yahoo',
  dataCompleteness: 75,
};

// ── Mock snapshot: weak stock ─────────────────────────────────────────────
const weakSnap = {
  symbol: 'NSE:WEAKCO',
  name: 'Weak Corp',
  sector: 'Industrials',
  industry: 'Construction',
  price: 25,
  marketCap: 100e7,
  fiftyTwoWeekHigh: 80,
  fiftyTwoWeekLow: 20,
  priceVs52wHigh: 31,
  pe: 85,
  forwardPe: null,
  pb: 5,
  peg: 4,
  evToEbitda: 40,
  bookValue: 5,
  roe: 3,
  roa: 1,
  roce: null,
  grossMargin: 10,
  operatingMargin: 4,
  netMargin: 2,
  revenueGrowth: -5,
  earningsGrowth: -20,
  revenueCAGR3y: -3,
  epsCAGR3y: -10,
  ebitda: 5e7,
  ebitdaMargin: 5,
  debtToEquity: 180,
  currentRatio: 0.8,
  interestCoverage: 1.2,
  cfoToProfit: 20,
  effectiveTaxRate: 5,
  otherIncomePct: null,
  receivableDays: 200,
  inventoryDays: 300,
  dilutionPct: 15,
  freeCashflow: -10e7,
  netProfitYoY: -30,
  netProfitQoQ: -10,
  revenueYoY: -5,
  revenueQoQ: -2,
  marginTrend: 'down',
  consecutiveGrowthQuarters: 0,
  earningsSurprisePct: -5,
  estimateRevisionTrend: 'down',
  recentUpgrades: 0,
  quarterlySeries: [
    { date: '2025-09', revenue: 50e7, netIncome: 2e7, operatingIncome: 3e7 },
    { date: '2025-12', revenue: 48e7, netIncome: 1e7, operatingIncome: 2e7 },
  ],
  annualSeries: [
    { date: '2023', revenue: 220e7, netIncome: 15e7, grossProfit: 22e7, operatingIncome: 10e7 },
    { date: '2024', revenue: 200e7, netIncome: 8e7, grossProfit: 18e7, operatingIncome: 6e7 },
  ],
  balanceSheetSeries: [
    { date: '2023', totalAssets: 300e7, totalEquity: 60e7, longTermDebt: 100e7, currentAssets: 50e7, currentLiabilities: 70e7, sharesOutstanding: 40e6 },
    { date: '2024', totalAssets: 280e7, totalEquity: 50e7, longTermDebt: 120e7, currentAssets: 40e7, currentLiabilities: 60e7, sharesOutstanding: 46e6 },
  ],
  cashFlowSeries: [
    { date: '2024', operatingCashflow: 2e7, capitalExpenditures: -5e7, depreciation: 3e7 },
  ],
  earningsSurprises: [],
  estimates: [],
  recommendations: [],
  sharesOutstanding: 46e6,
  fetchedAt: new Date().toISOString(),
  source: 'yahoo',
  dataCompleteness: 60,
};

// ── Tests ─────────────────────────────────────────────────────────────────

console.log('\n=== Multibagger Scorer Tests ===\n');

// F-Score tests
console.log('F-Score:');
const fStrong = computeFScore(strongSnap);
assert(fStrong.score >= 3 && fStrong.score <= 9, `Strong snap F-Score is ${fStrong.score} (valid range)`);
assert(fStrong.breakdown.length === 9, `F-Score breakdown has 9 items (got ${fStrong.breakdown.length})`);

const fWeak = computeFScore(weakSnap);
assert(fWeak.score < fStrong.score, `Weak snap F-Score (${fWeak.score}) < Strong (${fStrong.score})`);

// Scorer tests
console.log('\nScorer:');
const scoredStrong = scoreFundamentals(strongSnap);
const scoredWeak = scoreFundamentals(weakSnap);

assert(scoredStrong.multibaggerScore > 50, `Strong stock score ${scoredStrong.multibaggerScore} > 50`);
assert(scoredWeak.multibaggerScore < 40, `Weak stock score ${scoredWeak.multibaggerScore} < 40`);
assert(scoredStrong.multibaggerScore > scoredWeak.multibaggerScore, 'Strong > Weak overall');
assert(scoredStrong.tier === 'strong' || scoredStrong.tier === 'good' || scoredStrong.tier === 'neutral', `Strong tier: ${scoredStrong.tier}`);
assert(scoredWeak.tier === 'weak' || scoredWeak.tier === 'avoid', `Weak tier: ${scoredWeak.tier}`);

// Axis tests
assert(scoredStrong.axes.resultsMomentum > scoredWeak.axes.resultsMomentum, 'Strong has higher results-momentum');
assert(scoredStrong.axes.catalyst > scoredWeak.axes.catalyst, 'Strong has higher catalyst score');
assert(scoredStrong.axes.earningsQuality > scoredWeak.axes.earningsQuality, 'Strong has higher earnings quality');

// Quality/Momentum split
assert(scoredStrong.qualityScore > 0 && scoredStrong.qualityScore <= 100, `Quality score valid: ${scoredStrong.qualityScore}`);
assert(scoredStrong.momentumScore > 0 && scoredStrong.momentumScore <= 100, `Momentum score valid: ${scoredStrong.momentumScore}`);

// Flags
assert(scoredStrong.greenFlags.length > 0, `Strong has green flags (${scoredStrong.greenFlags.length})`);
assert(scoredWeak.redFlags.length > 0, `Weak has red flags (${scoredWeak.redFlags.length})`);

// Growth durability
assert(scoredStrong.growthDurability === 'sustainable' || scoredStrong.growthDurability === 'moderate', `Strong growth: ${scoredStrong.growthDurability}`);

// Sector medians
console.log('\nSector Medians:');
const medians = computeSectorMedians([strongSnap, weakSnap]);
assert(medians.size >= 1, `Computed medians for ${medians.size} sectors`);

// Score with sector context
const scoredWithSector = scoreFundamentals(strongSnap, { pe: 18, pb: 2, roe: 12 });
assert(scoredWithSector.axes.valuation > 50, `With cheap P/E vs sector, valuation axis high: ${scoredWithSector.axes.valuation}`);

// ── Institutional factors: ROCE, quality composite, CANSLIM, presets ──────
console.log('\nInstitutional factors:');

const qualitySnap = {
  ...strongSnap,
  symbol: 'NSE:QUALITYCO',
  sector: 'Consumer',
  industry: 'Specialty Chemicals',
  marketCap: 5000e7, // 5000 Cr — inside all preset bands
  roce: 28,
  roce5yAvg: 26,
  opm5yAvg: 22,
  operatingMargin: 23,
  roe: 24,
  debtToEquity: 12,
  interestCoverage: 15,
  currentRatio: 2.2,
  cfoToProfit: 110,
  peg: 0.8,
  pe: 32,
  revenueCAGR3y: 26,
  revenueCAGR5y: 22,
  epsCAGR3y: 28,
  epsCAGR5y: 24,
  epsQtrYoY: 45,
  salesQtrYoY: 28,
  canslimAccel: true,
};

const scoredQuality = scoreFundamentals(qualitySnap);
assert(scoredQuality.axes.profitability > scoredStrong.axes.profitability, `High-ROCE stock has higher profitability axis (${scoredQuality.axes.profitability} > ${scoredStrong.axes.profitability})`);
assert(scoredQuality.qualityComposite >= 70, `Quality composite high for elite compounder: ${scoredQuality.qualityComposite}`);
assert(scoredQuality.qualityCriteriaMet === scoredQuality.qualityCriteriaTotal, `All quality criteria met (${scoredQuality.qualityCriteriaMet}/${scoredQuality.qualityCriteriaTotal})`);
assert(scoredQuality.greenFlags.some(f => f.includes('CANSLIM')), 'CANSLIM acceleration green flag present');
assert(scoredQuality.greenFlags.some(f => f.includes('ROCE')), 'High ROCE green flag present');
assert(scoredQuality.greenFlags.some(f => f.includes('GARP')), 'GARP (PEG<1) green flag present');
assert(scoredQuality.roce === 28, `ROCE surfaced in result: ${scoredQuality.roce}`);

// Preset fit
const fitInst = computePresetFit(qualitySnap, SCREEN_PRESETS.institutional);
assert(fitInst.total === SCREEN_PRESETS.institutional.criteria.length, `Institutional preset has ${fitInst.total} criteria`);
assert(fitInst.fitPct >= 80, `Elite compounder scores high on institutional preset: ${fitInst.fitPct}%`);
assert(fitInst.bonus > 0, `Institutional preset awards a soft-boost bonus: +${fitInst.bonus}`);

const fitWeak = computePresetFit(weakSnap, SCREEN_PRESETS.institutional);
assert(fitWeak.fitPct < fitInst.fitPct, `Weak stock fits institutional preset less (${fitWeak.fitPct}% < ${fitInst.fitPct}%)`);

const fitSmall = computePresetFit(qualitySnap, SCREEN_PRESETS.smallcap_hunter);
assert(fitSmall.total > 0 && fitSmall.fitPct >= 0 && fitSmall.fitPct <= 100, `Small-cap hunter preset fit valid: ${fitSmall.fitPct}%`);

// Presets registry integrity
assert(Object.keys(SCREEN_PRESETS).length === 3, `3 screen presets defined (got ${Object.keys(SCREEN_PRESETS).length})`);
for (const [id, p] of Object.entries(SCREEN_PRESETS)) {
  assert(p.label && p.description && Array.isArray(p.criteria) && p.criteria.length > 0, `Preset '${id}' well-formed`);
}

// Summary
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}\n`);

if (failed > 0) process.exit(1);
