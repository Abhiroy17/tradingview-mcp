#!/usr/bin/env node
/**
 * tune-strategy.js — Parameter sweep harness for production strategies.
 *
 * Walks a strategy across a grid of parameter combinations, runs walk-forward
 * validation on each combo under realistic India costs, ranks by aggregate
 * OOS Sharpe (with PF, drawdown, stability tie-breakers), and prints the top N.
 *
 * Usage:
 *   node scripts/tune-strategy.js <code> [--symbol NSE:RELIANCE] [--tf 1D]
 *                                 [--years 3] [--top 10] [--k 5]
 *                                 [--preset india_delivery]
 *
 * Example:
 *   node scripts/tune-strategy.js rsi2_india_swing --symbol NSE:RELIANCE --years 4
 */
import { runWalkForward } from '../src/engine/walk-forward.js';
import { getHistorical } from '../src/data/index.js';
import { STRATEGY_REGISTRY } from '../src/engine/registry.js';

// ── Parameter grids per strategy ─────────────────────────────────────────
const PARAM_GRIDS = {
  rsi2_india_swing: {
    rsiOversold: [10, 15, 20, 25, 30],
    rsiExit:     [50, 60, 70],
    tp:          [1.0, 1.5, 2.0, 2.5, 3.0],
    sl:          [0.8, 1.0, 1.5, 2.0],
    maxBars:     [3, 5, 7, 10],
    volLen:      [20],
  },
  ibs_india_swing: {
    ibsEntry:    [0.20, 0.25, 0.30, 0.35, 0.40],
    ibsExit:     [0.55, 0.65, 0.75],
    tp:          [1.5, 2.0, 2.5, 3.0],
    sl:          [1.0, 1.5, 2.0],
    maxBars:     [3, 5, 7, 10],
  },
  ibs_india_intraday: {
    ibsEntry:    [0.15, 0.20, 0.25, 0.30],
    ibsExit:     [0.55, 0.65, 0.75],
    tp:          [0.4, 0.5, 0.7, 1.0],
    sl:          [0.3, 0.4, 0.5],
    maxBars:     [4, 6, 8, 12],
  },
  fibonacci_india_swing: {
    lookback:    [20, 30, 50, 80],
    tp:          [2.0, 3.0, 4.0, 5.0],
    sl:          [1.0, 1.5, 2.0, 2.5],
    maxBars:     [10, 20, 30, 50],
    allowShorts: [false, true],
  },
  trend_200sma_positional: {
    trendLen:    [150, 200],
    fastLen:     [20, 50],
    tp:          [10, 15, 20, 25, 30],
    sl:          [5, 8, 10, 12],
    maxBars:     [100, 150, 250],
  },
  // ── Phase 1 risk-managed generic intraday templates ────────────────────
  movingaverage_intraday: {
    shortPeriod: [5, 10],
    longPeriod:  [30, 50],
    volMult:     [0.0, 1.0],
    tp:          [1.0, 1.5, 2.5],
    sl:          [1.0, 1.5],
    maxBars:     [15, 30],
  },
  dual_movingaverage_intraday: {
    angleThresh: [4, 7, 10],
    crossWindow: [10, 15],
    volMult:     [0.0, 1.0],
    tp:          [1.0, 1.5, 2.5],
    sl:          [1.0, 1.5],
    maxBars:     [15, 30],
  },
  ema_rsi_intraday: {
    rsiExitLong: [65, 70, 75],
    volMult:     [0.0, 1.0],
    tp:          [1.5, 2.0, 3.0],
    sl:          [1.0, 1.5, 2.0],
    maxBars:     [12, 24, 48],
  },
  supertrend_intraday: {
    multiplier:  [2, 3, 4],
    atrPeriod:   [10, 14],
    volMult:     [0.0, 1.0],
    tp:          [1.5, 2.5],
    sl:          [1.0, 1.5],
    maxBars:     [15, 30],
  },
};

// ── CLI parser ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();
  const code = args[0];
  const opts = { symbol: 'NSE:RELIANCE', tf: '1D', years: 3, top: 10, k: 5, preset: 'india_delivery' };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i].replace(/^--/, '');
    const val  = args[++i];
    if (flag in opts) opts[flag] = isNaN(Number(val)) ? val : Number(val);
  }
  return { code, ...opts };
}

function usage() {
  console.error('Usage: node scripts/tune-strategy.js <code> [--symbol] [--tf] [--years] [--top] [--k] [--preset]');
  console.error('Available codes: ' + Object.keys(PARAM_GRIDS).join(', '));
  process.exit(1);
}

// ── Cartesian product over a grid ────────────────────────────────────────

function* cartesianProduct(grid) {
  const keys = Object.keys(grid);
  const dims = keys.map(k => grid[k]);
  function* helper(idx, acc) {
    if (idx === keys.length) { yield { ...acc }; return; }
    for (const v of dims[idx]) yield* helper(idx + 1, { ...acc, [keys[idx]]: v });
  }
  yield* helper(0, {});
}

function gridSize(grid) {
  return Object.values(grid).reduce((p, vals) => p * vals.length, 1);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const { code, symbol, tf, years, top, k, preset } = parseArgs();
  if (!STRATEGY_REGISTRY[code]) usage();
  const grid = PARAM_GRIDS[code];
  if (!grid) {
    console.error(`No tuning grid defined for ${code}`);
    process.exit(1);
  }

  const total = gridSize(grid);
  console.log(`Tuning ${code}`);
  console.log(`  symbol  : ${symbol}`);
  console.log(`  tf      : ${tf}`);
  console.log(`  years   : ${years}`);
  console.log(`  k-fold  : ${k}`);
  console.log(`  preset  : ${preset}`);
  console.log(`  combos  : ${total}`);
  console.log();

  // Fetch bars once
  const today = Math.floor(Date.now() / 1000);
  const from  = today - years * 365 * 86400;
  const res   = await getHistorical({ symbol, timeframe: tf, from, to: today });
  if (!res.bars?.length) {
    console.error(`No bars for ${symbol} × ${tf}`);
    process.exit(1);
  }
  const bars = {
    opens:   res.bars.map(b => b.open),
    highs:   res.bars.map(b => b.high),
    lows:    res.bars.map(b => b.low),
    closes:  res.bars.map(b => b.close),
    volumes: res.bars.map(b => b.volume ?? 0),
    times:   res.bars.map(b => b.time),
  };
  console.log(`Bars: ${bars.closes.length}`);
  console.log();

  // Run sweep
  const results = [];
  let count = 0;
  for (const params of cartesianProduct(grid)) {
    count++;
    try {
      const wf = await runWalkForward({
        code, symbol, timeframe: tf, bars, k, anchor: 'rolling',
        execution: { costsPreset: preset },
        params,
      });
      results.push({
        params,
        oosTrades:  wf.aggregateOOS.totalTrades,
        oosWR:      wf.aggregateOOS.winRate,
        oosPF:      wf.aggregateOOS.profitFactor,
        oosSharpe:  wf.aggregateOOS.sharpe,
        oosPnl:     wf.aggregateOOS.totalPnl,
        oosMaxDD:   wf.aggregateOOS.maxDrawdown,
        trainSharpe: wf.avgTrainSharpe,
        gap:        wf.isOosGap,
        overfit:    wf.overfitFlag,
        stability:  wf.stabilityFlag,
        pfCov:      wf.pfCov,
      });
      if (count % 25 === 0 || count === total) {
        process.stdout.write(`\r  progress: ${count}/${total} (${Math.round(count/total*100)}%)`);
      }
    } catch (err) {
      // Skip bad params
    }
  }
  console.log('\n');

  // Filter: meaningful sample size + non-zero metrics
  const minTrades = process.argv.includes('--min-trades')
    ? Number(process.argv[process.argv.indexOf('--min-trades') + 1])
    : 10;
  const valid = results.filter(r => r.oosTrades >= minTrades);
  if (!valid.length) {
    console.log(`No combos with >=${minTrades} OOS trades. Try --min-trades 5 or extend --years.`);
    return;
  }

  // Rank by composite: OOS Sharpe, then PF, then -drawdown, then stability
  const stabilityRank = { stable: 0, variable: 1, unstable: 2 };
  valid.sort((a, b) => {
    if (Math.abs(b.oosSharpe - a.oosSharpe) > 0.05) return b.oosSharpe - a.oosSharpe;
    if (Math.abs(b.oosPF - a.oosPF) > 0.05) return b.oosPF - a.oosPF;
    if (a.stability !== b.stability) return stabilityRank[a.stability] - stabilityRank[b.stability];
    return a.oosMaxDD - b.oosMaxDD;
  });

  console.log(`Top ${top} combos for ${code} (${valid.length} valid out of ${results.length}):`);
  console.log();
  console.log('Rank | Params'.padEnd(80) + ' | tr | WR  | PF   | Shp   | PnL%  | Stab    ');
  console.log('-----|' + '-'.repeat(74) + ' | -- | --- | ---- | ----- | ----- | --------');
  for (let i = 0; i < Math.min(top, valid.length); i++) {
    const r = valid[i];
    const ps = Object.entries(r.params).map(([k,v]) => `${k}=${v}`).join(' ');
    console.log(
      String(i + 1).padStart(4) + ' | ' + ps.padEnd(74) +
      ' | ' + String(r.oosTrades).padStart(2) +
      ' | ' + String(r.oosWR + '%').padStart(3) +
      ' | ' + r.oosPF.toFixed(2).padStart(4) +
      ' | ' + r.oosSharpe.toFixed(2).padStart(5) +
      ' | ' + r.oosPnl.toFixed(1).padStart(5) +
      ' | ' + r.stability.padEnd(8)
    );
  }

  console.log();
  console.log('Best combo full report:');
  console.log(JSON.stringify(valid[0], null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
