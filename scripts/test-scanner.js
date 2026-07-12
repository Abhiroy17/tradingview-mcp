/**
 * Test parallel scanner on a small matrix.
 */
import { scanMatrix, scanSymbolAllStrategies, actionableOnly, groupBySymbol } from '../src/engine/index.js';

console.log('\n── Test 1: scanMatrix (4 jobs)');
const matrixStart = Date.now();
const m = await scanMatrix({
  jobs: [
    { code: 'fibonacci_india_swing', symbol: 'NSE:RELIANCE', timeframe: '1D' },
    { code: 'fibonacci_india_swing', symbol: 'NSE:INFY',     timeframe: '1D' },
    { code: 'fibonacci_india_swing', symbol: 'NSE:TCS',      timeframe: '1D' },
    { code: 'fibonacci_india_swing', symbol: 'NSE:HDFCBANK', timeframe: '1D' },
  ],
  mode: 'live',
  concurrency: 4,
  onProgress: ({ done, total, last }) => {
    process.stdout.write(`\r  ${done}/${total} (last: ${last.code} ${last.symbol})    `);
  },
});
console.log(`\n  done in ${Date.now() - matrixStart}ms\n`);
for (const r of m) {
  if (r.ok) {
    console.log(`    ${r.symbol.padEnd(8)} ${r.result.currentSignal?.type ?? '?'}   regime=${r.result.regime ?? '-'}`);
  } else {
    console.log(`    ${r.symbol.padEnd(8)} FAIL: ${r.error}`);
  }
}

console.log('\n── Test 2: scanSymbolAllStrategies on NSE:RELIANCE (live)');
const allStart = Date.now();
const all = await scanSymbolAllStrategies('NSE:RELIANCE', '1D', {
  mode: 'live',
  concurrency: 8,
  filter: (meta) => meta.timeframes.includes('1D'),
});
console.log(`  ran ${all.length} strategies in ${Date.now() - allStart}ms`);
const actionable = actionableOnly(all);
console.log(`  ${actionable.length} actionable signals on AAPL right now:`);
for (const r of actionable) {
  console.log(`    [${r.result.currentSignal.type.padEnd(8)}] ${r.code}`);
}

console.log('\n── Test 3: 2 symbols × 3 strategies grouped');
const grid = await scanMatrix({
  jobs: [
    { code: 'fibonacci_india_swing',   symbol: 'NSE:RELIANCE', timeframe: '1D' },
    { code: 'ibs_india_swing',         symbol: 'NSE:RELIANCE', timeframe: '1D' },
    { code: 'trend_200sma_positional', symbol: 'NSE:RELIANCE', timeframe: '1D' },
    { code: 'fibonacci_india_swing',   symbol: 'NSE:INFY',     timeframe: '1D' },
    { code: 'ibs_india_swing',         symbol: 'NSE:INFY',     timeframe: '1D' },
    { code: 'trend_200sma_positional', symbol: 'NSE:INFY',     timeframe: '1D' },
  ],
  mode: 'live',
  concurrency: 6,
});
const grouped = groupBySymbol(grid);
for (const [symbol, codes] of Object.entries(grouped)) {
  console.log(`  ${symbol}:`);
  for (const [code, r] of Object.entries(codes)) {
    console.log(`    ${code.padEnd(20)} → ${r.ok ? r.result.currentSignal.type : 'ERR'}`);
  }
}

console.log('\n✓ All scanner tests done');
