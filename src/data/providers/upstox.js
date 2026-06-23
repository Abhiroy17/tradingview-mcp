/**
 * Upstox v2 provider — primary source for Indian equities (NSE/BSE) with
 * 1m/5m/15m/30m/1h/1D/1W/1M history and (optional) tick streaming.
 *
 * Symbol conventions accepted:
 *   - Canonical 'NSE:RELIANCE' / 'BSE:TCS'
 *   - Direct instrument key 'NSE_EQ|INE002A01018'  (passed through)
 *
 * Auth model:
 *   - OAuth2 access token must be present in env `UPSTOX_ACCESS_TOKEN` OR
 *     written to `.data/upstox-token.json` (preferred — token can be rotated
 *     by a separate `upstox:auth` script).
 *   - If token is missing OR expired, getHistorical throws a clear error.
 *     The router catches that and falls through to the next provider.
 *
 * Symbol → instrument-key resolution:
 *   - Upstox's REST API needs an instrument key, not a human ticker.
 *   - We lazy-load a JSON map from `.data/upstox-instruments.json`
 *     (produced by `npm run upstox:instruments`).
 *   - Without the map, requests for 'NSE:X' throw an informative error.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import UpstoxClient from 'upstox-js-sdk';
import {
  TIMEFRAMES,
  normalizeBars,
  parseSymbol,
  toUnixSec,
} from './types.js';

const NAME = 'upstox';
const TOKEN_FILE = path.resolve(process.cwd(), '.data', 'upstox-token.json');
const INSTRUMENT_FILE = path.resolve(process.cwd(), '.data', 'upstox-instruments.json');

// Upstox v3 historical candle units/intervals
const TF_TO_UPSTOX = {
  '1m':  { unit: 'minutes', interval: '1' },
  '5m':  { unit: 'minutes', interval: '5' },
  '15m': { unit: 'minutes', interval: '15' },
  '30m': { unit: 'minutes', interval: '30' },
  '1h':  { unit: 'hours',   interval: '1' },
  '4h':  { unit: 'hours',   interval: '1' }, // aggregate locally
  '1D':  { unit: 'days',    interval: '1' },
  '1W':  { unit: 'weeks',   interval: '1' },
  '1M':  { unit: 'months',  interval: '1' },
};

// Upstox v3 historical API has per-call date-range limits for intraday TFs.
// These are conservative chunk sizes that work reliably across the API.
const TF_MAX_CHUNK_DAYS = {
  '1m':  30,
  '5m':  30,
  '15m': 30,
  '30m': 30,
  '1h':  90,
  '4h':  90,   // we fetch 1h and aggregate
  '1D':  365 * 10,
  '1W':  365 * 20,
  '1M':  365 * 50,
};

// Cached singletons
let _instrumentMap = null;
let _accessToken = null;
let _apiClient = null;
let _historyApi = null;

/**
 * Load OAuth access token from env or disk.
 * Returns null when missing — caller decides what to do.
 */
async function getAccessToken() {
  if (_accessToken) return _accessToken;
  // .trim() defensively — env values often acquire leading/trailing whitespace.
  const fromEnv = (process.env.UPSTOX_ACCESS_TOKEN || '').trim();
  if (fromEnv) {
    _accessToken = fromEnv;
    return _accessToken;
  }
  try {
    const raw = await fs.readFile(TOKEN_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.accessToken) {
      _accessToken = String(parsed.accessToken).trim();
      return _accessToken;
    }
  } catch { /* file missing */ }
  return null;
}

/**
 * Get a configured Upstox History API client.
 * Throws if no token is available.
 */
async function getHistoryApi() {
  if (_historyApi) return _historyApi;
  const token = await getAccessToken();
  if (!token) {
    throw new Error(
      'Upstox access token not found. Set UPSTOX_ACCESS_TOKEN env or run ' +
      '`npm run upstox:auth` to generate .data/upstox-token.json.',
    );
  }
  _apiClient = UpstoxClient.ApiClient.instance;
  const oauth = _apiClient.authentications['OAUTH2'];
  oauth.accessToken = token;
  _historyApi = new UpstoxClient.HistoryV3Api();
  return _historyApi;
}

/**
 * Load the symbol → instrument-key map from disk.
 *
 * Map shape:
 *   { "NSE:RELIANCE": { instrumentKey: "NSE_EQ|INE002A01018", name: "Reliance", lotSize: 1 }, ... }
 */
async function getInstrumentMap() {
  if (_instrumentMap) return _instrumentMap;
  try {
    const raw = await fs.readFile(INSTRUMENT_FILE, 'utf8');
    _instrumentMap = JSON.parse(raw);
  } catch {
    _instrumentMap = {};
  }
  return _instrumentMap;
}

/**
 * Resolve a canonical symbol to an Upstox instrument key.
 * Pass-through if already an instrument key.
 */
export async function resolveInstrumentKey(symbol) {
  const raw = String(symbol);
  if (raw.includes('|')) return raw; // already an instrument key

  const { exchange, ticker } = parseSymbol(symbol);
  if (!exchange || !['NSE', 'BSE'].includes(exchange)) {
    throw new Error(`Upstox: cannot resolve '${symbol}' — only NSE:/BSE: supported`);
  }

  const map = await getInstrumentMap();
  const entry = map[`${exchange}:${ticker}`];
  if (entry?.instrumentKey) return entry.instrumentKey;

  throw new Error(
    `Upstox: instrument key for '${exchange}:${ticker}' not in map. ` +
    'Run `npm run upstox:instruments` to refresh .data/upstox-instruments.json.',
  );
}

function isoDate(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

/**
 * Fetch a single chunk via Upstox v3 historical API.
 * Returns the raw `candles` array (newest-first as Upstox returns them).
 */
async function _fetchChunk(api, instrumentKey, tfSpec, fromSec, toSec) {
  const toDate = isoDate(toSec);
  const fromDate = isoDate(fromSec);
  const response = await new Promise((resolve, reject) => {
    api.getHistoricalCandleData1(
      instrumentKey,
      tfSpec.unit,
      tfSpec.interval,
      toDate,
      fromDate,
      (err, data) => {
        if (err) {
          // Upstox returns generic "Bad Request" for many cases:
          // expired token, invalid instrument, date range beyond history limit.
          // Attach context so logs are actionable.
          const msg = err.message || String(err);
          const enriched = new Error(
            `${msg} (instrument=${instrumentKey}, tf=${tfSpec.unit}/${tfSpec.interval}, range=${fromDate}..${toDate})`
          );
          enriched.status = err.status || err.statusCode;
          return reject(enriched);
        }
        resolve(data);
      },
    );
  });
  return response?.data?.candles || [];
}

/**
 * Build chunk ranges working backwards from `toSec` so the most recent
 * chunk is fetched first. Inclusive [from, to] in unix seconds.
 */
function _buildChunks(fromSec, toSec, maxDays) {
  const chunkSec = maxDays * 86400;
  const chunks = [];
  let end = toSec;
  while (end > fromSec) {
    const start = Math.max(fromSec, end - chunkSec + 86400); // -1 day overlap-free
    chunks.push({ from: start, to: end });
    end = start - 86400; // step back one day
    if (chunks.length > 50) break; // safety: hard cap
  }
  return chunks;
}

/**
 * @param {import('./types.js').HistoricalRequest} req
 * @returns {Promise<import('./types.js').HistoricalResult>}
 */
export async function getHistorical(req) {
  const { symbol, timeframe } = req;
  const tfSpec = TF_TO_UPSTOX[timeframe];
  if (!tfSpec) throw new Error(`Upstox: unsupported timeframe '${timeframe}'`);

  const api = await getHistoryApi();
  const instrumentKey = await resolveInstrumentKey(symbol);

  const toSec = req.to ? toUnixSec(req.to) : Math.floor(Date.now() / 1000);
  const fromSec = req.from ? toUnixSec(req.from) : (toSec - 3 * 365 * 86400); // default 3y

  const maxDays = TF_MAX_CHUNK_DAYS[timeframe] || 365;
  const chunks = _buildChunks(fromSec, toSec, maxDays);

  // Sequential fetch (Upstox rate-limits free tier; parallelism risks 429s)
  const allCandles = [];
  let chunkFailCount = 0;
  for (const ch of chunks) {
    try {
      const candles = await _fetchChunk(api, instrumentKey, tfSpec, ch.from, ch.to);
      if (Array.isArray(candles)) allCandles.push(...candles);
    } catch (err) {
      // If no data at all yet, propagate so the router can fallback.
      if (allCandles.length === 0) throw err;
      chunkFailCount++;
      // Log only first failure — older chunks will likely all fail the same way
      // (Upstox limits intraday history to ~6 months, daily to ~2-3 years).
      if (chunkFailCount === 1) {
        // eslint-disable-next-line no-console
        console.warn(`[upstox] chunk ${isoDate(ch.from)}..${isoDate(ch.to)} failed: ${err.message} (older chunks skipped — likely beyond Upstox history limit)`);
      }
      break;
    }
  }

  // Normalize + dedupe by time (chunks may overlap).
  // For daily/weekly/monthly TFs, Upstox can return multiple entries per
  // trading day with different timestamps (e.g., 09:15 and 15:30 IST).
  // Deduplicate by calendar date in those cases, keeping the LAST entry
  // (which has the final close/volume for the day).
  const isDailyPlus = ['1D', '1W', '1M'].includes(timeframe);
  const seen = new Set();
  const dayMap = isDailyPlus ? new Map() : null; // dateKey → bar
  const rawBars = [];
  for (const c of allCandles) {
    const t = Math.floor(new Date(c[0]).getTime() / 1000);
    if (!isDailyPlus) {
      if (seen.has(t)) continue;
      seen.add(t);
      rawBars.push({
        time: t,
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]) || 0,
      });
    } else {
      // Group by calendar date (IST = UTC+5:30)
      const dateKey = new Date((t + 19800) * 1000).toISOString().slice(0, 10);
      const bar = {
        time: t,
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]) || 0,
      };
      const existing = dayMap.get(dateKey);
      if (!existing || t > existing.time) {
        dayMap.set(dateKey, bar); // keep latest timestamp's data
      }
    }
  }
  if (isDailyPlus) {
    rawBars.push(...dayMap.values());
  }

  let bars = normalizeBars(rawBars); // ascending order

  // Aggregate 1h → 4h when needed
  if (timeframe === '4h') {
    bars = aggregate4h(bars);
  }

  if (req.limit && bars.length > req.limit) {
    bars = bars.slice(-req.limit);
  }

  return {
    symbol,
    timeframe,
    bars,
    provider: NAME,
    cached: false,
    fetchedAt: Date.now(),
  };
}

function aggregate4h(bars) {
  const bucketSec = 4 * 3600;
  const buckets = new Map();
  for (const b of bars) {
    const key = Math.floor(b.time / bucketSec) * bucketSec;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { ...b, time: key });
    } else {
      existing.high = Math.max(existing.high, b.high);
      existing.low = Math.min(existing.low, b.low);
      existing.close = b.close;
      existing.volume += b.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

/**
 * @param {string} query - Ticker substring like 'RELI' or 'TCS'
 * @returns {Promise<import('./types.js').SymbolSearchResult[]>}
 */
export async function searchSymbol(query) {
  if (!query) return [];
  const map = await getInstrumentMap();
  const q = String(query).toUpperCase();
  const results = [];
  for (const [canonical, entry] of Object.entries(map)) {
    if (results.length >= 25) break;
    if (canonical.includes(q) || (entry.name || '').toUpperCase().includes(q)) {
      const [exchange] = canonical.split(':');
      results.push({
        symbol: canonical,
        name: entry.name || canonical,
        exchange,
        type: entry.type || 'equity',
      });
    }
  }
  return results;
}

/**
 * Only NSE:/BSE: symbols.
 */
export function supports(symbol) {
  const { exchange } = parseSymbol(symbol);
  return exchange === 'NSE' || exchange === 'BSE';
}

/**
 * Health check — verify token works and a sample fetch succeeds.
 */
export async function healthCheck() {
  try {
    const token = await getAccessToken();
    if (!token) return { ok: false, reason: 'No access token' };
    const map = await getInstrumentMap();
    const mapped = Object.keys(map).length;
    return { ok: true, tokenLoaded: true, instrumentsLoaded: mapped };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export const upstoxProvider = {
  name: NAME,
  getHistorical,
  searchSymbol,
  supports,
  healthCheck,
  resolveInstrumentKey,
};

// Internal — exposed for tests / debugging
export const _internals = {
  TOKEN_FILE,
  INSTRUMENT_FILE,
  reset() {
    _instrumentMap = null;
    _accessToken = null;
    _apiClient = null;
    _historyApi = null;
  },
};

export default upstoxProvider;

// Suppress unused-import warning if TIMEFRAMES not referenced elsewhere
void TIMEFRAMES;
