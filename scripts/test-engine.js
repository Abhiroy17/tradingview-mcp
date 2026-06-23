/**
 * Smoke test the symbol-aware strategy engine end-to-end.
 *
 * Runs ~5 representative strategies on AAPL, SPY, and NSE:RELIANCE to
 * confirm:
 *   - Data router fetches bars
 *   - Each strategy module loads via dynamic import
 *   - runStrategy() returns sane metrics + currentSignal
 */

import { runStrategy, STRATEGY_CODES } from '../src/engine/index.js';

const TESTS = [
  { code: 'rsi2_india_swing',         symbol: 'NSE:RELIANCE', timeframe: '1D' },
  { code: 'ibs_india_swing',          symbol: 'NSE:RELIANCE', timeframe: '1D' },
  { code: 'ibs_india_intraday',       symbol: 'NSE:RELIANCE', timeframe: '5m' },
  { code: 'fibonacci_india_swing',    symbol: 'NSE:HDFCBANK', timeframe: '1D' },
  { code: 'trend_200sma_positional',  symbol: 'NSE:TCS',      timeframe: '1D' },
];

console.log(`Registry has ${STRATEGY_CODES.length} strategies\n`);

let pass = 0, fail = 0;
for (const t of TESTS) {
  process.stdout.write(`  ${t.code.padEnd(28)} on ${t.symbol.padEnd(16)} (${t.timeframe}) ... `);
  const start = Date.now();
  try {
    const r = await runStrategy({ ...t, mode: 'backtest', lookbackDays: 730 });
    const ms = Date.now() - start;
    if (!r) throw new Error('null result');
    const wr = r.winRate ?? 0;
    const trades = r.totalTrades ?? 0;
    const pf = r.profitFactor ?? 0;
    const sig = r.currentSignal?.type ?? '?';
    const bars = r.barsAnalyzed ?? 0;
    console.log(`OK  ${ms}ms  bars=${bars}  trades=${trades}  WR=${wr}%  PF=${pf}  signal=${sig}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    fail++;
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
