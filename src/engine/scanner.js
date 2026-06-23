/**
 * Scanner — run many {code, symbol, timeframe} jobs in parallel.
 *
 * Bounded concurrency (default 8), per-job error isolation, optional progress
 * callback. Returns a flat array of results (one per job).
 *
 * Example:
 *
 *   import { scanMatrix } from './engine/scanner.js';
 *
 *   const results = await scanMatrix({
 *     jobs: [
 *       { code: 'rsi2_india_swing', symbol: 'NSE:RELIANCE', timeframe: '1D' },
 *       { code: 'rsi2_india_swing', symbol: 'NSE:INFY',     timeframe: '1D' },
 *       { code: 'ibs_india_swing',  symbol: 'NSE:RELIANCE', timeframe: '1D' },
 *     ],
 *     mode: 'live',
 *     concurrency: 8,
 *     onProgress: ({ done, total, last }) => console.log(`${done}/${total}`),
 *   });
 *
 *   // results: [{ ok: true, code, symbol, timeframe, result }, ...]
 *   //          [{ ok: false, code, symbol, timeframe, error }, ...]
 *
 * Convenience helpers:
 *   - `scanSymbolAllStrategies(symbol, timeframe, mode)` → all 20 strategies × 1 symbol
 *   - `scanStrategyAllSymbols(code, symbols, timeframe, mode)` → 1 strategy × N symbols
 *   - `scanFullMatrix(symbols, timeframes, mode)` → cartesian product
 */

import pLimit from 'p-limit';
import { runStrategy } from './contract.js';
import { STRATEGY_CODES, getStrategy } from './registry.js';

const DEFAULT_CONCURRENCY = 8;

/**
 * Run a flat job array with bounded concurrency.
 *
 * @param {Object} input
 * @param {Array<{code, symbol, timeframe, params?, lookbackDays?}>} input.jobs
 * @param {'live'|'backtest'} [input.mode='live']
 * @param {number} [input.concurrency=8]
 * @param {function} [input.onProgress] - called after each job completes
 * @param {Object} [input.execution] - passed through to runStrategy
 * @returns {Promise<Array<{ok, code, symbol, timeframe, result?, error?}>>}
 */
export async function scanMatrix({
  jobs,
  mode = 'live',
  concurrency = DEFAULT_CONCURRENCY,
  onProgress,
  execution,
}) {
  if (!Array.isArray(jobs) || jobs.length === 0) return [];

  const limit = pLimit(concurrency);
  const total = jobs.length;
  let done = 0;

  const tasks = jobs.map(job => limit(async () => {
    const { code, symbol, timeframe, params, lookbackDays } = job;
    let result;
    try {
      const r = await runStrategy({
        code, symbol, timeframe, params, mode, execution,
        lookbackDays,
      });
      result = { ok: true, code, symbol, timeframe, mode, result: r };
    } catch (err) {
      result = { ok: false, code, symbol, timeframe, mode, error: err.message };
    }
    done++;
    if (typeof onProgress === 'function') {
      onProgress({ done, total, last: result });
    }
    return result;
  }));

  return Promise.all(tasks);
}

/**
 * Helper — run all registered strategies against one symbol/timeframe.
 *
 * Used by "scan this one stock with everything" mode in PineLab.
 */
export function scanSymbolAllStrategies(symbol, timeframe = '1D', {
  mode = 'live',
  concurrency = DEFAULT_CONCURRENCY,
  onProgress,
  filter, // optional `(meta) => boolean` to skip strategies (e.g., timeframe mismatch)
} = {}) {
  const jobs = STRATEGY_CODES
    .map(code => ({ code, meta: getStrategy(code) }))
    .filter(({ meta }) => !filter || filter(meta))
    .map(({ code }) => ({ code, symbol, timeframe }));
  return scanMatrix({ jobs, mode, concurrency, onProgress });
}

/**
 * Helper — run one strategy across many symbols/timeframes.
 *
 * Used by "scan this strategy across my watchlist" mode.
 */
export function scanStrategyAllSymbols(code, symbols, timeframe = '1D', {
  mode = 'live',
  concurrency = DEFAULT_CONCURRENCY,
  onProgress,
} = {}) {
  const jobs = symbols.map(symbol => ({ code, symbol, timeframe }));
  return scanMatrix({ jobs, mode, concurrency, onProgress });
}

/**
 * Helper — full cartesian product (warning: can be huge).
 *
 * Used by background scheduler to refresh the entire performance matrix.
 *
 * Example: 20 strategies × 50 symbols × 4 timeframes = 4000 jobs.
 * At 8 concurrency and ~500ms/job avg, that's ~4 minutes.
 */
export function scanFullMatrix({
  codes = STRATEGY_CODES,
  symbols,
  timeframes,
  mode = 'live',
  concurrency = DEFAULT_CONCURRENCY,
  onProgress,
  // Skip jobs where the strategy's recommended TFs don't include this TF.
  // Saves time and avoids running daily strategies on 1m bars.
  respectTimeframes = true,
}) {
  const jobs = [];
  for (const code of codes) {
    const meta = getStrategy(code);
    if (!meta) continue;
    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        if (respectTimeframes && meta.timeframes && !meta.timeframes.includes(timeframe)) {
          continue;
        }
        jobs.push({ code, symbol, timeframe });
      }
    }
  }
  return scanMatrix({ jobs, mode, concurrency, onProgress });
}

/**
 * Group scan results by symbol — useful for UI summaries.
 *
 * @returns {Object} { [symbol]: { [code]: result } }
 */
export function groupBySymbol(results) {
  const out = {};
  for (const r of results) {
    out[r.symbol] = out[r.symbol] || {};
    out[r.symbol][r.code] = r;
  }
  return out;
}

/**
 * Group scan results by strategy — for "which symbols are firing this signal".
 */
export function groupByStrategy(results) {
  const out = {};
  for (const r of results) {
    out[r.code] = out[r.code] || {};
    out[r.code][r.symbol] = r;
  }
  return out;
}

/**
 * Filter to only "actionable" results — buy signals or in-trade positions.
 * Useful for dashboard "active signals" panel.
 */
export function actionableOnly(results) {
  return results.filter(r => {
    if (!r.ok) return false;
    const sig = r.result?.currentSignal?.type;
    return sig === 'BUY' || sig === 'IN_TRADE';
  });
}
