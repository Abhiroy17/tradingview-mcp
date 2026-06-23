#!/usr/bin/env node
/**
 * Backtest Suite - Run all 6 strategies on AGIIL and SHILPATRX
 * Returns results in a consolidated table
 */

const { spawn } = require('child_process');
const fs = require('fs');

// Phase A roster: production + experimental tier only. Orphans deleted in Phase A cleanup.
const strategies = [
  { name: 'RSI(2) India Swing',          file: 'pdf/profitable/rsi2_india_swing.pine' },
  { name: 'IBS India Swing',             file: 'pdf/profitable/ibs_india_swing.pine' },
  { name: 'IBS India Intraday',          file: 'pdf/profitable/ibs_india_intraday.pine' },
  { name: 'Fibonacci India Swing',       file: 'pdf/profitable/fibonacci_india_swing.pine' },
  { name: '200-SMA Trend Positional',    file: 'pdf/untested/trend_200sma_positional.pine' },
  { name: 'Overnight Swing (Exp)',       file: 'pdf/untested/overnight_swing.pine' },
  { name: 'Monday Reversal (Exp)',       file: 'pdf/untested/monday_reversal.pine' },
  { name: 'IBS Mean Reversion (Base)',   file: 'pdf/untested/ibs_mean_reversion.pine' }
];

const symbols = ['NSE:AGIIL', 'NSE:SHILPATRX'];

async function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { 
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      timeout: 30000
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
          resolve({ raw: stdout });
        }
      } else {
        reject(new Error(`Command failed: ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

async function backtest(symbol, strategy) {
  console.log(`\n📊 Testing ${strategy.name} on ${symbol}...`);
  
  try {
    // Switch symbol
    await runCommand('node', ['src/cli/index.js', 'symbol', symbol]);
    
    // New strategy
    await runCommand('node', ['src/cli/index.js', 'pine', 'new', 'strategy']);
    
    // Load strategy
    await runCommand('node', ['src/cli/index.js', 'pine', 'set', '--file', strategy.file]);
    
    // Compile
    const compileResult = await runCommand('node', ['src/cli/index.js', 'pine', 'compile']);
    
    // Get strategy data
    const stratData = await runCommand('node', ['src/cli/index.js', 'data', 'strategy']);
    
    // Get trades
    const trades = await runCommand('node', ['src/cli/index.js', 'data', 'trades', '--max', '50']);
    
    return {
      strategy: strategy.name,
      symbol,
      status: 'success',
      strategy_data: stratData,
      trades: trades.trades || [],
      trade_count: (trades.trades || []).length
    };
  } catch (error) {
    console.error(`  ❌ Error: ${error.message}`);
    return {
      strategy: strategy.name,
      symbol,
      status: 'error',
      error: error.message
    };
  }
}

async function main() {
  console.log('🚀 Starting Backtest Suite...\n');
  console.log(`Testing ${strategies.length} strategies on ${symbols.length} symbols = ${strategies.length * symbols.length} backtests\n`);

  const results = [];

  for (const symbol of symbols) {
    for (const strategy of strategies) {
      const result = await backtest(symbol, strategy);
      results.push(result);
      // Add delay between backtests to prevent race conditions
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Write detailed results
  fs.writeFileSync('backtest_results.json', JSON.stringify(results, null, 2));

  // Generate summary table
  console.log('\n\n=== BACKTEST SUMMARY ===\n');
  console.log('Strategy | AGIIL Trades | SHILPATRX Trades | Winner');
  console.log('---------|--------------|------------------|--------');

  for (const strategy of strategies) {
    const agiilResult = results.find(r => r.symbol === 'NSE:AGIIL' && r.strategy === strategy.name);
    const shilpaResult = results.find(r => r.symbol === 'NSE:SHILPATRX' && r.strategy === strategy.name);
    
    const agiilTrades = agiilResult?.trade_count || 0;
    const shilpaTrades = shilpaResult?.trade_count || 0;
    const winner = agiilTrades > shilpaTrades ? 'AGIIL' : shilpaTrades > agiilTrades ? 'SHILPA' : 'TIE';
    
    console.log(`${strategy.name.padEnd(25)} | ${agiilTrades.toString().padEnd(12)} | ${shilpaTrades.toString().padEnd(16)} | ${winner}`);
  }

  console.log('\n✅ Detailed results saved to backtest_results.json');
}

main().catch(console.error);
