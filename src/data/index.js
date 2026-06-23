/**
 * Public entry point for the data layer.
 *
 * Strategies and engines should import from here, NOT from individual
 * providers. This keeps the engine provider-agnostic.
 *
 * Usage:
 *   import { getHistorical, searchSymbol, TIMEFRAMES } from '../data/index.js';
 *   const { bars } = await getHistorical({
 *     symbol: 'NSE:RELIANCE',
 *     timeframe: '1D',
 *     from: '2022-01-01',
 *   });
 */

export { getHistorical, searchSymbol, describeRouting } from './providers/router.js';
export { TIMEFRAMES, TIMEFRAME_SECONDS, parseSymbol, normalizeBars } from './providers/types.js';
export { default as upstoxProvider } from './providers/upstox.js';
export { default as yahooProvider } from './providers/yahoo.js';
export { default as cdpProvider } from './providers/cdp.js';
