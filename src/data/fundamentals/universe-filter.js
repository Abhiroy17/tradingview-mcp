/**
 * Universe pre-filter for multibagger screener.
 *
 * Filters the full NSE_EQ instrument universe BEFORE fetching fundamentals,
 * cutting API load substantially:
 * - Price ≥ ₹50 (penny-stock exclusion)
 * - Avg daily traded value ≥ ₹1 Cr (liquidity/investability)
 * - Market-cap floor applied post-fundamentals (requires Yahoo data)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHistorical } from '../providers/router.js';
import { getCacheMap } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', '..', '..', '.data');
const INSTRUMENTS_FILE = path.join(DATA_DIR, 'upstox-instruments.json');

// ── Default filter thresholds ─────────────────────────────────────────────

export const DEFAULT_FILTERS = Object.freeze({
  minPrice: 50,             // ₹50 hard penny-stock floor
  minDailyTurnover: 1e7,   // ₹1 Cr avg daily traded value
  minMarketCap: 1e10,       // ₹1000 Cr (applied post-fundamentals)
  maxDebtToEquity: null,    // Optional: e.g. 200
  minROE: null,             // Optional: e.g. 10
  minFScore: null,          // Optional: e.g. 5
  excludeDeclinigPromoter: false,
  turnaroundOnly: false,
});

/**
 * Load the full NSE_EQ instrument universe from .data/upstox-instruments.json.
 * Returns array of canonical "NSE:TICKER" symbols. Cached after first load.
 */
let _universeCache = null;
let _universeCacheMtime = 0;

export function loadNSEUniverse() {
  if (!fs.existsSync(INSTRUMENTS_FILE)) {
    throw new Error(
      `Instrument file not found: ${INSTRUMENTS_FILE}. ` +
      `Run 'npm run upstox:instruments' to download the NSE instrument master.`
    );
  }
  // Return cached if file hasn't changed
  const mtime = fs.statSync(INSTRUMENTS_FILE).mtimeMs;
  if (_universeCache && mtime === _universeCacheMtime) return _universeCache;

  const instruments = JSON.parse(fs.readFileSync(INSTRUMENTS_FILE, 'utf-8'));
  // instruments is a map: { "NSE:TICKER": { instrumentKey, name, ... } }
  // Filter to equity-only: exclude bonds/debentures (numeric prefixes like 756KA36, 736SBI39),
  // government securities, and other non-equity instruments
  const BOND_PATTERN = /^NSE:\d/; // Bonds/debentures start with digits (e.g., NSE:756KA36)
  _universeCache = Object.keys(instruments)
    .filter(sym => sym.startsWith('NSE:'))
    .filter(sym => {
      const ticker = sym.slice(4);
      // Exclude bonds/debentures: start with digits or have patterns like 756KA36, 736SBI39
      if (BOND_PATTERN.test(sym)) return false;
      // Exclude tickers that look like bonds: all-caps+digits (e.g., 686REC35, 702RECL40)
      if (/^\d+[A-Z]+\d+$/.test(ticker)) return false;
      return true;
    });
  _universeCacheMtime = mtime;
  return _universeCache;
}

/**
 * Get universe count without loading full data.
 */
export function getUniverseInfo() {
  try {
    const symbols = loadNSEUniverse();
    const mtime = fs.statSync(INSTRUMENTS_FILE).mtime;
    return { count: symbols.length, lastUpdated: mtime.toISOString(), file: INSTRUMENTS_FILE };
  } catch (e) {
    return { count: 0, lastUpdated: null, error: e.message };
  }
}

/**
 * Pre-filter universe by price and liquidity using cached OHLCV data.
 * This is cheap — uses existing getHistorical with caching.
 *
 * @param {string[]} symbols — Full universe
 * @param {object} filters — { minPrice, minDailyTurnover }
 * @param {object} [opts]
 * @param {number} [opts.concurrency=8] — Parallel price checks
 * @param {Function} [opts.onProgress] — ({done, total, passed, symbol}) => void
 * @returns {Promise<{eligible: string[], excluded: {symbol, reason}[]}>}
 */
export async function preFilterUniverse(symbols, filters = {}, opts = {}) {
  const { minPrice = 50, minDailyTurnover = 1e7 } = filters;
  const { concurrency = 8, onProgress } = opts;

  const eligible = [];
  const excluded = [];
  let done = 0;
  const total = symbols.length;

  const queue = [...symbols];

  async function worker() {
    while (queue.length > 0) {
      const sym = queue.shift();
      if (!sym) break;

      try {
        // Fetch last 20 daily bars (cheap, cached)
        const { bars } = await getHistorical({
          symbol: sym,
          timeframe: '1D',
          limit: 20,
        });

        if (!bars || bars.length === 0) {
          excluded.push({ symbol: sym, reason: 'no_data' });
          done++;
          onProgress?.({ done, total, passed: eligible.length, symbol: sym });
          continue;
        }

        // Last close price
        const lastClose = bars[bars.length - 1].close;
        if (lastClose < minPrice) {
          excluded.push({ symbol: sym, reason: `price_${lastClose.toFixed(1)}_below_${minPrice}` });
          done++;
          onProgress?.({ done, total, passed: eligible.length, symbol: sym });
          continue;
        }

        // Average daily traded value (close × volume over available bars)
        const tradedValues = bars.map(b => b.close * b.volume).filter(v => v > 0);
        const avgTurnover = tradedValues.length > 0
          ? tradedValues.reduce((s, v) => s + v, 0) / tradedValues.length
          : 0;

        if (avgTurnover < minDailyTurnover) {
          excluded.push({ symbol: sym, reason: `turnover_${(avgTurnover / 1e7).toFixed(1)}Cr_below_${(minDailyTurnover / 1e7).toFixed(1)}Cr` });
          done++;
          onProgress?.({ done, total, passed: eligible.length, symbol: sym });
          continue;
        }

        eligible.push(sym);
        done++;
        onProgress?.({ done, total, passed: eligible.length, symbol: sym });
      } catch {
        excluded.push({ symbol: sym, reason: 'fetch_error' });
        done++;
        onProgress?.({ done, total, passed: eligible.length, symbol: sym });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, symbols.length) }, () => worker());
  await Promise.all(workers);

  return { eligible, excluded };
}

/**
 * Post-fundamentals market-cap filter.
 * @param {Map<string, object>} fundamentals — symbol → FundamentalSnapshot
 * @param {number} minMarketCap — in raw number (e.g. 5e9 for ₹500 Cr)
 * @returns {{passed: Map<string, object>, excluded: string[]}}
 */
export function filterByMarketCap(fundamentals, minMarketCap = 1e10) {
  const passed = new Map();
  const excluded = [];
  for (const [sym, data] of fundamentals) {
    if (data.marketCap && data.marketCap >= minMarketCap) {
      passed.set(sym, data);
    } else {
      excluded.push(sym);
    }
  }
  return { passed, excluded };
}

/**
 * Use the fundamentals cache as a sector index to pre-restrict symbols.
 * Symbols already cached as a DIFFERENT sector are dropped (efficiency win).
 * Uncached symbols are kept (they might be the target sector — we don't know yet).
 *
 * @param {string[]} symbols — Full NSE universe
 * @param {string} targetSector — Yahoo GICS sector label (e.g. "Healthcare")
 * @returns {{restricted: string[], skippedByCacheMiss: number}}
 */
export function preSectorRestrict(symbols, targetSector) {
  // Use in-memory cache (already loaded by fundamentals index) to avoid re-reading disk
  const cache = getCacheMap();

  const restricted = [];
  let skippedByCacheMiss = 0;
  let skippedWrongSector = 0;
  for (const sym of symbols) {
    const cached = cache[sym];
    if (cached && cached.sector) {
      // Known sector: keep only if matches target
      if (cached.sector === targetSector) {
        restricted.push(sym);
      } else {
        skippedWrongSector++;
      }
    } else {
      // Not cached — skip for sector scans (user should run full scan first to populate cache)
      // Only keep uncached if cache is very sparse (< 100 entries = fresh install)
      skippedByCacheMiss++;
    }
  }

  // If cache is too sparse (< 100 cached entries), fall back to full universe
  // so first-time users still get results (albeit slower)
  const cachedCount = Object.keys(cache).length;
  if (cachedCount < 100) {
    return { restricted: symbols, skippedByCacheMiss: symbols.length, skippedWrongSector: 0 };
  }

  return { restricted, skippedByCacheMiss, skippedWrongSector };
}

export default { loadNSEUniverse, getUniverseInfo, preFilterUniverse, filterByMarketCap, preSectorRestrict, DEFAULT_FILTERS };
