/**
 * Multibagger screener — orchestrates the full screening pipeline.
 *
 * Pipeline: pre-filter → Yahoo fundamentals → sector medians → score → rank → topN →
 *           promoter/institutional enrich → re-flag → final ranked list.
 */

import { getFundamentals, getFundamentalsMany, getCacheMap } from '../../data/fundamentals/index.js';
import { loadNSEUniverse, preFilterUniverse, filterByMarketCap, preSectorRestrict, DEFAULT_FILTERS } from '../../data/fundamentals/universe-filter.js';
import { scoreFundamentals, computeSectorMedians } from './scorer.js';
import { getBasket, BASKETS, isSectorUniverse, getSectorLabel, getIndustryMatch } from '../baskets.js';
import { getSymbolsBySector, getSymbolsByIndustry, preFilterSymbols } from '../../db/symbols-query.js';

const CR = 1e7; // 1 crore in rupees

// ── Screen presets (institutional frameworks) ──────────────────────────────
// Presets are SOFT BOOSTS: matching stocks get a score bonus and rank higher,
// but non-matching stocks are NOT excluded. Each criterion is a predicate on the
// FundamentalSnapshot. `bonusMax` is the maximum score bump at 100% criteria fit.

export const SCREEN_PRESETS = {
  institutional: {
    label: 'Institutional Multibagger',
    description: 'Quality compounders: sustained growth, high ROCE/ROE, low debt, GARP valuation.',
    bonusMax: 15,
    criteria: [
      { label: 'Mcap 500–50000 Cr', test: s => s.marketCap != null && s.marketCap >= 500 * CR && s.marketCap <= 50000 * CR },
      { label: 'Sales CAGR 3y > 20%', test: s => s.revenueCAGR3y != null && s.revenueCAGR3y > 20 },
      { label: 'Sales CAGR 5y > 18%', test: s => s.revenueCAGR5y != null && s.revenueCAGR5y > 18 },
      { label: 'Profit CAGR 3y > 22%', test: s => s.epsCAGR3y != null && s.epsCAGR3y > 22 },
      { label: 'Profit CAGR 5y > 20%', test: s => s.epsCAGR5y != null && s.epsCAGR5y > 20 },
      { label: 'ROE > 18%', test: s => s.roe != null && s.roe > 18 },
      { label: 'ROCE > 20%', test: s => s.roce != null && s.roce > 20 },
      { label: 'OPM > 15%', test: s => s.operatingMargin != null && s.operatingMargin > 15 },
      { label: 'D/E < 0.3', test: s => s.debtToEquity != null && s.debtToEquity < 30 },
      { label: 'Interest cover > 8', test: s => s.interestCoverage != null && s.interestCoverage > 8 },
      { label: 'Current ratio > 1.5', test: s => s.currentRatio != null && s.currentRatio > 1.5 },
      { label: 'CFO > Net Profit', test: s => s.cfoToProfit != null && s.cfoToProfit >= 100 },
      { label: 'PEG < 1.2', test: s => s.peg != null && s.peg > 0 && s.peg < 1.2 },
      { label: 'P/E < 45', test: s => s.pe != null && s.pe > 0 && s.pe < 45 },
    ],
  },
  smallcap_hunter: {
    label: 'Small-Cap Hunter',
    description: 'Emerging small-caps with explosive, accelerating earnings and clean balance sheets.',
    bonusMax: 15,
    criteria: [
      { label: 'Mcap 200–10000 Cr', test: s => s.marketCap != null && s.marketCap >= 200 * CR && s.marketCap <= 10000 * CR },
      { label: 'Sales CAGR 3y > 25%', test: s => s.revenueCAGR3y != null && s.revenueCAGR3y > 25 },
      { label: 'Profit CAGR 3y > 25%', test: s => s.epsCAGR3y != null && s.epsCAGR3y > 25 },
      { label: 'EPS Q YoY > 30%', test: s => s.epsQtrYoY != null && s.epsQtrYoY > 30 },
      { label: 'Sales Q YoY > 20%', test: s => s.salesQtrYoY != null && s.salesQtrYoY > 20 },
      { label: 'ROCE > 22%', test: s => s.roce != null && s.roce > 22 },
      { label: 'ROE > 20%', test: s => s.roe != null && s.roe > 20 },
      { label: 'D/E < 0.25', test: s => s.debtToEquity != null && s.debtToEquity < 25 },
      { label: 'Current ratio > 1.5', test: s => s.currentRatio != null && s.currentRatio > 1.5 },
      { label: 'CFO > Net Profit', test: s => s.cfoToProfit != null && s.cfoToProfit >= 100 },
      { label: 'PEG < 1', test: s => s.peg != null && s.peg > 0 && s.peg < 1 },
    ],
  },
  emerging_leader: {
    label: 'Emerging Leader',
    description: 'Durable margin leaders: high consistent ROCE, strong OPM, very low leverage.',
    bonusMax: 15,
    criteria: [
      { label: 'Mcap 300–15000 Cr', test: s => s.marketCap != null && s.marketCap >= 300 * CR && s.marketCap <= 15000 * CR },
      { label: 'Sales CAGR 5y > 18%', test: s => s.revenueCAGR5y != null && s.revenueCAGR5y > 18 },
      { label: 'Profit CAGR 5y > 20%', test: s => s.epsCAGR5y != null && s.epsCAGR5y > 20 },
      { label: 'ROCE > 22%', test: s => s.roce != null && s.roce > 22 },
      { label: 'ROE > 20%', test: s => s.roe != null && s.roe > 20 },
      { label: 'D/E < 0.2', test: s => s.debtToEquity != null && s.debtToEquity < 20 },
      { label: 'Interest cover > 10', test: s => s.interestCoverage != null && s.interestCoverage > 10 },
      { label: 'OPM > 18%', test: s => s.operatingMargin != null && s.operatingMargin > 18 },
      { label: 'OPM 5y avg > 18%', test: s => s.opm5yAvg != null && s.opm5yAvg > 18 },
      { label: 'Current ratio > 1.8', test: s => s.currentRatio != null && s.currentRatio > 1.8 },
      { label: 'CFO > Net Profit', test: s => s.cfoToProfit != null && s.cfoToProfit >= 100 },
      { label: 'PEG < 1.1', test: s => s.peg != null && s.peg > 0 && s.peg < 1.1 },
    ],
  },
};

/**
 * Compute how well a snapshot fits a preset. Returns fit %, matched criteria labels,
 * and the soft-boost bonus to add to the composite score.
 * @param {object} snap — FundamentalSnapshot
 * @param {object} preset — entry from SCREEN_PRESETS
 */
export function computePresetFit(snap, preset) {
  if (!preset || !Array.isArray(preset.criteria) || preset.criteria.length === 0) {
    return { fitPct: 0, metCount: 0, total: 0, bonus: 0, matched: [] };
  }
  const matched = [];
  for (const c of preset.criteria) {
    let ok = false;
    try { ok = !!c.test(snap); } catch { ok = false; }
    if (ok) matched.push(c.label);
  }
  const total = preset.criteria.length;
  const metCount = matched.length;
  const fitPct = Math.round((metCount / total) * 100);
  const bonus = Math.round((metCount / total) * (preset.bonusMax || 15));
  return { fitPct, metCount, total, bonus, matched };
}

/**
 * Run the full multibagger screening pipeline.
 *
 * @param {object} opts
 * @param {string} [opts.universe='all'] — 'all' | basket name | array of symbols
 * @param {object} [opts.filters] — Override DEFAULT_FILTERS
 * @param {number} [opts.topN=50] — Number of top results to return
 * @param {number} [opts.concurrency=4] — Parallel Yahoo requests
 * @param {Function} [opts.onProgress] — Progress callback
 * @returns {Promise<object>} Screen results
 */
export async function screenUniverse(opts = {}) {
  const {
    universe = 'all',
    filters = {},
    topN = 50,
    concurrency = 4,
    onProgress,
    preset = null,
  } = opts;

  const mergedFilters = { ...DEFAULT_FILTERS, ...filters };
  const presetDef = preset && SCREEN_PRESETS[preset] ? SCREEN_PRESETS[preset] : null;
  const startTime = Date.now();

  // ── Step 1: Resolve universe ──────────────────────────────────────────
  let symbols;
  let sectorFilter = null; // Yahoo GICS sector label to gate on
  let industryPatterns = null; // Industry keyword patterns for India-specific sectors

  if (Array.isArray(universe)) {
    symbols = universe;
  } else if (isSectorUniverse(universe)) {
    // Dynamic sector universe — prefer DB, fallback to cache-based restriction
    sectorFilter = getSectorLabel(universe);
    industryPatterns = getIndustryMatch(universe);

    if (industryPatterns) {
      // Industry-based sector (Zerodha India-specific) — query DB by industry keywords
      const dbSymbols = await getSymbolsByIndustry(industryPatterns);
      if (dbSymbols && dbSymbols.length > 0) {
        symbols = dbSymbols;
        onProgress?.({ phase: 'sector_restrict', total: dbSymbols.length, restricted: dbSymbols.length, uncached: 0, source: 'database', message: `Industry ${universe}: ${dbSymbols.length} from DB` });
      } else {
        // Fallback: use fundamentals cache to find matching industry symbols
        const cache = getCacheMap();
        const cachedMatches = [];
        const patterns = industryPatterns.map(p => p.toLowerCase());
        for (const [sym, snap] of Object.entries(cache)) {
          if (!sym.startsWith('NSE:')) continue;
          if (snap?.industry) {
            const ind = snap.industry.toLowerCase();
            if (patterns.some(p => ind.includes(p))) cachedMatches.push(sym);
          }
        }
        if (cachedMatches.length > 0) {
          // Found matches in cache — use those + a small sample of uncached for discovery
          symbols = cachedMatches;
          onProgress?.({ phase: 'sector_restrict', total: cachedMatches.length, restricted: cachedMatches.length, uncached: 0, source: 'cache', message: `Industry ${universe}: ${cachedMatches.length} from cache` });
        } else {
          // No cache either — fall back to full universe (first-time scan)
          const fullUniverse = loadNSEUniverse();
          symbols = fullUniverse;
          onProgress?.({ phase: 'sector_restrict', total: fullUniverse.length, restricted: fullUniverse.length, uncached: fullUniverse.length, source: 'full_scan', message: `Industry ${universe}: full scan (no cached data)` });
        }
      }
    } else if (sectorFilter) {
      // GICS sector-based — query DB by sector
      const dbSymbols = await getSymbolsBySector(sectorFilter);
      if (dbSymbols && dbSymbols.length > 0) {
        symbols = dbSymbols;
        onProgress?.({ phase: 'sector_restrict', total: dbSymbols.length, restricted: dbSymbols.length, uncached: 0, source: 'database', message: `Sector ${sectorFilter}: ${dbSymbols.length} from DB` });
      } else {
        // Fallback: cache-based restriction
        const fullUniverse = loadNSEUniverse();
        const { restricted, skippedByCacheMiss } = preSectorRestrict(fullUniverse, sectorFilter);
        symbols = restricted;
        onProgress?.({ phase: 'sector_restrict', total: fullUniverse.length, restricted: symbols.length, uncached: skippedByCacheMiss, source: 'cache', message: `Sector ${sectorFilter}: ${symbols.length} candidates (cache fallback)` });
      }
    } else {
      symbols = loadNSEUniverse();
    }
  } else if (universe === 'all') {
    symbols = loadNSEUniverse();
  } else if (BASKETS[universe]) {
    symbols = getBasket(universe);
  } else {
    symbols = loadNSEUniverse();
  }

  onProgress?.({ phase: 'resolve', total: symbols.length, message: `Universe: ${symbols.length} symbols` });

  // ── Step 1b: DB pre-filter (fast elimination via stored fundamentals) ──
  // If DB has data, apply ALL common filters in one SQL query to dramatically
  // reduce the number of expensive Yahoo API calls needed.
  let dbPreFiltered = null;
  if (symbols.length > 20) { // skip for small baskets
    const dbFilters = {
      symbols: symbols,
      minMarketCap: mergedFilters.minMarketCap || undefined,
      minPrice: mergedFilters.minPrice || undefined,
      maxDebtToEquity: mergedFilters.maxDebtToEquity != null ? mergedFilters.maxDebtToEquity : undefined,
      minROE: mergedFilters.minROE || undefined,
      maxPE: mergedFilters.maxPE || undefined,
    };
    // Add sector/industry from the universe filter if not already sector-restricted
    if (sectorFilter && !industryPatterns) dbFilters.sector = sectorFilter;
    if (industryPatterns) dbFilters.industryPatterns = industryPatterns;

    dbPreFiltered = await preFilterSymbols(dbFilters);
    if (dbPreFiltered && dbPreFiltered.length > 0) {
      // DB had data — use its filtered list. Also include symbols NOT in DB at all
      // (never refreshed) so first-time discoveries aren't missed.
      const dbSet = new Set(dbPreFiltered);

      // Find symbols that are in our universe but NOT returned by the DB query.
      // These are either: (a) in DB but failed filters, or (b) not in DB at all.
      // We want to keep (b) for discovery but exclude (a).
      const notInResult = symbols.filter(s => !dbSet.has(s));

      // Quick check: which of these actually exist in DB (have data_refreshed_at)?
      let discoverySyms = [];
      if (notInResult.length > 0) {
        const existsInDb = await preFilterSymbols({ symbols: notInResult });
        if (existsInDb !== null) {
          // Symbols NOT returned even with no filters = not in DB at all → discovery
          const existsSet = new Set(existsInDb);
          discoverySyms = notInResult.filter(s => !existsSet.has(s));
        } else {
          // DB call failed — include a sample for safety
          discoverySyms = notInResult.slice(0, 50);
        }
      }

      const beforeCount = symbols.length;
      symbols = [...dbPreFiltered, ...discoverySyms];
      const dbExcluded = beforeCount - symbols.length;
      onProgress?.({ phase: 'db_prefilter', excluded: dbExcluded, remaining: symbols.length, discovery: discoverySyms.length, source: 'database', message: `DB pre-filter: ${dbExcluded} eliminated, ${symbols.length} remain (${discoverySyms.length} new)` });
    }
  }

  // ── Step 2: Pre-filter (price + liquidity) ────────────────────────────
  // Skip if DB pre-filter already handled price filtering
  let eligible, preExcluded;
  if (dbPreFiltered && dbPreFiltered.length > 0) {
    // DB already filtered by price + mcap — skip expensive OHLCV pre-filter
    eligible = symbols;
    preExcluded = [];
    onProgress?.({ phase: 'prefilter_done', eligible: eligible.length, excluded: 0, message: 'Pre-filter skipped (DB handled)' });
  } else {
  try {
    const pfResult = await preFilterUniverse(
      symbols,
      { minPrice: mergedFilters.minPrice, minDailyTurnover: mergedFilters.minDailyTurnover },
      {
        concurrency: 8,
        onProgress: (p) => onProgress?.({
          phase: 'prefilter',
          done: p.done,
          total: p.total,
          passed: p.passed,
          message: `Pre-filter: ${p.done}/${p.total} checked, ${p.passed} eligible`,
        }),
      }
    );
    eligible = pfResult.eligible;
    preExcluded = pfResult.excluded;
  } catch (e) {
    // Pre-filter failed (e.g. data provider down) — proceed with full symbol list
    console.error('[screener] pre-filter failed, using full universe:', e.message);
    eligible = symbols;
    preExcluded = [];
  }

  onProgress?.({ phase: 'prefilter_done', eligible: eligible.length, excluded: preExcluded.length });
  }

  // ── Step 2b: Early market-cap exclusion using cached data ─────────────
  // Symbols with KNOWN market cap below threshold (from prior screens) are
  // skipped before the expensive Yahoo API call. Uncached symbols pass through.
  const minMcap = mergedFilters.minMarketCap;
  if (minMcap) {
    const cache = getCacheMap();
    const beforeCount = eligible.length;
    eligible = eligible.filter(sym => {
      const cached = cache[sym];
      if (!cached || cached.marketCap == null) return true; // unknown — keep
      return cached.marketCap >= minMcap;
    });
    const earlyExcluded = beforeCount - eligible.length;
    if (earlyExcluded > 0) {
      onProgress?.({ phase: 'early_mcap', excluded: earlyExcluded, remaining: eligible.length, message: `Early mcap filter: skipped ${earlyExcluded} (cached below ₹${Math.round(minMcap / 1e7)} Cr)` });
    }
  }

  // ── Step 3: Fetch fundamentals ────────────────────────────────────────
  const { results: fundamentalsMap, errors } = await getFundamentalsMany(eligible, {
    concurrency,
    onProgress: (p) => onProgress?.({
      phase: 'fundamentals',
      done: p.done,
      total: p.total,
      symbol: p.symbol,
      success: p.success,
      message: `Fetching fundamentals: ${p.done}/${p.total}`,
    }),
  });

  // ── Step 4: Market-cap filter ─────────────────────────────────────────
  const { passed: mcapFiltered, excluded: mcapExcluded } = filterByMarketCap(
    fundamentalsMap, mergedFilters.minMarketCap
  );

  onProgress?.({
    phase: 'mcap_filter',
    passed: mcapFiltered.size,
    excluded: mcapExcluded.length,
    message: `Market-cap filter: ${mcapFiltered.size} passed, ${mcapExcluded.length} excluded`,
  });

  // ── Step 5: Compute sector medians for relative valuation ─────────────
  const allSnapshots = [...mcapFiltered.values()];
  const sectorMedians = computeSectorMedians(allSnapshots);

  // ── Step 6: Score all ─────────────────────────────────────────────────
  const scored = [];
  for (const [sym, snap] of mcapFiltered) {
    try {
      const medians = sectorMedians.get(snap.sector || 'Unknown') || null;
      const result = scoreFundamentals(snap, medians);

      // Sector gate — if scanning a sector universe, skip non-matching stocks
      if (sectorFilter && !industryPatterns && snap.sector !== sectorFilter) continue;
      // Industry gate — if scanning an industry-based sector, match on industry keywords
      if (industryPatterns && snap.industry) {
        const ind = snap.industry.toLowerCase();
        if (!industryPatterns.some(p => ind.includes(p.toLowerCase()))) continue;
      } else if (industryPatterns && !snap.industry) {
        continue; // No industry data — skip
      }

      // Apply hard filters
      if (mergedFilters.maxDebtToEquity != null && snap.debtToEquity > mergedFilters.maxDebtToEquity) continue;
      if (mergedFilters.minROE != null && (snap.roe == null || snap.roe < mergedFilters.minROE)) continue;
      if (mergedFilters.minFScore != null && result.fScore < mergedFilters.minFScore) continue;
      if (mergedFilters.maxPE != null && snap.pe != null && snap.pe > mergedFilters.maxPE) continue;
      if (mergedFilters.turnaroundOnly && snap.netProfitQoQ != null && snap.netProfitQoQ < 30) continue;

      // Skip insufficient data
      if (snap.dataCompleteness < 30) continue;

    // Preset soft-boost: rank matching stocks higher without excluding others
    let presetFit = null;
    if (presetDef) {
      presetFit = computePresetFit(snap, presetDef);
      if (presetFit.bonus > 0) {
        result.multibaggerScore = Math.min(100, result.multibaggerScore + presetFit.bonus);
        result.tier = result.multibaggerScore >= 75 ? 'strong'
          : result.multibaggerScore >= 60 ? 'good'
          : result.multibaggerScore >= 45 ? 'neutral'
          : result.multibaggerScore >= 30 ? 'weak' : 'avoid';
      }
    }

    scored.push({ ...result, snapshot: snap, sectorMedianPe: medians?.pe || null, sectorMedianPb: medians?.pb || null, presetFit });
    } catch (e) {
      // Single stock scoring failure should never kill the entire screen
      continue;
    }
  }

  // ── Step 7: Rank (return all, no topN cap) ────────────────────────────
  scored.sort((a, b) => b.multibaggerScore - a.multibaggerScore);
  const topResults = topN > 0 ? scored.slice(0, topN) : scored;

  onProgress?.({
    phase: 'complete',
    total: symbols.length,
    eligible: eligible.length,
    scored: scored.length,
    topN: topResults.length,
    message: `Screening complete: ${topResults.length} top picks from ${scored.length} scored`,
  });

  const elapsed = Date.now() - startTime;

  return {
    success: true,
    results: topResults,
    meta: {
      universeSize: symbols.length,
      dbPreFiltered: dbPreFiltered ? dbPreFiltered.length : null,
      preFiltered: eligible.length,
      fundamentalsFetched: fundamentalsMap.size,
      fundamentalsErrors: errors.size,
      mcapFiltered: mcapFiltered.size,
      scored: scored.length,
      topN: topResults.length,
      filters: mergedFilters,
      preset: presetDef ? preset : null,
      elapsedMs: elapsed,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Quick screen — use a pre-defined basket for fast results.
 */
export async function quickScreen(basket = 'large_cap', opts = {}) {
  const symbols = getBasket(basket);
  return screenUniverse({ ...opts, universe: symbols, topN: opts.topN || 0 }); // 0 = return all
}

/**
 * Score a single symbol (for detail/analysis view).
 */
export async function scoreSymbol(symbol, sectorMedians = null) {
  const snap = await getFundamentals(symbol);
  const result = scoreFundamentals(snap, sectorMedians);
  return { ...result, snapshot: snap };
}

export default { screenUniverse, quickScreen, scoreSymbol, SCREEN_PRESETS, computePresetFit };
