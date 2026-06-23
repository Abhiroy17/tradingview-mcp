/**
 * Yahoo Finance provider — for US equities, global ETFs, FX, crypto.
 *
 * Uses `yahoo-finance2` (zero auth). Good for daily/weekly history (decades back)
 * and intraday up to ~60 days (Yahoo limit).
 *
 * Symbol conventions accepted:
 *   - Bare ticker          : 'AAPL', 'SPY', 'QQQ', 'TSLA'
 *   - Crypto pair          : 'BTC-USD', 'ETH-USD'
 *   - FX                   : 'EURUSD=X', 'INR=X'
 *   - Yahoo-suffixed       : 'RELIANCE.NS' (NSE), 'TCS.BO' (BSE)
 *   - Canonical 'NSE:X'    : auto-mapped to 'X.NS'
 *   - Canonical 'BSE:X'    : auto-mapped to 'X.BO'
 *
 * Skipped for: tick streaming (Yahoo has no real WS), full-tick intraday <1m.
 */

import YahooFinance from 'yahoo-finance2';
import { TIMEFRAME_SECONDS, normalizeBars, parseSymbol, toUnixSec } from './types.js';

const NAME = 'yahoo';

// v3 is class-based — instantiate once and reuse
const yahooFinance = new YahooFinance({
  // Use Yahoo's CrumbAPI when needed; surface no validation errors as throws
  validation: { logErrors: false },
});
// Silence chatty startup notices (no-op on older versions)
try { yahooFinance.suppressNotices(['yahooSurvey', 'ripHistorical']); } catch { /* not in this version */ }

const TF_TO_YAHOO = {
  '1m':  { interval: '1m',  unit: 'm' },
  '5m':  { interval: '5m',  unit: 'm' },
  '15m': { interval: '15m', unit: 'm' },
  '30m': { interval: '30m', unit: 'm' },
  '1h':  { interval: '60m', unit: 'm' },
  '4h':  { interval: '60m', unit: 'm' }, // Yahoo has no 4h — caller can aggregate
  '1D':  { interval: '1d',  unit: 'd' },
  '1W':  { interval: '1wk', unit: 'd' },
  '1M':  { interval: '1mo', unit: 'd' },
};

// Yahoo intraday history is capped to ~60 days (varies by interval).
// Daily/weekly/monthly is effectively unlimited (back to listing date).
const INTRADAY_LIMIT_DAYS = {
  '1m':  7,
  '5m':  60,
  '15m': 60,
  '30m': 60,
  '1h':  730,
  '4h':  730,
};

/**
 * Convert a canonical symbol into a Yahoo-style ticker.
 */
export function toYahooSymbol(symbol) {
  const { exchange, ticker, raw } = parseSymbol(symbol);
  if (!exchange) return raw;
  if (exchange === 'NSE') return `${ticker}.NS`;
  if (exchange === 'BSE') return `${ticker}.BO`;
  if (exchange === 'NASDAQ' || exchange === 'NYSE' || exchange === 'AMEX') return ticker;
  // Forex pair like FX:EURUSD → EURUSD=X
  if (exchange === 'FX' || exchange === 'FOREX') return `${ticker}=X`;
  // Crypto BINANCE:BTCUSDT → BTC-USD (best effort)
  if (exchange === 'BINANCE' && /USDT$/.test(ticker)) return `${ticker.replace(/USDT$/, '')}-USD`;
  return raw; // unknown exchange — pass through
}

/**
 * @param {import('./types.js').HistoricalRequest} req
 * @returns {Promise<import('./types.js').HistoricalResult>}
 */
export async function getHistorical(req) {
  const { symbol, timeframe } = req;
  const tfSpec = TF_TO_YAHOO[timeframe];
  if (!tfSpec) throw new Error(`Yahoo: unsupported timeframe '${timeframe}'`);

  const yahooSymbol = toYahooSymbol(symbol);

  const toSec = req.to ? toUnixSec(req.to) : Math.floor(Date.now() / 1000);
  let fromSec = req.from ? toUnixSec(req.from) : (toSec - 365 * 86400);

  // Clamp intraday windows to Yahoo's history limit
  const intradayDays = INTRADAY_LIMIT_DAYS[timeframe];
  if (intradayDays) {
    const minFrom = toSec - intradayDays * 86400;
    if (fromSec < minFrom) fromSec = minFrom;
  }

  const result = await yahooFinance.chart(yahooSymbol, {
    period1: new Date(fromSec * 1000),
    period2: new Date(toSec * 1000),
    interval: tfSpec.interval,
  });

  const quotes = result?.quotes || [];
  let bars = normalizeBars(quotes.map(q => ({
    time: Math.floor(new Date(q.date).getTime() / 1000),
    open: q.open,
    high: q.high,
    low: q.low,
    close: q.close,
    volume: q.volume,
  })).filter(b => Number.isFinite(b.open) && Number.isFinite(b.close)));

  // Aggregate 1h → 4h when caller asks for 4h (Yahoo has no native 4h)
  if (timeframe === '4h') {
    bars = aggregateBars(bars, 4 * 3600);
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

/**
 * Aggregate fine-grained bars into a coarser bucket.
 * Time anchor is the floor of bucketSec.
 */
function aggregateBars(bars, bucketSec) {
  const buckets = new Map();
  for (const b of bars) {
    const key = Math.floor(b.time / bucketSec) * bucketSec;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { time: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
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
 * @param {string} query
 * @returns {Promise<import('./types.js').SymbolSearchResult[]>}
 */
export async function searchSymbol(query) {
  if (!query || query.length < 1) return [];
  try {
    const res = await yahooFinance.search(query, { quotesCount: 10, newsCount: 0 });
    const quotes = res?.quotes || [];
    return quotes
      .filter(q => q.symbol)
      .map(q => ({
        symbol: yahooToCanonical(q.symbol, q.exchange),
        name: q.shortname || q.longname || q.symbol,
        exchange: q.exchange || '',
        type: mapYahooType(q.quoteType),
      }));
  } catch {
    return [];
  }
}

function yahooToCanonical(yahooSym, exchange) {
  if (yahooSym.endsWith('.NS')) return `NSE:${yahooSym.slice(0, -3)}`;
  if (yahooSym.endsWith('.BO')) return `BSE:${yahooSym.slice(0, -3)}`;
  if (yahooSym.endsWith('=X')) return `FX:${yahooSym.slice(0, -2)}`;
  if (/-USD$/.test(yahooSym)) return `CRYPTO:${yahooSym}`;
  if (exchange === 'NMS' || exchange === 'NGM' || exchange === 'NCM') return `NASDAQ:${yahooSym}`;
  if (exchange === 'NYQ') return `NYSE:${yahooSym}`;
  if (exchange === 'PCX' || exchange === 'ASE') return `AMEX:${yahooSym}`;
  return yahooSym;
}

function mapYahooType(t) {
  switch (t) {
    case 'EQUITY': return 'equity';
    case 'ETF': return 'etf';
    case 'MUTUALFUND': return 'mutual_fund';
    case 'INDEX': return 'index';
    case 'CRYPTOCURRENCY': return 'crypto';
    case 'CURRENCY': return 'forex';
    case 'FUTURE': return 'futures';
    case 'OPTION': return 'option';
    default: return 'unknown';
  }
}

/**
 * Yahoo supports any symbol it can resolve, but we route by exchange prefix
 * to avoid wasting calls. The router decides — this is just truth-tellable.
 */
export function supports(symbol) {
  const { exchange } = parseSymbol(symbol);
  if (!exchange) return true; // bare ticker → assume US
  return ['NSE', 'BSE', 'NASDAQ', 'NYSE', 'AMEX', 'FX', 'FOREX', 'CRYPTO', 'BINANCE'].includes(exchange);
}

export const yahooProvider = {
  name: NAME,
  getHistorical,
  searchSymbol,
  supports,
};

export default yahooProvider;
