/**
 * Shared provider types and constants.
 *
 * All providers must return data in this canonical shape so the strategy
 * engine never has to care where bars came from.
 */

/**
 * @typedef {Object} OHLCBar
 * @property {number} time   - Unix timestamp in seconds (bar OPEN time).
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume
 */

/**
 * @typedef {Object} HistoricalRequest
 * @property {string} symbol      - Canonical symbol (e.g. 'NSE:RELIANCE', 'AAPL', 'BINANCE:BTCUSDT').
 * @property {string} timeframe   - One of TIMEFRAMES.
 * @property {Date|string|number} from - Inclusive start (Date, ISO string, or unix ms).
 * @property {Date|string|number} [to] - Inclusive end (defaults to now).
 * @property {number} [limit]     - Optional max bars (newest-first cap).
 * @property {boolean} [noCache]  - Skip cache read/write.
 */

/**
 * @typedef {Object} HistoricalResult
 * @property {string} symbol
 * @property {string} timeframe
 * @property {OHLCBar[]} bars     - Ascending time order.
 * @property {string} provider    - 'upstox' | 'yahoo' | 'cdp'
 * @property {boolean} cached     - True if any portion served from disk cache.
 * @property {number} fetchedAt   - Unix ms when data was last fetched live.
 */

/**
 * @typedef {Object} SymbolSearchResult
 * @property {string} symbol      - Canonical form (e.g. 'NSE:RELIANCE')
 * @property {string} name
 * @property {string} exchange
 * @property {string} type        - 'equity' | 'etf' | 'futures' | 'option' | 'index' | 'crypto'
 */

/**
 * @typedef {Object} Tick
 * @property {string} symbol
 * @property {number} time        - Unix ms
 * @property {number} ltp         - Last traded price
 * @property {number} [bid]
 * @property {number} [ask]
 * @property {number} [volume]
 */

/**
 * Canonical timeframe codes used everywhere in the engine.
 */
export const TIMEFRAMES = Object.freeze([
  '1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M',
]);

/**
 * Bar duration in seconds for each timeframe code.
 */
export const TIMEFRAME_SECONDS = Object.freeze({
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1D': 86400,
  '1W': 604800,
  '1M': 2592000, // ~30 days
});

/**
 * Convert a TIMEFRAMES code into a stable cache file segment.
 */
export function tfKey(tf) {
  return String(tf).toLowerCase();
}

/**
 * Coerce any from/to value into unix seconds.
 */
export function toUnixSec(t) {
  if (t === undefined || t === null) return null;
  if (t instanceof Date) return Math.floor(t.getTime() / 1000);
  if (typeof t === 'number') {
    // Heuristic: > 10^12 means ms
    return t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
  }
  const ms = Date.parse(String(t));
  if (Number.isNaN(ms)) throw new Error(`Invalid time: ${t}`);
  return Math.floor(ms / 1000);
}

/**
 * Parse a canonical "EXCHANGE:TICKER" symbol.
 * Returns { exchange, ticker, raw } where exchange is null for bare tickers.
 */
export function parseSymbol(symbol) {
  const raw = String(symbol).trim();
  const idx = raw.indexOf(':');
  if (idx === -1) return { exchange: null, ticker: raw.toUpperCase(), raw };
  return {
    exchange: raw.slice(0, idx).toUpperCase(),
    ticker: raw.slice(idx + 1).toUpperCase(),
    raw,
  };
}

/**
 * Sort bars ascending by time and drop duplicates.
 */
export function normalizeBars(bars) {
  const seen = new Set();
  const out = [];
  for (const b of bars) {
    if (!b || typeof b.time !== 'number') continue;
    if (seen.has(b.time)) continue;
    seen.add(b.time);
    out.push({
      time: b.time,
      open: Number(b.open) || 0,
      high: Number(b.high) || 0,
      low: Number(b.low) || 0,
      close: Number(b.close) || 0,
      volume: Number(b.volume) || 0,
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}
