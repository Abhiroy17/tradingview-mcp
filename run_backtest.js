#!/usr/bin/env node
/**
 * Comprehensive Strategy Backtest - All strategies on AGIIL and SHILPATRX
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Phase A roster: production + experimental tier only. Orphans deleted in Phase A cleanup.
const strategies = [
  { id: 1, name: 'RSI(2) India Swing',        file: 'pdf/profitable/rsi2_india_swing.pine' },
  { id: 2, name: 'IBS India Swing',           file: 'pdf/profitable/ibs_india_swing.pine' },
  { id: 3, name: 'IBS India Intraday',        file: 'pdf/profitable/ibs_india_intraday.pine' },
  { id: 4, name: 'Fibonacci India Swing',     file: 'pdf/profitable/fibonacci_india_swing.pine' },
  { id: 5, name: '200-SMA Trend Positional',  file: 'pdf/untested/trend_200sma_positional.pine' },
  { id: 6, name: 'Overnight Swing (Exp)',     file: 'pdf/untested/overnight_swing.pine' },
  { id: 7, name: 'Monday Reversal (Exp)',     file: 'pdf/untested/monday_reversal.pine' },
  { id: 8, name: 'IBS Mean Reversion (Base)', file: 'pdf/untested/ibs_mean_reversion.pine' }
];

const symbols = ['NSE:AGIIL', 'NSE:SHILPATRX'];

async function runCommand(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', args, {
      cwd: process.cwd(),
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (e) {
          resolve({ success: false, raw: stdout });
        }
      } else {
        resolve({ success: false, error: stderr || stdout });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    setTimeout(() => {
      proc.kill();
      resolve({ success: false, error: 'timeout' });
    }, timeout + 1000);
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function backtest() {
  const results = {};
  
  console.log('\n🚀 STARTING COMPREHENSIVE BACKTEST SUITE\n');
  console.log(`Testing ${strategies.length} strategies × ${symbols.length} symbols = ${strategies.length * symbols.length} backtests\n`);

  for (const symbol of symbols) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  SYMBOL: ${symbol}`);
    console.log(`${'='.repeat(60)}\n`);

    // Switch symbol
    await runCommand(['src/cli/index.js', 'symbol', symbol]);
    await sleep(1000);

    results[symbol] = {};

    for (const strategy of strategies) {
      process.stdout.write(`[${strategy.id}/6] ${strategy.name.padEnd(30)} ... `);

      // Create new strategy slot
      await runCommand(['src/cli/index.js', 'pine', 'new', 'strategy']);
      await sleep(500);

      // Load strategy file
      await runCommand(['src/cli/index.js', 'pine', 'set', '--file', strategy.file]);
      await sleep(500);

      // Compile
      await runCommand(['src/cli/index.js', 'pine', 'raw-compile']);
      await sleep(2000); // Wait for backtest engine

      // Get trades
      const tradesResult = await runCommand(['src/cli/index.js', 'data', 'trades', '--max', '100'], 20000);

      if (tradesResult.success && tradesResult.trades) {
        const trades = tradesResult.trades;
        
        // Calculate basic metrics
        const entries = trades.filter(t => t.e === true).length;
        const wins = trades.filter(t => t.b === false && t.p > 0).length; // Simplified
        const winRate = entries > 0 ? (wins / entries * 100).toFixed(1) : '0';

        results[symbol][strategy.name] = {
          trades: trades.length,
          entries: entries,
          file: strategy.file
        };

        console.log(`✓ ${trades.length} trades | Win: ${winRate}%`);
      } else {
        results[symbol][strategy.name] = { trades: 0, error: tradesResult.error };
        console.log(`✗ Error: ${tradesResult.error}`);
      }

      await sleep(1000); // Breathing room between strategies
    }
  }

  // Generate summary report
  console.log('\n\n' + '='.repeat(80));
  console.log('BACKTEST SUMMARY REPORT');
  console.log('='.repeat(80) + '\n');

  console.log('Strategy'.padEnd(35) + 'AGIIL'.padEnd(20) + 'SHILPA'.padEnd(20) + 'Winner');
  console.log('-'.repeat(80));

  for (const strategy of strategies) {
    const agiilData = results['NSE:AGIIL'][strategy.name];
    const shilpaData = results['NSE:SHILPATRX'][strategy.name];

    const agiilTrades = agiilData?.trades || 0;
    const shilpaTrades = shilpaData?.trades || 0;
    
    const winner = agiilTrades > shilpaTrades ? '🏆 AGIIL' : 
                   shilpaTrades > agiilTrades ? '🏆 SHILPA' : '➖ TIE';

    console.log(
      strategy.name.padEnd(35) +
      `${agiilTrades} trades`.padEnd(20) +
      `${shilpaTrades} trades`.padEnd(20) +
      winner
    );
  }

  // Save detailed JSON
  fs.writeFileSync('backtest_results.json', JSON.stringify(results, null, 2));
  console.log('\n✅ Detailed results saved to backtest_results.json\n');

  // Find best performers
  console.log('\nTOP PERFORMERS:');
  console.log('-'.repeat(60));
  
  const allResults = [];
  for (const symbol of symbols) {
    for (const strategy of strategies) {
      const data = results[symbol][strategy.name];
      if (data && data.trades > 0) {
        allResults.push({
          strategy: strategy.name,
          symbol,
          trades: data.trades
        });
      }
    }
  }

  allResults.sort((a, b) => b.trades - a.trades);
  allResults.slice(0, 5).forEach((r, i) => {
    console.log(`${i + 1}. ${r.strategy} on ${r.symbol}: ${r.trades} trades`);
  });

  console.log('\n');
}

backtest().catch(console.error);
