/**
 * Smoke-test the v2 API router by simulating HTTP requests.
 *
 * Doesn't start the full dashboard (which needs CDP/TradingView running).
 * Tests the router function directly with mocked req/res.
 */

import { v2Router } from '../src/api/v2.js';
import { EventEmitter } from 'node:events';

function mockReq({ method, url, body }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  if (body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  } else {
    setImmediate(() => req.emit('end'));
  }
  return req;
}

function mockRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { res.status = status; res.headers = headers || {}; },
    end(payload) { res.body = payload || ''; res.ended = true; },
  };
  return res;
}

async function call(method, path, body) {
  const url = `http://localhost${path}`;
  const req = mockReq({ method, url, body });
  const res = mockRes();
  const pathname = new URL(url).pathname;
  const handled = await v2Router(req, res, pathname);
  return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}  ${info || ''}`); fail++; }
}

console.log('── /api/v2/health');
{
  const r = await call('GET', '/api/v2/health');
  check('handled', r.handled);
  check('200', r.status === 200);
  check('strategies count', r.body?.strategies === 8, `got ${r.body?.strategies}`);
}

console.log('\n── /api/v2/strategies');
{
  const r = await call('GET', '/api/v2/strategies?backtestableOnly=true');
  check('200', r.status === 200);
  check('total >= 5 (production tier)', r.body?.total >= 5, `got ${r.body?.total}`);
}

console.log('\n── /api/v2/strategies (family filter)');
{
  const r = await call('GET', '/api/v2/strategies?family=trend_following');
  check('200', r.status === 200);
  check('only trend_following', r.body?.strategies?.every(s => s.family === 'trend_following'));
  console.log(`    → ${r.body?.total} trend_following strategies`);
}

console.log('\n── /api/v2/strategies/fibonacci_india_swing (single)');
{
  const r = await call('GET', '/api/v2/strategies/fibonacci_india_swing');
  check('200', r.status === 200);
  check('code = fibonacci_india_swing', r.body?.strategy?.code === 'fibonacci_india_swing');
}

console.log('\n── /api/v2/strategies/nonexistent → 404');
{
  const r = await call('GET', '/api/v2/strategies/nonexistent');
  check('404', r.status === 404);
}

console.log('\n── /api/v2/analyze (POST, live mode)');
{
  const r = await call('POST', '/api/v2/analyze', {
    code: 'fibonacci_india_swing', symbol: 'NSE:RELIANCE', timeframe: '1D', mode: 'live',
  });
  check('200', r.status === 200);
  check('returns currentSignal', !!r.body?.result?.currentSignal);
  console.log(`    → ${r.body?.result?.currentSignal?.type} (regime: ${r.body?.result?.regime})`);
}

console.log('\n── /api/v2/scan (POST, batch)');
{
  const r = await call('POST', '/api/v2/scan', {
    jobs: [
      { code: 'fibonacci_india_swing', symbol: 'NSE:RELIANCE', timeframe: '1D' },
      { code: 'ibs_india_swing',  symbol: 'NSE:INFY',     timeframe: '1D' },
    ],
    mode: 'live',
  });
  check('200', r.status === 200);
  check('total = 2', r.body?.total === 2);
  check('bySymbol grouped', !!r.body?.bySymbol?.['NSE:RELIANCE']);
}

console.log('\n── /api/v2/scan/symbol-all (POST)');
{
  const r = await call('POST', '/api/v2/scan/symbol-all', {
    symbol: 'NSE:RELIANCE', timeframe: '1D', mode: 'live',
  });
  check('200', r.status === 200);
  check('daily strategies >= 4', r.body?.total >= 4, `got ${r.body?.total}`);
}

console.log('\n── /api/v2/symbols/search?q=reli');
{
  const r = await call('GET', '/api/v2/symbols/search?q=reli');
  check('200', r.status === 200);
  check('returns matches', Array.isArray(r.body?.matches));
  console.log(`    → ${r.body?.matches?.length} matches; first: ${r.body?.matches?.[0]?.symbol}`);
}

console.log('\n── /api/v2/data/ohlcv?symbol=AAPL&days=60');
{
  const r = await call('GET', '/api/v2/data/ohlcv?symbol=AAPL&days=60');
  check('200', r.status === 200);
  check('returns bars', r.body?.count > 30, `got ${r.body?.count} bars`);
  check('provider tagged', r.body?.provider === 'yahoo');
}

console.log('\n── /api/v2/analyze error path (missing symbol)');
{
  const r = await call('POST', '/api/v2/analyze', { code: 'fibonacci_india_swing' });
  check('400', r.status === 400);
  check('error message', r.body?.error?.includes('symbol'));
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail > 0 ? 1 : 0);
