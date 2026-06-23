/**
 * Public engine surface.
 *
 *   import { runStrategy, STRATEGY_REGISTRY, STRATEGY_CODES } from './engine/index.js';
 *
 *   const result = await runStrategy({
 *     code: 'ibs_india_swing',
 *     symbol: 'NSE:RELIANCE',
 *     timeframe: '1D',
 *     mode: 'backtest',
 *   });
 */

export {
  STRATEGY_REGISTRY,
  STRATEGY_CODES,
  STRATEGY_FAMILIES,
  getStrategy,
  listStrategies,
  strategiesForRegime,
  strategiesForTimeframe,
} from './registry.js';

export { runStrategy, DEFAULT_EXECUTION } from './contract.js';
export { runBacktest, runLiveSignal, detectRegimeAt } from './runner.js';
export { Quant } from './quant.js';
export {
  scanMatrix,
  scanSymbolAllStrategies,
  scanStrategyAllSymbols,
  scanFullMatrix,
  groupBySymbol,
  groupByStrategy,
  actionableOnly,
} from './scanner.js';

export {
  rankSignals,
  topNPerSymbol,
  actionableRanked,
} from './ranker.js';
