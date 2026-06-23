#!/usr/bin/env node

/**
 * Live Market Monitor — RSI(2) Mean Reversion Signals
 * 
 * Polls TradingView via MCP every 60s during NSE market hours (9:15 AM - 3:30 PM IST).
 * Generates BUY/SELL alerts based on the profitable RSI(2) strategy logic.
 * 
 * Usage:
 *   node live_monitor.js                    # Monitor current chart symbol
 *   node live_monitor.js --symbol AGIIL     # Specify symbol
 *   node live_monitor.js --interval 30000   # Poll every 30s
 *   node live_monitor.js --no-market-check  # Run outside market hours (for testing)
 * 
 * Requirements:
 *   - TradingView Desktop running with --remote-debugging-port=9222
 *   - RSI indicator loaded on chart (will auto-add if missing)
 */

import { evaluate, getClient } from './src/connection.js';

// ── Configuration ──

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const MODEL = `${CHART_API}._chartWidget.model()`;

const CONFIG = {
  // RSI(2) Mean Reversion Parameters (matches profitable backtest)
  rsi_length: 2,
  rsi_oversold: 30,       // BUY when RSI(2) crosses below this
  rsi_exit: 50,           // SELL when RSI(2) crosses above this
  volume_sma_length: 20,  // Volume must be above 20-SMA
  tp_percent: 1.5,        // Take profit %
  sl_percent: 1.0,        // Stop loss %
  max_bars_held: 5,       // Max bars to hold

  // Polling
  interval: 60000,        // 60 seconds default
  market_open: '09:15',   // NSE opens
  market_close: '15:30',  // NSE closes

  // State
  position: null,         // null | { entry_price, entry_time, bars_held }
};

// ── Parse CLI args ──

const args = process.argv.slice(2);
let skipMarketCheck = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--interval' && args[i + 1]) {
    CONFIG.interval = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--no-market-check') {
    skipMarketCheck = true;
  }
}

// ── Helpers ──

function getIST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

function isMarketOpen() {
  if (skipMarketCheck) return true;
  const now = getIST();
  const day = now.getDay();
  if (day === 0 || day === 6) return false; // Weekend

  const hhmm = now.getHours() * 100 + now.getMinutes();
  const open = 915;
  const close = 1530;
  return hhmm >= open && hhmm <= close;
}

function timestamp() {
  return getIST().toLocaleTimeString('en-IN', { hour12: false });
}

function log(level, msg) {
  const icons = { BUY: '🟢', SELL: '🔴', INFO: 'ℹ️', WARN: '⚠️', EXIT: '🟡', TP: '💰', SL: '🛑' };
  console.log(`[${timestamp()}] ${icons[level] || '•'} ${level}: ${msg}`);
}

// ── Core: Fetch live data from TradingView ──

async function fetchLiveData() {
  const result = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API};
        var m = ${MODEL};
        var bars = m.mainSeries().bars();
        var last = bars.lastIndex();
        
        // Get last 25 bars for RSI(2) + volume SMA(20) calculation, plus bar timestamps
        // so the JS strategy can tell when a bar has actually closed (vs. an intra-bar tick poll).
        var times = [];
        var closes = [];
        var volumes = [];
        for (var i = Math.max(0, last - 24); i <= last; i++) {
          var v = bars.valueAt(i);
          if (v) {
            times.push(v[0]);    // bar open time (unix seconds)
            closes.push(v[4]);   // close
            volumes.push(v[5] || 0); // volume
          }
        }
        
        return {
          symbol: chart.symbol(),
          timeframe: chart.resolution(),
          close: closes[closes.length - 1],
          prev_close: closes[closes.length - 2],
          high: bars.valueAt(last) ? bars.valueAt(last)[2] : null,
          low: bars.valueAt(last) ? bars.valueAt(last)[3] : null,
          times: times,
          closes: closes,
          volumes: volumes,
        };
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);
  return result;
}

// ── RSI Calculation ──

function calculateRSI(closes, period) {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  // Initial average
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smoothed (Wilder's method)
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ── Signal Logic ──
//
// IMPORTANT: RSI(2) is computed on partial in-progress bars when polled live, which
// makes its value swing wildly between ticks within the same bar (e.g. 2 → 80 in a
// single up-tick). The Pine reference (pdf/profitable/rsi2_india_swing.pine)
// evaluates the exit `rsi > 50` exactly once per bar at the close. We mirror that here:
//   - Entry uses live RSI (so a fresh oversold tick triggers a buy mid-bar — desired).
//   - Exit (RSI / max-bars) uses the last fully closed bar's RSI, only on a true bar
//     transition, and never on the same bar as entry.
//   - TP/SL stay tick-based (matches Pine `strategy.exit` limit/stop semantics).

let prevRSI = null;
let lastSeenBarTime = null;

function checkSignals(data) {
  const { closes, volumes, times } = data;
  const signals = [];

  if (!closes || closes.length < CONFIG.rsi_length + 2) return signals;

  // Live RSI — for entry decisions
  const liveRSI = calculateRSI(closes, CONFIG.rsi_length);
  if (liveRSI === null) return signals;

  // Closed-bar RSI — for exit decisions (drops the in-progress last bar)
  const closedRSI = closes.length >= CONFIG.rsi_length + 2
    ? calculateRSI(closes.slice(0, -1), CONFIG.rsi_length)
    : null;

  const inProgressBarTime = times && times.length ? times[times.length - 1] : null;
  const justClosedBarTime = times && times.length >= 2 ? times[times.length - 2] : null;
  if (lastSeenBarTime == null) lastSeenBarTime = inProgressBarTime;
  const isNewBar = inProgressBarTime != null && inProgressBarTime !== lastSeenBarTime;

  const volumeSMA = calculateSMA(volumes, CONFIG.volume_sma_length);
  const currentVolume = volumes[volumes.length - 1];
  const volumeOK = volumeSMA ? currentVolume > volumeSMA : true;

  const currentPrice = closes[closes.length - 1];

  // ── ENTRY: RSI(2) below oversold + volume confirmation (live tick) ──
  if (CONFIG.position === null) {
    if (liveRSI < CONFIG.rsi_oversold && volumeOK) {
      CONFIG.position = {
        entry_price: currentPrice,
        entry_time: Date.now(),
        entry_bar_time: inProgressBarTime,
        bars_held: 0,
      };
      const tp = (currentPrice * (1 + CONFIG.tp_percent / 100)).toFixed(2);
      const sl = (currentPrice * (1 - CONFIG.sl_percent / 100)).toFixed(2);

      signals.push({
        type: 'BUY',
        message: `BUY ${data.symbol} @ ₹${currentPrice} | RSI(2)=${liveRSI.toFixed(1)} | TP=₹${tp} SL=₹${sl}`,
      });
    }
  }
  // ── EXIT CONDITIONS ──
  else {
    const { entry_price, entry_bar_time, bars_held } = CONFIG.position;
    const pnl = ((currentPrice - entry_price) / entry_price * 100).toFixed(2);

    // TP / SL — tick-based (realistic for live stops/targets)
    if (currentPrice >= entry_price * (1 + CONFIG.tp_percent / 100)) {
      signals.push({
        type: 'TP',
        message: `TAKE PROFIT ${data.symbol} @ ₹${currentPrice} | P&L: +${pnl}% | Bars: ${bars_held}`,
      });
      CONFIG.position = null;
    } else if (currentPrice <= entry_price * (1 - CONFIG.sl_percent / 100)) {
      signals.push({
        type: 'SL',
        message: `STOP LOSS ${data.symbol} @ ₹${currentPrice} | P&L: ${pnl}% | Bars: ${bars_held}`,
      });
      CONFIG.position = null;
    } else if (isNewBar && justClosedBarTime !== entry_bar_time) {
      // RSI exit + max-bars exit — only on a freshly closed bar that isn't the entry bar.
      CONFIG.position.bars_held++;
      const heldNow = CONFIG.position.bars_held;

      if (closedRSI !== null && closedRSI > CONFIG.rsi_exit) {
        signals.push({
          type: 'EXIT',
          message: `EXIT (RSI>${CONFIG.rsi_exit}) ${data.symbol} @ ₹${currentPrice} | RSI(2)=${closedRSI.toFixed(1)} | P&L: ${pnl}% | Bars: ${heldNow}`,
        });
        CONFIG.position = null;
      } else if (heldNow >= CONFIG.max_bars_held) {
        signals.push({
          type: 'EXIT',
          message: `EXIT (max bars) ${data.symbol} @ ₹${currentPrice} | P&L: ${pnl}% | Bars: ${heldNow}`,
        });
        CONFIG.position = null;
      }
    }
  }

  if (isNewBar) lastSeenBarTime = inProgressBarTime;
  prevRSI = liveRSI;
  return signals;
}

// ── Main Loop ──

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   RSI(2) MEAN REVERSION — LIVE MONITOR                     ║');
  console.log('║   Strategy: Buy RSI(2)<30 + Volume, Exit RSI>50/TP/SL      ║');
  console.log('║   Poll interval: ' + (CONFIG.interval / 1000) + 's | Market: 9:15-15:30 IST          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Verify connection
  try {
    await getClient();
    log('INFO', 'Connected to TradingView Desktop via CDP');
  } catch (e) {
    log('WARN', `Cannot connect to TradingView: ${e.message}`);
    log('WARN', 'Ensure TradingView is running with --remote-debugging-port=9222');
    process.exit(1);
  }

  // Initial data check
  const initial = await fetchLiveData();
  if (initial?.error) {
    log('WARN', `Chart error: ${initial.error}`);
    process.exit(1);
  }
  log('INFO', `Monitoring: ${initial.symbol} (${initial.timeframe}) @ ₹${initial.close}`);
  log('INFO', `Position: ${CONFIG.position ? 'LONG @ ₹' + CONFIG.position.entry_price : 'FLAT'}`);
  console.log('─'.repeat(60));

  // Poll loop
  let tick = 0;
  while (true) {
    if (!isMarketOpen()) {
      if (tick === 0) log('INFO', 'Market closed. Waiting for 9:15 AM IST...');
      await sleep(30000); // check every 30s when market closed
      tick++;
      continue;
    }

    try {
      const data = await fetchLiveData();
      if (!data || data.error) {
        log('WARN', `Fetch error: ${data?.error || 'no data'}`);
        await sleep(5000);
        continue;
      }

      const rsi = calculateRSI(data.closes, CONFIG.rsi_length);
      const signals = checkSignals(data);

      // Log each signal with sound bell
      for (const signal of signals) {
        process.stdout.write('\x07'); // Terminal bell
        log(signal.type, signal.message);
      }

      // Periodic status (every 5 minutes)
      if (tick % Math.ceil(300000 / CONFIG.interval) === 0) {
        const posInfo = CONFIG.position
          ? `LONG @ ₹${CONFIG.position.entry_price} (${CONFIG.position.bars_held} bars)`
          : 'FLAT';
        log('INFO', `${data.symbol} ₹${data.close} | RSI(2)=${rsi?.toFixed(1) || 'N/A'} | Pos: ${posInfo}`);
      }

      tick++;
    } catch (err) {
      if (/CDP|ECONNREFUSED/i.test(err.message)) {
        log('WARN', 'Connection lost. Retrying in 5s...');
        await sleep(5000);
        continue;
      }
      log('WARN', `Error: ${err.message}`);
    }

    await sleep(CONFIG.interval);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Run ──
main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
