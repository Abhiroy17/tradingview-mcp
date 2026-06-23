/**
 * Provider router — picks the right data source for a symbol with cache + fallback.
 *
 * Routing rules:
 *   - NSE:* / BSE:*                      → Upstox  (fallback: Yahoo .NS/.BO)
 *   - NASDAQ:* / NYSE:* / AMEX:* / bare  → Yahoo   (fallback: none)
 *   - FX:* / FOREX:*                     → Yahoo
 *   - CRYPTO:* / BINANCE:*USDT           → Yahoo (-USD) (fallback: none)
 *   - anything else                      → CDP    (last-resort)
 *
 * Public entry: `getHistorical(req)` — checks disk cache, computes missing
 * range, fetches live only for the gap, merges, writes back, returns the
 * requested slice.
 */

import upstoxProvider from './upstox.js';
import yahooProvider from './yahoo.js';
import cdpProvider from './cdp.js';
import {
  TIMEFRAME_SECONDS,
  parseSymbol,
  normalizeBars,
  toUnixSec,
} from './types.js';
import {
  readCache, writeCache, mergeBars, sliceBars, isFresh, missingRange,
} from './cache.js';

/**
 * Provider priority list per symbol category.
 * First entry is preferred; subsequent entries are fallbacks.
 *
 * Note: CDP is intentionally excluded from the auto-fallback chain.
 * It is reserved for explicit live-chart reads (`cdpProvider.getHistorical()`).
 * Returning whatever-chart-shows for an unrelated symbol would be misleading.
 */
function providersFor(symbol) {
  const { exchange } = parseSymbol(symbol);
  switch (exchange) {
    case 'NSE':
    case 'BSE':
      return [upstoxProvider, yahooProvider];
    case 'NASDAQ':
    case 'NYSE':
    case 'AMEX':
    case 'FX':
    case 'FOREX':
    case 'CRYPTO':
    case 'BINANCE':
      return [yahooProvider];
    case null:
    case undefined:
      // bare ticker → assume US equity via Yahoo
      return [yahooProvider];
    default:
      return [yahooProvider];
  }
}

/**
 * Default lookback in seconds when caller doesn't provide `from`.
 */
function defaultFromSec(timeframe, toSec) {
  const sec = TIMEFRAME_SECONDS[timeframe] || 86400;
  // Aim for ~3 years on daily/weekly, ~60 days on intraday, ~7 days on 1m
  if (timeframe === '1m') return toSec - 7 * 86400;
  if (sec < 86400) return toSec - 60 * 86400;
  return toSec - 3 * 365 * 86400;
}

/**
 * Main entry — fetch historical bars with cache + fallback.
 *
 * @param {import('./types.js').HistoricalRequest} req
 * @returns {Promise<import('./types.js').HistoricalResult>}
 */
export async function getHistorical(req) {
  const symbol = String(req.symbol || '').trim();
  if (!symbol) throw new Error('Symbol is required');
  const timeframe = req.timeframe || '1D';
  if (!TIMEFRAME_SECONDS[timeframe]) throw new Error(`Unknown timeframe '${timeframe}'`);

  const toSec = req.to ? toUnixSec(req.to) : Math.floor(Date.now() / 1000);
  const fromSec = req.from ? toUnixSec(req.from) : defaultFromSec(timeframe, toSec);

  const providers = providersFor(symbol);
  const primary = providers[0];

  // 1. Try cache (keyed by primary provider name + symbol + tf)
  let cachedBars = [];
  let cachedFetchedAt = 0;
  if (!req.noCache) {
    const cached = await readCache(primary.name, symbol, timeframe);
    cachedBars = cached.bars;
    cachedFetchedAt = cached.fetchedAt;
  }

  // 2. Decide whether to fetch live
  const hole = missingRange(cachedBars, fromSec, toSec);
  const fresh = isFresh(timeframe, cachedFetchedAt, toSec);

  if (!hole && fresh) {
    // Cache fully covers request and is fresh → no network
    const bars = sliceBars(cachedBars, fromSec, toSec);
    return {
      symbol,
      timeframe,
      bars: req.limit ? bars.slice(-req.limit) : bars,
      provider: primary.name,
      cached: true,
      fetchedAt: cachedFetchedAt,
    };
  }

  // 3. Live fetch — try providers in order until one succeeds for the missing range
  const liveReq = {
    ...req,
    from: hole ? hole.from : fromSec,
    to: hole ? hole.to : toSec,
  };

  let fetched = null;
  let lastErr = null;
  for (const provider of providers) {
    if (!provider.supports(symbol)) continue;
    try {
      fetched = await provider.getHistorical(liveReq);
      // Stamp the result with the *primary* provider's cache key
      // (so subsequent reads find it even if fallback served this time)
      fetched.provider = provider.name;
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!fetched) {
    // If we have cached data, return what we have rather than failing
    if (cachedBars.length) {
      const bars = sliceBars(cachedBars, fromSec, toSec);
      return {
        symbol,
        timeframe,
        bars: req.limit ? bars.slice(-req.limit) : bars,
        provider: primary.name,
        cached: true,
        fetchedAt: cachedFetchedAt,
        warning: `All providers failed; returning stale cache. Last error: ${lastErr?.message || 'unknown'}`,
      };
    }
    throw lastErr || new Error(`No provider could serve ${symbol}`);
  }

  // 4. Merge cache + live, write back, return sliced
  const merged = mergeBars(cachedBars, fetched.bars);
  if (!req.noCache && merged.length) {
    // Cache under primary provider's key so future reads hit
    await writeCache(primary.name, symbol, timeframe, merged);
  }

  let outBars = sliceBars(merged, fromSec, toSec);
  if (req.limit && outBars.length > req.limit) outBars = outBars.slice(-req.limit);

  return {
    symbol,
    timeframe,
    bars: outBars,
    provider: fetched.provider,
    cached: cachedBars.length > 0,
    fetchedAt: Date.now(),
  };
}

/**
 * Search across all providers; deduplicate by canonical symbol.
 */
export async function searchSymbol(query, { exchanges } = {}) {
  if (!query) return [];

  const tasks = [];
  if (!exchanges || exchanges.includes('NSE') || exchanges.includes('BSE')) {
    tasks.push(upstoxProvider.searchSymbol(query).catch(() => []));
  }
  tasks.push(yahooProvider.searchSymbol(query).catch(() => []));

  const allResults = (await Promise.all(tasks)).flat();
  const seen = new Set();
  const out = [];
  for (const r of allResults) {
    if (seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    out.push(r);
    if (out.length >= 25) break;
  }
  return out;
}

/**
 * Convenience: ranked list of providers attempted for a symbol.
 */
export function describeRouting(symbol) {
  const providers = providersFor(symbol);
  return providers.map(p => p.name);
}

export const _internals = { providersFor };
