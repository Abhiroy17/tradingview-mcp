/**
 * Quick test for /api/v2/rank endpoint.
 *
 * Runs a real scan across 5 strategy/symbol pairs, then ranks them.
 */
import { v2Router } from '../src/api/v2.js';
import { EventEmitter } from 'node:events';

function mkReq(method, body, url) {
  const r = new EventEmitter();
  r.method = method;
  r.url = url;
  setImmediate(() => {
    if (body) r.emit('data', Buffer.from(JSON.stringify(body)));
    r.emit('end');
  });
  return r;
}

const res = {
  status: 0,
  body: '',
  writeHead(s) { this.status = s; },
  end(b) { this.body = b || ''; },
};

const handled = await v2Router(
  mkReq('POST', {
    jobs: [
      { code: 'ibs_india_swing',          symbol: 'NSE:RELIANCE', timeframe: '1D' },
      { code: 'ibs_india_intraday',       symbol: 'NSE:RELIANCE', timeframe: '5m' },
      { code: 'fibonacci_india_swing',    symbol: 'NSE:RELIANCE', timeframe: '1D' },
      { code: 'trend_200sma_positional',  symbol: 'NSE:INFY',     timeframe: '1D' },
      { code: 'ibs_india_swing',          symbol: 'NSE:INFY',     timeframe: '1D' },
      { code: 'trend_200sma_positional',  symbol: 'NSE:TCS',      timeframe: '1D' },
    ],
    mode: 'backtest',
    topNPerSymbol: 2,
  }, '/api/v2/rank'),
  res,
  '/api/v2/rank'
);

console.log('handled:', handled, 'status:', res.status);
const parsed = JSON.parse(res.body);
if (!parsed.success) {
  console.error('FAIL:', parsed.error);
  process.exit(1);
}
console.log('totalRanked:', parsed.totalRanked);
console.log();
console.log('Top results:');
for (const r of parsed.topRanked.slice(0, 7)) {
  const sigType = r.result?.currentSignal?.type || '—';
  console.log(`  #${r.rank}  ${(r.code).padEnd(35)} ${(r.symbol).padEnd(15)} score=${String(r.score).padEnd(3)} tier=${(r.tier).padEnd(8)} sig=${sigType.padEnd(8)} :: ${r.explanation}`);
  for (const f of r.factors.slice(0, 3)) {
    console.log(`        ${f.delta >= 0 ? '+' : ''}${f.delta}  ${f.label}`);
  }
}

console.log();
console.log('topNPerSymbol:');
for (const [sym, items] of Object.entries(parsed.topNPerSymbol || {})) {
  console.log(`  ${sym}: ${items.map(it => `${it.code}(${it.score})`).join(', ')}`);
}
