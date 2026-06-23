/**
 * CDP provider — wraps the existing TradingView Desktop OHLCV fetch.
 *
 * Used as a fallback when no broker/API source covers the symbol, or
 * for live monitoring of whatever chart the user has open.
 *
 * Limitations:
 *  - Only returns up to ~500 bars of the CURRENTLY DISPLAYED timeframe.
 *  - Cannot fetch arbitrary date ranges (the chart must have the bars loaded).
 *  - Switching symbols is intrusive (mutates UI).
 *
 * We do NOT route any symbol to CDP by default; the router only falls back
 * here when other providers fail. Callers can still request it explicitly.
 */

import { getOhlcv } from '../../core/data.js';
import { setSymbol } from '../../core/chart.js';
import { parseSymbol, normalizeBars } from './types.js';

const NAME = 'cdp';

/**
 * @param {import('./types.js').HistoricalRequest} req
 * @returns {Promise<import('./types.js').HistoricalResult>}
 */
export async function getHistorical(req) {
  const { symbol, timeframe, limit = 500 } = req;
  // Optionally switch chart if a symbol is supplied; ignore failure (chart may already be on symbol)
  if (symbol) {
    try { await setSymbol({ symbol: parseSymbol(symbol).raw }); } catch { /* ignore */ }
  }
  const raw = await getOhlcv({ count: Math.min(limit, 500) });
  const bars = normalizeBars((raw?.bars || []).map(b => ({
    time: Number(b.time),
    open: Number(b.open),
    high: Number(b.high),
    low: Number(b.low),
    close: Number(b.close),
    volume: Number(b.volume) || 0,
  })));
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
 * CDP can't reliably search symbols (TV uses its own search API).
 * Return empty; the router falls back to other providers.
 */
export async function searchSymbol(_query) {
  return [];
}

/**
 * CDP always "supports" any symbol — it'll try to switch the chart.
 * But the router treats this as last-resort, and `supports()` here returns
 * false by default so the router NEVER auto-selects CDP. Callers that
 * explicitly want CDP must import this module directly.
 */
export function supports(_symbol) {
  return false;
}

export const cdpProvider = {
  name: NAME,
  getHistorical,
  searchSymbol,
  supports,
};

export default cdpProvider;
