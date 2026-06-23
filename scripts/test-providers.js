#!/usr/bin/env node
/**
 * Smoke-test all data providers against a few well-known symbols.
 *
 * Usage:
 *   node scripts/test-providers.js
 *   node scripts/test-providers.js AAPL
 *   node scripts/test-providers.js NSE:RELIANCE 1D
 */

import 'dotenv/config';
import { getHistorical, searchSymbol, describeRouting } from '../src/data/index.js';

const [, , symArg, tfArg] = process.argv;

const TARGETS = symArg
  ? [{ symbol: symArg, timeframe: tfArg || '1D' }]
  : [
      { symbol: 'AAPL',         timeframe: '1D' },
      { symbol: 'SPY',          timeframe: '1D' },
      { symbol: 'NSE:RELIANCE', timeframe: '1D' },
      { symbol: 'BTC-USD',      timeframe: '1D' },
    ];

function fmt(n) { return typeof n === 'number' ? n.toFixed(2) : '-'; }

async function run() {
  console.log('Provider smoke test\n');
  for (const t of TARGETS) {
    const routing = describeRouting(t.symbol).join(' → ');
    process.stdout.write(`[${t.symbol} @ ${t.timeframe}] routing: ${routing}  ... `);
    const started = Date.now();
    try {
      const res = await getHistorical({
        symbol: t.symbol,
        timeframe: t.timeframe,
        limit: 30,
      });
      const ms = Date.now() - started;
      const first = res.bars[0];
      const last = res.bars[res.bars.length - 1];
      console.log(
        `OK in ${ms}ms — ${res.bars.length} bars via ${res.provider}${res.cached ? ' [cached]' : ''}\n` +
        `   first: ${first ? new Date(first.time * 1000).toISOString().slice(0, 10) : '-'} close=${fmt(first?.close)}\n` +
        `   last : ${last ? new Date(last.time * 1000).toISOString().slice(0, 10) : '-'} close=${fmt(last?.close)}`,
      );
    } catch (err) {
      console.log(`FAIL — ${err.message}`);
    }
  }

  if (!symArg) {
    console.log('\nSymbol search test ("reli"):');
    try {
      const hits = await searchSymbol('reli');
      hits.slice(0, 5).forEach(h => console.log(`   ${h.symbol.padEnd(20)} ${h.type.padEnd(8)} ${h.name}`));
    } catch (err) {
      console.log(`   FAIL — ${err.message}`);
    }
  }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
