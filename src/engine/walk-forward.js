/**
 * Walk-Forward Validation — replaces naive 70/30 OOS with K-fold rolling/expanding windows.
 *
 * Industry standard for backtest validation (López de Prado, *Advances in Financial ML*).
 * Avoids the bias of a single train/test split — each fold trains on past, tests on future.
 *
 * Usage:
 *   import { runWalkForward } from './walk-forward.js';
 *   const wf = await runWalkForward({
 *     code: 'fibonacci_india_swing',
 *     symbol: 'NSE:RELIANCE',
 *     timeframe: '1D',
 *     bars,
 *     k: 5,
 *     trainPct: 0.7,
 *     anchor: 'rolling',  // or 'expanding'
 *   });
 *   //  → { folds: [...], aggregateOOS: {...}, overfitFlag, isOosGap }
 */
import { runBacktest, DEFAULT_EXECUTION } from './runner.js';
import { Quant } from './quant.js';
import { STRATEGY_REGISTRY } from './registry.js';

/**
 * @param {Object} input
 * @param {string} input.code        Strategy code (loaded from registry)
 * @param {string} input.symbol      e.g. "NSE:RELIANCE"
 * @param {string} input.timeframe   e.g. "1D"
 * @param {Object} input.bars        columnar bars object
 * @param {number} [input.k=5]       Number of folds
 * @param {number} [input.trainPct=0.7]  Each fold's train fraction (rolling) or growing-train start fraction (expanding)
 * @param {'rolling'|'expanding'} [input.anchor='rolling']
 * @param {Object} [input.execution] Override DEFAULT_EXECUTION
 * @param {Object} [input.params]    Strategy params override
 * @returns {Promise<Object>} walk-forward report
 */
export async function runWalkForward({
  code,
  symbol,
  timeframe,
  bars,
  k = 5,
  trainPct = 0.7,
  anchor = 'rolling',
  execution = DEFAULT_EXECUTION,
  params = {},
}) {
  const meta = STRATEGY_REGISTRY[code];
  if (!meta) throw new Error(`Unknown strategy: ${code}`);
  if (!bars?.closes?.length) throw new Error('runWalkForward: bars required');
  const totalBars = bars.closes.length;
  if (totalBars < 200) {
    return { code, symbol, timeframe, error: 'insufficient_bars', totalBars };
  }

  // Lazy-load the strategy module
  const stratMod = await import(`./strategies/${code}.js`);
  const strat = stratMod.default;
  const resolvedParams = { ...(strat.defaultParams || {}), ...params };

  // Build folds. Each fold has [trainStart, trainEnd, testStart, testEnd].
  const folds = [];
  if (anchor === 'expanding') {
    // Growing train: each fold's train = bars[0..trainEnd_i], test = bars[trainEnd_i..testEnd_i]
    const minTrain = Math.floor(totalBars * 0.4);     // start training at 40% of data
    const testSize = Math.floor((totalBars - minTrain) / k);
    for (let i = 0; i < k; i++) {
      const trainStart = 0;
      const trainEnd   = minTrain + i * testSize;
      const testStart  = trainEnd;
      const testEnd    = Math.min(trainEnd + testSize, totalBars);
      if (testEnd - testStart < 30) break;
      folds.push({ trainStart, trainEnd, testStart, testEnd });
    }
  } else {
    // Rolling window: fixed-size train + test, sliding forward
    const windowSize = Math.floor(totalBars / (k * (1 - trainPct) + trainPct));
    const trainSize  = Math.floor(windowSize * trainPct);
    const testSize   = windowSize - trainSize;
    for (let i = 0; i < k; i++) {
      const trainStart = i * testSize;
      const trainEnd   = trainStart + trainSize;
      const testStart  = trainEnd;
      const testEnd    = Math.min(testStart + testSize, totalBars);
      if (testEnd - testStart < 30 || trainEnd >= totalBars) break;
      folds.push({ trainStart, trainEnd, testStart, testEnd });
    }
  }

  if (folds.length === 0) {
    return { code, symbol, timeframe, error: 'no_folds_constructible', totalBars };
  }

  // Build a per-fold result by slicing bars and running the backtest twice (train, test).
  const foldResults = [];
  for (let i = 0; i < folds.length; i++) {
    const f = folds[i];
    const trainBars = sliceBars(bars, f.trainStart, f.trainEnd);
    const testBars  = sliceBars(bars, f.testStart,  f.testEnd);

    const exitRules = strat.buildExitRules
      ? strat.buildExitRules({ bars: trainBars, params: resolvedParams })
      : (strat.exitRules || { tp: 2, sl: 1.5, maxBars: 10 });

    const trainSignalFn = strat.build({ bars: trainBars, params: resolvedParams, symbol, timeframe });
    const testSignalFn  = strat.build({ bars: testBars,  params: resolvedParams, symbol, timeframe });

    const trainResult = runBacktest({
      bars: trainBars,
      signalFn: trainSignalFn,
      exitRules,
      execution,
      startIdx: Math.max(30, strat.warmup || 30),
      symbol, timeframe,
    });
    const testResult = runBacktest({
      bars: testBars,
      signalFn: testSignalFn,
      exitRules,
      execution,
      startIdx: Math.max(30, strat.warmup || 30),
      symbol, timeframe,
    });

    foldResults.push({
      fold: i + 1,
      trainBars: f.trainEnd - f.trainStart,
      testBars:  f.testEnd  - f.testStart,
      trainMetrics: pickMetrics(trainResult),
      testMetrics:  pickMetrics(testResult),
      trainTimeRange: timeRange(bars, f.trainStart, f.trainEnd),
      testTimeRange:  timeRange(bars, f.testStart,  f.testEnd),
    });
  }

  // Aggregate OOS metrics across all test folds (concat all test trades + recompute)
  const allOosTrades = foldResults.flatMap(f => f.testMetrics.tradeReturns || []);
  const aggregateOOS = aggregateMetrics(allOosTrades);

  // Overfit detection: compare avg train vs test Sharpe gap
  const avgTrainSharpe = avg(foldResults.map(f => f.trainMetrics.sharpe || 0));
  const avgTestSharpe  = avg(foldResults.map(f => f.testMetrics.sharpe  || 0));
  const isOosGap = parseFloat((avgTrainSharpe - avgTestSharpe).toFixed(3));
  const overfitFlag =
    isOosGap > 2.0 ? 'high'   :
    isOosGap > 1.0 ? 'medium' :
    isOosGap > 0.5 ? 'low'    : 'none';

  // Stability: how consistent are test PFs across folds? (CoV of fold PFs)
  const foldPfs = foldResults.map(f => f.testMetrics.profitFactor || 0).filter(Number.isFinite);
  const pfStats = Quant.stats(foldPfs);
  const pfCov = pfStats.mean > 0 ? pfStats.std / pfStats.mean : 0;
  const stabilityFlag = pfCov < 0.3 ? 'stable' : pfCov < 0.6 ? 'variable' : 'unstable';

  // Deflated Sharpe Ratio across folds (if 2+ folds)
  const dsr = foldPfs.length >= 2 ? Quant.deflatedSharpe(allOosTrades, foldResults.length) : 0;

  return {
    code,
    symbol,
    timeframe,
    anchor,
    k: foldResults.length,
    folds: foldResults,
    aggregateOOS,
    avgTrainSharpe: parseFloat(avgTrainSharpe.toFixed(3)),
    avgTestSharpe:  parseFloat(avgTestSharpe.toFixed(3)),
    isOosGap,
    overfitFlag,
    stabilityFlag,
    pfCov: parseFloat(pfCov.toFixed(3)),
    dsr: parseFloat((dsr || 0).toFixed(3)),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function sliceBars(bars, start, end) {
  return {
    opens:   bars.opens.slice(start, end),
    highs:   bars.highs.slice(start, end),
    lows:    bars.lows.slice(start, end),
    closes:  bars.closes.slice(start, end),
    volumes: bars.volumes.slice(start, end),
    times:   bars.times ? bars.times.slice(start, end) : null,
  };
}

function timeRange(bars, start, end) {
  if (!bars.times || start >= bars.times.length) return null;
  const fromSec = bars.times[start];
  const toSec   = bars.times[Math.min(end - 1, bars.times.length - 1)];
  return {
    from: fromSec ? new Date(fromSec * 1000).toISOString().slice(0, 10) : null,
    to:   toSec   ? new Date(toSec   * 1000).toISOString().slice(0, 10) : null,
  };
}

function pickMetrics(result) {
  return {
    totalTrades:  result.totalTrades   || 0,
    winRate:      result.winRate       || 0,
    profitFactor: result.profitFactor  || 0,
    sharpe:       result.sharpe        || 0,
    sortino:      result.sortino       || 0,
    maxDrawdown:  result.maxDrawdown   || 0,
    totalPnl:     result.totalPnl      || 0,
    expectancy:   result.expectancy    || 0,
    psr:          result.psr           || 0,
    tradeReturns: (result.trades || []).map(t => t.pnl),
  };
}

function aggregateMetrics(allReturns) {
  if (!allReturns?.length) {
    return { totalTrades: 0, winRate: 0, profitFactor: 0, sharpe: 0, totalPnl: 0, psr: 0 };
  }
  const wins = allReturns.filter(r => r > 0);
  const losses = allReturns.filter(r => r <= 0);
  const totalPnl = allReturns.reduce((s, r) => s + r, 0);
  const avgWin   = wins.length   ? wins.reduce((s, r) => s + r, 0) / wins.length : 0;
  const avgLoss  = losses.length ? Math.abs(losses.reduce((s, r) => s + r, 0) / losses.length) : 0;
  const pf       = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : (wins.length ? 99 : 0);
  const stats    = Quant.stats(allReturns);
  const sharpe   = stats.std > 0 ? stats.mean / stats.std : 0;
  const psr      = Quant.probabilisticSharpe(allReturns, 0);
  return {
    totalTrades:  allReturns.length,
    winRate:      Math.round((wins.length / allReturns.length) * 100),
    profitFactor: parseFloat(pf.toFixed(2)),
    sharpe:       parseFloat(sharpe.toFixed(3)),
    totalPnl:     parseFloat(totalPnl.toFixed(2)),
    expectancy:   parseFloat((totalPnl / allReturns.length).toFixed(3)),
    psr:          parseFloat((psr * 100).toFixed(1)),
  };
}

function avg(arr) {
  if (!arr?.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}
