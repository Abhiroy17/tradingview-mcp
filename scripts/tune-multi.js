#!/usr/bin/env node
/**
 * tune-multi.js — Cross-symbol parameter sweep.
 *
 * Unlike tune-strategy.js (which tunes on a single symbol via walk-forward),
 * this harness sums PnL across a basket of symbols to find UNIVERSAL params
 * that aren't curve-fit to a single ticker.
 *
 * Use this for production-tier param locking — the result should be a param
 * set that's profitable across the basket as a whole, even if individual
 * symbols underperform.
 *
 * Usage:
 *   node scripts/tune-multi.js <code> [--years 4] [--top 10] [--preset india_delivery]
 */
import { runStrategy } from '../src/engine/contract.js';
import { getHistorical } from '../src/data/index.js';
import { STRATEGY_REGISTRY } from '../src/engine/registry.js';
import { getBasket, listBaskets, BASKET_META, BASKET_GROUPS } from '../src/engine/baskets.js';

// Intraday providers (Upstox) cap history to ~60 days — bound the lookback so
// we don't request multi-year intraday windows that silently truncate.
const INTRADAY_MAX_DAYS = { '1m': 7, '5m': 55, '15m': 55, '30m': 55, '1h': 85, '4h': 85 };
const isIntraday = (tf) => !['1D', '1W', '1M'].includes(tf);

const PARAM_GRIDS = {
  rsi2_india_swing: {
    rsiOversold: [10, 15, 20, 25, 30],
    tp:          [0.8, 1.0, 1.5, 2.0, 2.5, 3.0],
    sl:          [0.8, 1.0, 1.5, 2.0],
    maxBars:     [3, 5, 7],
  },
  ibs_india_swing: {
    ibsEntry:    [0.10, 0.15, 0.20, 0.25, 0.30],
    tp:          [1.0, 1.5, 2.0, 2.5],
    sl:          [1.0, 1.5, 2.0],
    maxBars:     [3, 5, 7],
  },
  fibonacci_india_swing: {
    lookback:    [30, 50, 80, 100],
    tp:          [2.0, 3.0, 4.0, 5.0],
    sl:          [1.5, 2.0, 2.5, 3.0],
    maxBars:     [10, 20, 30],
    allowShorts: [false, true],
  },
  trend_200sma_positional: {
    fastLen:     [20, 50],
    sl:          [8, 12, 15, 20],
    tp:          [25, 50, 99],
    volMult:     [1.0, 1.5],
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
  master_intraday: {
    qualityThreshold: [35, 45, 55],
    stMult:           [2, 3, 4],
    volMult:          [0.5, 1.0],
    rsiExitLong:      [68, 72, 78],
    tp:               [2.0, 3.0, 4.0],
    sl:               [1.0, 1.5, 2.0],
    maxBars:          [24, 48],
  },
};

const STRING_FLAGS = new Set(['preset', 'basket', 'timeframe']);

function parseArgs() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node scripts/tune-multi.js <code> [--basket large_cap|cap|sector|all] [--timeframe 1D] [--years 4] [--top 10] [--preset auto]');
    console.error('Available codes  : ' + Object.keys(PARAM_GRIDS).join(', '));
    console.error('Available baskets: ' + listBaskets().join(', ') + ', cap, sector, all');
    process.exit(1);
  }
  const code = args[0];
  const opts = { years: 4, top: 10, preset: null, basket: 'large_cap', timeframe: '1D' };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i].replace(/^--/, '');
    const val  = args[++i];
    if (!(flag in opts)) continue;
    opts[flag] = STRING_FLAGS.has(flag) ? val : (isNaN(Number(val)) ? val : Number(val));
  }
  // Smart preset default based on timeframe (intraday costs differ from delivery)
  if (!opts.preset) opts.preset = isIntraday(opts.timeframe) ? 'india_intraday' : 'india_delivery';
  return { code, ...opts };
}

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

async function fetchBars({ symbols, timeframe, years }) {
  const today = Math.floor(Date.now() / 1000);
  let days = years * 365;
  if (INTRADAY_MAX_DAYS[timeframe]) days = INTRADAY_MAX_DAYS[timeframe];
  const from = today - days * 86400;
  const barsCache = {};
  for (const sym of symbols) {
    try {
      const res = await getHistorical({ symbol: sym, timeframe, from, to: today });
      barsCache[sym] = {
        opens:   res.bars.map(b => b.open),
        highs:   res.bars.map(b => b.high),
        lows:    res.bars.map(b => b.low),
        closes:  res.bars.map(b => b.close),
        volumes: res.bars.map(b => b.volume ?? 0),
        times:   res.bars.map(b => b.time),
      };
      process.stdout.write(`\r  cached ${Object.keys(barsCache).length}/${symbols.length}`);
    } catch (e) {
      console.warn(`\n  skipped ${sym}: ${e.message}`);
    }
  }
  process.stdout.write('\n');
  return barsCache;
}

async function sweepBasket({ code, grid, barsCache, timeframe, preset, top }) {
  const meta = STRATEGY_REGISTRY[code];
  const symbols = Object.keys(barsCache);
  const total = gridSize(grid);
  const results = [];
  let count = 0;
  for (const params of cartesianProduct(grid)) {
    count++;
    let totTrades = 0, totPnl = 0, totWins = 0, profitable = 0;
    let bestSymPnl = -Infinity, worstSymPnl = Infinity;
    // Allow shorts if the param set asks for it, else from the registry direction
    const allowShorts = params.allowShorts ?? (meta.direction === 'both' || meta.direction === 'short');
    for (const sym of symbols) {
      try {
        const r = await runStrategy({
          code, symbol: sym, timeframe, bars: barsCache[sym],
          execution: { costsPreset: preset, allowShorts },
          params,
        });
        totTrades += r.totalTrades;
        totPnl    += r.totalPnl;
        totWins   += r.wins;
        if (r.totalPnl > 0) profitable++;
        if (r.totalPnl > bestSymPnl) bestSymPnl = r.totalPnl;
        if (r.totalPnl < worstSymPnl) worstSymPnl = r.totalPnl;
      } catch (e) {}
    }
    if (totTrades >= 20) {
      results.push({
        params,
        totTrades,
        totPnl: parseFloat(totPnl.toFixed(1)),
        avgPnl: parseFloat((totPnl / symbols.length).toFixed(1)),
        wr: totTrades ? Math.round(totWins / totTrades * 100) : 0,
        profitable,
        bestSymPnl: parseFloat(bestSymPnl.toFixed(1)),
        worstSymPnl: parseFloat(worstSymPnl.toFixed(1)),
      });
    }
    if (count % 20 === 0 || count === total) {
      process.stdout.write(`\r  progress: ${count}/${total} (${Math.round(count/total*100)}%)`);
    }
  }
  process.stdout.write('\n');

  if (!results.length) {
    console.log('No combos produced >= 20 trades across the basket.');
    return null;
  }

  // Rank: prioritize # profitable symbols, then total PnL, then minimum drawdown
  results.sort((a, b) => {
    if (b.profitable !== a.profitable) return b.profitable - a.profitable;
    if (Math.abs(b.totPnl - a.totPnl) > 5) return b.totPnl - a.totPnl;
    return b.worstSymPnl - a.worstSymPnl;
  });

  console.log();
  console.log(`Top ${top} combos for ${code} (${results.length} valid):`);
  console.log('Params'.padEnd(56) + ' | Tr   | WR  | Prof | TotPnL | AvgPnL | Best  | Worst ');
  console.log('-'.repeat(56) + ' | ---- | --- | ---- | ------ | ------ | ----- | ------');
  for (let i = 0; i < Math.min(top, results.length); i++) {
    const r = results[i];
    const ps = Object.entries(r.params).map(([k,v]) => `${k}=${v}`).join(' ').padEnd(56);
    console.log(
      ps +
      ' | ' + String(r.totTrades).padStart(4) +
      ' | ' + String(r.wr + '%').padStart(3) +
      ' | ' + String(r.profitable + '/' + symbols.length).padStart(4) +
      ' | ' + String(r.totPnl + '%').padStart(6) +
      ' | ' + String(r.avgPnl + '%').padStart(6) +
      ' | ' + String(r.bestSymPnl + '%').padStart(5) +
      ' | ' + String(r.worstSymPnl + '%').padStart(6)
    );
  }
  return { best: results[0], validCount: results.length, loaded: symbols.length };
}

async function main() {
  const { code, years, top, preset, basket, timeframe } = parseArgs();
  if (!STRATEGY_REGISTRY[code]) {
    console.error(`Unknown strategy: ${code}`);
    process.exit(1);
  }
  const grid = PARAM_GRIDS[code];
  if (!grid) {
    console.error(`No grid defined for ${code}`);
    process.exit(1);
  }

  // Resolve basket selector: 'all' → every basket, 'cap'/'sector' → group, else single.
  const basketNames = basket === 'all'
    ? listBaskets()
    : (BASKET_GROUPS[basket] ?? [basket]);
  for (const b of basketNames) {
    try { getBasket(b); } catch (e) { console.error(e.message); process.exit(1); }
  }

  console.log(`Multi-symbol tuning ${code}`);
  console.log(`  baskets : ${basketNames.join(', ')}`);
  console.log(`  tf      : ${timeframe}`);
  console.log(`  years   : ${years}${INTRADAY_MAX_DAYS[timeframe] ? ` (capped to ${INTRADAY_MAX_DAYS[timeframe]}d intraday)` : ''}`);
  console.log(`  preset  : ${preset}`);
  console.log(`  combos  : ${gridSize(grid)}`);
  console.log();

  const matrix = [];
  for (const name of basketNames) {
    const symbols = getBasket(name);
    const label = BASKET_META[name]?.label ?? name;
    console.log(`\n══ ${name} (${label}) — ${symbols.length} symbols ══`);
    console.log('Fetching bars...');
    const barsCache = await fetchBars({ symbols, timeframe, years });
    const loaded = Object.keys(barsCache).length;
    if (!loaded) { console.log('  no bars, skipping'); continue; }
    console.log(`Loaded ${loaded} symbols`);

    const res = await sweepBasket({ code, grid, barsCache, timeframe, preset, top });
    if (res) {
      matrix.push({ basket: name, ...res.best, loaded: res.loaded });
      if (basketNames.length === 1) {
        console.log();
        console.log('Best combo:');
        console.log(JSON.stringify(res.best.params, null, 2));
      }
    }
  }

  // Cross-basket matrix (only meaningful for --basket all / multi)
  if (basketNames.length > 1 && matrix.length) {
    console.log(`\n\n══ Cross-basket summary for ${code} (tf=${timeframe}) ══`);
    console.log('Basket'.padEnd(12) + ' | Prof   | TotPnL  | AvgPnL | Best params');
    console.log('-'.repeat(12) + ' | ------ | ------- | ------ | -----------');
    for (const m of matrix) {
      const ps = Object.entries(m.params).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(
        m.basket.padEnd(12) +
        ' | ' + String(m.profitable + '/' + m.loaded).padStart(6) +
        ' | ' + String(m.totPnl + '%').padStart(7) +
        ' | ' + String(m.avgPnl + '%').padStart(6) +
        ' | ' + ps
      );
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
