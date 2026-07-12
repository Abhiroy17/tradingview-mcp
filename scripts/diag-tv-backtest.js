/**
 * Diagnostic: Run the TV backtest pipeline step-by-step and report what happens.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClient } from '../src/connection.js';
import { setSymbol, setTimeframe } from '../src/core/chart.js';
import { setSource, smartCompile, getErrors } from '../src/core/pine.js';
import { openPanel } from '../src/core/ui.js';
import { getStrategyResults } from '../src/core/data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pineFile = path.resolve(__dirname, '..', 'pdf', 'profitable', 'fibonacci_india_swing.pine');

async function main() {
  const source = await fs.readFile(pineFile, 'utf8');
  console.log(`Pine source: ${source.length} chars`);

  console.log('\n--- Step 1: getClient() ---');
  const c = await getClient();
  console.log('Connected to CDP OK');

  console.log('\n--- Step 2: setSymbol ---');
  const symRes = await setSymbol({ symbol: 'NSE:NIFTY' });
  console.log('setSymbol result:', JSON.stringify(symRes));

  console.log('\n--- Step 3: setTimeframe ---');
  const tfRes = await setTimeframe({ timeframe: 'D' });
  console.log('setTimeframe result:', JSON.stringify(tfRes));

  console.log('\n--- Step 4: setSource ---');
  const srcRes = await setSource({ source });
  console.log('setSource result:', JSON.stringify(srcRes));

  console.log('\n--- Step 5: smartCompile ---');
  const compRes = await smartCompile();
  console.log('smartCompile result:', JSON.stringify(compRes));

  console.log('\n--- Step 6: getErrors ---');
  const errRes = await getErrors();
  console.log('Errors:', JSON.stringify(errRes));

  console.log('\n--- Step 7: openPanel(strategy-tester) ---');
  try {
    await openPanel({ panel: 'strategy-tester', action: 'open' });
    console.log('Panel opened OK');
  } catch (e) { console.log('Panel error:', e.message); }

  console.log('\n--- Step 8: Poll for strategy results ---');
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await getStrategyResults();
    const metricCount = Object.keys(res?.metrics || {}).length;
    console.log(`  Poll ${i+1}: metric_count=${metricCount}, error=${res?.error || 'none'}`);
    if (metricCount > 0) {
      console.log('  Metrics:', JSON.stringify(res.metrics).slice(0, 300));
      break;
    }
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
