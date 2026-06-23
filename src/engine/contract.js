/**
 * Strategy contract — the symbol-aware API.
 *
 * NEW CONTRACT (replacing dashboard.js BACKTEST_LOGIC[id].run(bars, params)):
 *
 *     runStrategy({
 *       code,         // strategy id from registry
 *       symbol,       // canonical "NSE:RELIANCE" / "AAPL" / etc.
 *       timeframe,    // "5m" / "1h" / "1D" — TIMEFRAMES.js value
 *       bars,         // {opens, highs, lows, closes, volumes, times}
 *       params,       // strategy-specific overrides
 *       mode,         // 'live' | 'backtest'  (default 'backtest')
 *       execution,    // optional override of DEFAULT_EXECUTION
 *     }) → Promise<{
 *       code, name, symbol, timeframe, mode,
 *       params,                  // resolved params (defaults merged)
 *       signalFnVersion,         // hash of strategy version (Phase 2: DB key)
 *       currentSignal,           // { type: 'BUY'|'WAIT'|'IN_TRADE', ... }
 *       // present only in mode==='backtest':
 *       trades, equity, metrics, regimePerformance, oos, capital, ...
 *     }>
 *
 * The key promise: SYMBOL IS EXPLICIT. No more "scan whatever's on the
 * TradingView chart"; callers pass the symbol they care about, and the
 * runner fetches/feeds the bars for THAT symbol.
 */

import { STRATEGY_REGISTRY } from './registry.js';
import { runBacktest, runLiveSignal, DEFAULT_EXECUTION } from './runner.js';
import { getHistorical } from '../data/index.js';

// Lazy strategy-module cache (Phase 1 ports populate src/engine/strategies/)
const _strategyCache = new Map();

async function loadStrategyModule(code) {
  if (_strategyCache.has(code)) return _strategyCache.get(code);
  try {
    const mod = await import(`./strategies/${code}.js`);
    if (!mod.default || typeof mod.default.build !== 'function') {
      throw new Error(`strategies/${code}.js must export default { meta, build(params) → signalFn, exitRules }`);
    }
    _strategyCache.set(code, mod.default);
    return mod.default;
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(`Strategy '${code}' has no implementation yet (expected src/engine/strategies/${code}.js)`);
    }
    throw err;
  }
}

/**
 * Resolve a {symbol, timeframe} into bars.
 *
 * If `bars` is provided in the request, use it as-is (caller has already
 * fetched the data — useful for live monitor reusing in-memory bars).
 * Otherwise fetch via the data-provider router (which handles caching).
 *
 * Always returns COLUMNAR shape — `{opens, highs, lows, closes, volumes, times}`
 * — because indicators index by position. Accepts either columnar or
 * row-oriented `[{time, open, high, low, close, volume}]` input.
 */
function toColumnar(bars) {
  if (!bars) return null;
  if (Array.isArray(bars)) {
    return {
      times: bars.map(b => b.time),
      opens: bars.map(b => b.open),
      highs: bars.map(b => b.high),
      lows: bars.map(b => b.low),
      closes: bars.map(b => b.close),
      volumes: bars.map(b => b.volume ?? 0),
    };
  }
  if (Array.isArray(bars.closes)) return bars;
  return null;
}

async function resolveBars({ symbol, timeframe, bars, lookbackDays }) {
  if (bars) {
    const cols = toColumnar(bars);
    if (cols?.closes?.length) return cols;
  }
  // Cap lookback for intraday TFs — providers (Upstox) limit history to ~60 days
  const INTRADAY_MAX_DAYS = { '1m': 7, '5m': 55, '15m': 55, '30m': 55, '1h': 85, '4h': 85 };
  const maxDays = INTRADAY_MAX_DAYS[timeframe];
  let days = lookbackDays ?? 365;
  if (maxDays && days > maxDays) days = maxDays;
  const today = new Date();
  const from = new Date(today.getTime() - days * 86400e3);
  const res = await getHistorical({
    symbol,
    timeframe,
    from: Math.floor(from.getTime() / 1000),
    to: Math.floor(today.getTime() / 1000),
  });
  return toColumnar(res.bars);
}

/**
 * runStrategy — main entry point. Symbol-aware.
 */
export async function runStrategy({
  code,
  symbol,
  timeframe,
  bars: providedBars,
  params: userParams = {},
  mode = 'backtest',
  execution,
  lookbackDays,
}) {
  const meta = STRATEGY_REGISTRY[code];
  if (!meta) throw new Error(`Unknown strategy: ${code}`);
  if (!symbol) throw new Error('runStrategy: symbol is required');
  if (!timeframe) throw new Error('runStrategy: timeframe is required');

  const strat = await loadStrategyModule(code);
  const resolvedParams = { ...(strat.defaultParams || {}), ...userParams };
  const bars = await resolveBars({ symbol, timeframe, bars: providedBars, lookbackDays });

  if (!bars?.closes?.length) {
    return {
      code, name: meta.name, symbol, timeframe, mode,
      params: resolvedParams,
      currentSignal: { type: 'WAIT', reason: 'no_bars' },
    };
  }

  // Auto-tune tp/sl from ATR if user didn't specify
  const exitRules = strat.buildExitRules
    ? strat.buildExitRules({ bars, params: resolvedParams })
    : (strat.exitRules || { tp: 2.0, sl: 1.5, maxBars: 10 });

  const signalFn = strat.build({ bars, params: resolvedParams, symbol, timeframe });

  if (mode === 'live') {
    const live = runLiveSignal({ bars, signalFn });
    return {
      code,
      name: meta.name,
      description: meta.description || null,
      symbol,
      timeframe,
      mode,
      params: resolvedParams,
      currentSignal: live.currentSignal,
      regime: live.regime,
    };
  }

  const result = runBacktest({
    bars,
    signalFn,
    exitRules,
    execution,
    startIdx: Math.max(30, meta.warmup || strat.warmup || 30),
    symbol,
    timeframe,
    regimeAffinity: meta.regimeAffinity ?? null,
  });

  return {
    code,
    name: meta.name,
    description: meta.description || null,
    symbol,
    timeframe,
    mode,
    params: resolvedParams,
    exitRules,
    ...result,
  };
}

export { DEFAULT_EXECUTION };
