#!/usr/bin/env node

/**
 * Trading Alert Dashboard — API Server + React UI
 * 
 * Provides:
 *   - REST API for strategy monitoring, watchlist, price alerts
 *   - SSE (Server-Sent Events) for real-time updates
 *   - Serves built React UI from ui-dist/
 * 
 * Usage:
 *   node dashboard.js              # Starts on http://localhost:3456
 *   node dashboard.js --port 8080  # Custom port
 * 
 * Development:
 *   cd ui && npm run dev           # React dev server on :3457 (proxies API to :3456)
 * 
 * Requirements:
 *   - TradingView Desktop running with --remote-debugging-port=9222
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env before anything reads process.env
import dotenv from 'dotenv';
dotenv.config();

import { evaluate, getClient } from './src/connection.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setSource as pineSetSource, smartCompile as pineSmartCompile, getErrors as pineGetErrors, ensurePineEditorOpen, compile as pineCompile } from './src/core/pine.js';
import { openPanel } from './src/core/ui.js';
import { setTimeframe as chartSetTimeframe } from './src/core/chart.js';
import { v2Router } from './src/api/v2.js';
import { maybeAutoStart as schedulerMaybeAutoStart, stopScheduler } from './src/engine/scheduler.js';
import { isNseSessionBar } from './src/engine/india-session.js';
import { scanMatrix as engineScanMatrix } from './src/engine/scanner.js';
import {
  dbGetWatchlist, dbAddToWatchlist, dbBulkAddToWatchlist,
  dbRemoveFromWatchlist, dbPurgeMunafaScans, dbInsertMunafaScan,
  dbGetTodayMunafaScans, dbUpdateMunafaScores, dbMarkAutoWatchlisted,
} from './src/db/watchlist.js';
import { isDbConfigured } from './src/db/client.js';
import { STRATEGY_CODES } from './src/engine/registry.js';
import { getTelegram, initTelegram } from './src/integrations/telegram.js';
import { startMorningScheduler, stopMorningScheduler } from './src/engine/morning-scheduler.js';

// ── Headless mode (cloud deployment — no TradingView Desktop needed) ──
const HEADLESS = process.env.HEADLESS === 'true';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '3456', 10);
const UI_DIST = path.join(__dirname, 'ui-dist');
const DATA_DIR = path.join(__dirname, '.data');
const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const MODEL = `${CHART_API}._chartWidget.model()`;

// ── Persistent Storage ──

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJSON(filename, defaultValue) {
  try {
    const filePath = path.join(DATA_DIR, filename);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) { /* corrupted file, use default */ }
  return defaultValue;
}

function saveJSON(filename, data) {
  try {
    ensureDataDir();
    const filePath = path.join(DATA_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) { /* non-critical */ }
}

// Debounced save to avoid excessive writes
const saveTimers = {};
function debouncedSave(filename, getData, delay = 2000) {
  if (saveTimers[filename]) clearTimeout(saveTimers[filename]);
  saveTimers[filename] = setTimeout(() => saveJSON(filename, getData()), delay);
}

// ── Windows Desktop Notifications ──

function sendDesktopNotification(title, message) {
  if (process.platform === 'win32') {
    const ps = `
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
      [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
      $template = @"
      <toast>
        <visual>
          <binding template="ToastGeneric">
            <text>$($args[0])</text>
            <text>$($args[1])</text>
          </binding>
        </visual>
        <audio src="ms-winsoundevent:Notification.Default"/>
      </toast>
"@
      $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
      $xml.LoadXml($template)
      $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Trading Dashboard").Show($toast)
    `;
    const safe_title = title.replace(/"/g, '`"').replace(/\$/g, '`$');
    const safe_msg = message.replace(/"/g, '`"').replace(/\$/g, '`$');
    execFile('powershell', ['-NoProfile', '-Command', ps.replace('$($args[0])', safe_title).replace('$($args[1])', safe_msg)], { stdio: 'ignore' }, () => {});
  }
}

// MIME types for static file serving
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ── State (loaded from persistent storage) ──

ensureDataDir();

let monitoring = false;
let monitorInterval = null;
let alerts = loadJSON('alerts.json', []);
let currentSymbol = '';
let activeStrategies = [];
let positions = {};
let lastData = null;
let watchlist = loadJSON('watchlist.json', []);
let priceAlerts = loadJSON('price-alerts.json', []);
let tradeHistory = loadJSON('trades.json', []);
let scannerEnabled = false;
let scannerInterval = null;
let settings = loadJSON('settings.json', {
  notifications: true,
  tipsSource: {
    enabled: false,
    provider: 'munafasutra',
    urls: [
      'https://munafasutra.com/nse/intradayTradingTips/',
      'https://munafasutra.com/nse/BestIntradayTips',
    ],
    includeIntradayTradingTips: true,
    includeBestIntradayTips: true,
    maxSymbols: 500,
    pollMs: 300000,
    scannerIntervalMs: 120000,
    matrixIntervalMs: 120000,
    matrixTimeframe: '1D',
    matrixMode: 'backtest',
    matrixUseAllStrategies: true,
    matrixStrategies: [],
    onlyMarketHours: true,
    includePremarket: true,
    autoStartScanner: true,
    autoStartMatrixScanner: true,
  },
  telegram: {
    enabled: false,
    botToken: '',
    chatId: '',
    morningDigest: true,
    scanAlerts: true,
    priceAlerts: true,
    commands: true,
  },
});
let notificationsEnabled = settings.notifications;

// ── Live Feed Ring Buffer (for AI Agent / MCP pull-based streaming) ──
let liveFeed = [];
let liveFeedSeq = 0;
const LIVE_FEED_MAX = 500;
const LIVE_FEED_FILE = path.join(DATA_DIR, 'live-feed.jsonl');
let liveFeedWriteChain = Promise.resolve();

// Restore seq from last line of JSONL so cursors survive dashboard restarts
try {
  if (fs.existsSync(LIVE_FEED_FILE)) {
    const buf = fs.readFileSync(LIVE_FEED_FILE, 'utf8');
    const lines = buf.trim().split('\n').filter(Boolean);
    if (lines.length) {
      const last = JSON.parse(lines[lines.length - 1]);
      if (typeof last.seq === 'number') liveFeedSeq = last.seq;
    }
  }
} catch {}

function pushLiveEvent(type, payload) {
  liveFeedSeq++;
  const event = { seq: liveFeedSeq, ts: Date.now(), type, ...payload };
  liveFeed.push(event);
  if (liveFeed.length > LIVE_FEED_MAX) liveFeed = liveFeed.slice(-LIVE_FEED_MAX);
  // Async append, chained to preserve order, errors swallowed
  liveFeedWriteChain = liveFeedWriteChain.then(async () => {
    try {
      await fs.promises.appendFile(LIVE_FEED_FILE, JSON.stringify(event) + '\n');
      // Rotate at 5MB
      const stat = await fs.promises.stat(LIVE_FEED_FILE);
      if (stat.size > 5 * 1024 * 1024) {
        const rotated = LIVE_FEED_FILE + '.1';
        try { await fs.promises.unlink(rotated); } catch {}
        await fs.promises.rename(LIVE_FEED_FILE, rotated);
      }
    } catch {}
  });
}

// ── Strategy Engines ──

const STRATEGIES = {
  rsi2: {
    name: 'RSI(2) Mean Reversion',
    description: 'Buy RSI(2)<30 + Volume; Exit RSI>50/TP/SL — bar-close evaluation (matches Pine reference)',
    params: { rsi_length: 2, oversold: 30, exit: 50, vol_len: 20, tp: 1.5, sl: 1.0, max_bars: 5 },
    prevRSI: null,
    lastSeenBarTime: null,
    check(closes, volumes, price, highs, lows, times) {
      if (!closes || closes.length < this.params.rsi_length + 2) return null;

      // Live RSI (uses in-progress bar) — used only for ENTRY, where catching a fresh
      // oversold reading mid-bar is the intent.
      const liveRSI = calcRSI(closes, this.params.rsi_length);
      if (liveRSI === null) return null;

      // Closed-bar RSI (drops the in-progress last bar) — used for EXIT decisions so we
      // are not fooled by intra-bar tick noise. RSI(2) on a partial bar can swing from
      // 2 to 80 with one tick; the Pine reference evaluates `rsi > 50` once per bar at
      // close, and so do we.
      const closedRSI = closes.length >= this.params.rsi_length + 2
        ? calcRSI(closes.slice(0, -1), this.params.rsi_length)
        : null;

      const inProgressBarTime = times && times.length ? times[times.length - 1] : null;
      const justClosedBarTime = times && times.length >= 2 ? times[times.length - 2] : null;
      if (this.lastSeenBarTime == null) this.lastSeenBarTime = inProgressBarTime;
      const isNewBar = inProgressBarTime != null && inProgressBarTime !== this.lastSeenBarTime;

      const volSMA = calcSMA(volumes, this.params.vol_len);
      const volOK = volSMA ? volumes[volumes.length - 1] > volSMA : true;

      let signal = null;

      // ── ENTRY (live tick) ──
      if (!positions['rsi2'] && liveRSI < this.params.oversold && volOK) {
        positions['rsi2'] = {
          entry_price: price,
          entry_bar_time: inProgressBarTime,
          bars_held: 0,
        };
        const tp = (price * (1 + this.params.tp / 100)).toFixed(2);
        const sl = (price * (1 - this.params.sl / 100)).toFixed(2);
        signal = { type: 'BUY', strategy: 'RSI(2)', msg: `BUY @ ₹${price} | RSI(2)=${liveRSI.toFixed(1)} | TP=₹${tp} SL=₹${sl}` };
      }
      // ── EXITS ──
      else if (positions['rsi2']) {
        const pos = positions['rsi2'];
        const { entry_price, entry_bar_time } = pos;
        const pnl = ((price - entry_price) / entry_price * 100).toFixed(2);

        // TP / SL — tick-based (matches Pine `strategy.exit` limit/stop semantics).
        if (price >= entry_price * (1 + this.params.tp / 100)) {
          positions['rsi2'] = null;
          signal = { type: 'TP', strategy: 'RSI(2)', msg: `TAKE PROFIT @ ₹${price} | P&L: +${pnl}%` };
        } else if (price <= entry_price * (1 - this.params.sl / 100)) {
          positions['rsi2'] = null;
          signal = { type: 'SL', strategy: 'RSI(2)', msg: `STOP LOSS @ ₹${price} | P&L: ${pnl}%` };
        } else if (isNewBar && justClosedBarTime !== entry_bar_time) {
          // RSI exit + max-bars exit — only on a freshly closed bar, and never on the
          // same bar as entry (Pine `strategy.close` does not fire same-bar by default).
          pos.bars_held++;
          if (closedRSI !== null && closedRSI > this.params.exit) {
            positions['rsi2'] = null;
            signal = { type: 'SELL', strategy: 'RSI(2)', msg: `EXIT (RSI>${this.params.exit}) @ ₹${price} | RSI=${closedRSI.toFixed(1)} | P&L: ${pnl}% | Bars: ${pos.bars_held}` };
          } else if (pos.bars_held >= this.params.max_bars) {
            positions['rsi2'] = null;
            signal = { type: 'SELL', strategy: 'RSI(2)', msg: `EXIT (max bars) @ ₹${price} | P&L: ${pnl}% | Bars: ${pos.bars_held}` };
          }
        }
      }

      if (isNewBar) this.lastSeenBarTime = inProgressBarTime;
      this.prevRSI = liveRSI;
      return signal;
    }
  },

  ibs: {
    name: 'IBS Mean Reversion (India v2 — Swing)',
    description: 'Buy IBS<0.35 + Vol≥SMA20 + above 200-SMA + ATR 1.5-5% + ₹100+ price + ₹2Cr+ liquid + no gap-down. Exit IBS>0.65, TP 2.5%, SL 1.5%, max 3 bars',
    params: {
      ibs_entry: 0.35,
      ibs_exit: 0.65,
      vol_mult: 1.0,
      tp: 2.5,
      sl: 1.5,
      max_bars: 3,
      trend_len: 200,
      gap_thresh: 2.0,
      min_turnover: 2e7,
      min_atr_pct: 1.5,
      max_atr_pct: 5.0,
      min_price: 100,
      use_trend: true,
      use_gap: true,
      use_liquidity: true,
      use_volatility: true,
      use_min_price: true,
    },
    lastSeenBarTime: null,
    check(closes, volumes, price, highs, lows, times) {
      if (!highs || !lows || highs.length < 2) return null;
      const n = highs.length;
      const h = highs[n - 1];
      const l = lows[n - 1];
      const ibs = h !== l ? (price - l) / (h - l) : 0.5;

      // Closed-bar IBS (uses the last fully closed bar) — used for EXIT to avoid the
      // intra-bar whipsaw where IBS swings as price moves between bar high/low live.
      let closedIBS = null;
      if (highs.length >= 2 && lows.length >= 2 && closes.length >= 2) {
        const cH = highs[n - 2];
        const cL = lows[n - 2];
        const cClose = closes[closes.length - 2];
        closedIBS = cH !== cL ? (cClose - cL) / (cH - cL) : 0.5;
      }

      const inProgressBarTime = times && times.length ? times[times.length - 1] : null;
      const justClosedBarTime = times && times.length >= 2 ? times[times.length - 2] : null;
      if (this.lastSeenBarTime == null) this.lastSeenBarTime = inProgressBarTime;
      const isNewBar = inProgressBarTime != null && inProgressBarTime !== this.lastSeenBarTime;

      // Volume confirmation
      const volSMA = calcSMA(volumes, 20);
      const volOK = volSMA ? volumes[n - 1] > volSMA * this.params.vol_mult : true;

      // Trend filter — only buy when above 200-SMA
      const sma200 = calcSMA(closes, this.params.trend_len);
      const trendOK = !this.params.use_trend || !sma200 ? true : price > sma200;

      // Volatility filter — ATR must be in tradeable range
      let volatilityOK = true;
      if (this.params.use_volatility && highs.length >= 15) {
        const trArr = [];
        for (let i = 1; i < highs.length; i++) {
          const tr = Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - closes[i - 1]),
            Math.abs(lows[i] - closes[i - 1])
          );
          trArr.push(tr);
        }
        const atr = calcSMA(trArr.slice(-14), 14);
        const atrPct = atr && price > 0 ? (atr / price) * 100 : 0;
        volatilityOK = atrPct >= this.params.min_atr_pct && atrPct <= this.params.max_atr_pct;
      }

      // Min price filter
      const priceOK = !this.params.use_min_price || price >= this.params.min_price;

      // Gap-down filter
      const prevClose = closes[n - 2];
      const gapOK = !this.params.use_gap || !prevClose ? true : price >= prevClose * (1 - this.params.gap_thresh / 100);

      // Liquidity filter
      let liquidityOK = true;
      if (this.params.use_liquidity) {
        const turnoverArr = volumes.map((v, i) => v * (closes[i] || price));
        const turnoverSMA = calcSMA(turnoverArr, 20);
        liquidityOK = turnoverSMA ? turnoverSMA >= this.params.min_turnover : true;
      }

      let signal = null;

      if (!positions['ibs'] && ibs < this.params.ibs_entry && volOK && trendOK && volatilityOK && priceOK && gapOK && liquidityOK) {
        positions['ibs'] = { entry_price: price, entry_bar_time: inProgressBarTime, bars_held: 0 };
        const tp = (price * (1 + this.params.tp / 100)).toFixed(2);
        const sl = (price * (1 - this.params.sl / 100)).toFixed(2);
        signal = { type: 'BUY', strategy: 'IBS', msg: `BUY @ ₹${price} | IBS=${ibs.toFixed(3)} | TP=₹${tp} SL=₹${sl}` };
      } else if (positions['ibs']) {
        const pos = positions['ibs'];
        const { entry_price, entry_bar_time } = pos;
        const pnl = ((price - entry_price) / entry_price * 100).toFixed(2);

        // TP / SL — tick-based (matches Pine `strategy.exit` limit/stop semantics).
        if (price >= entry_price * (1 + this.params.tp / 100)) {
          positions['ibs'] = null;
          signal = { type: 'TP', strategy: 'IBS', msg: `TAKE PROFIT @ ₹${price} | P&L: +${pnl}%` };
        } else if (price <= entry_price * (1 - this.params.sl / 100)) {
          positions['ibs'] = null;
          signal = { type: 'SL', strategy: 'IBS', msg: `STOP LOSS @ ₹${price} | P&L: ${pnl}%` };
        } else if (isNewBar && justClosedBarTime !== entry_bar_time) {
          // IBS exit + max-bars exit — only on a freshly closed bar, never same bar as entry.
          pos.bars_held++;
          if (closedIBS !== null && closedIBS > this.params.ibs_exit) {
            positions['ibs'] = null;
            signal = { type: 'SELL', strategy: 'IBS', msg: `EXIT (IBS>${this.params.ibs_exit}) @ ₹${price} | IBS=${closedIBS.toFixed(3)} | P&L: ${pnl}% | Bars: ${pos.bars_held}` };
          } else if (pos.bars_held >= this.params.max_bars) {
            positions['ibs'] = null;
            signal = { type: 'SELL', strategy: 'IBS', msg: `EXIT (max bars) @ ₹${price} | P&L: ${pnl}% | Bars: ${pos.bars_held}` };
          }
        }
      }

      if (isNewBar) this.lastSeenBarTime = inProgressBarTime;
      return signal;
    }
  },

  fibonacci: {
    name: 'Fibonacci Retracement',
    description: 'Buy at 50%/61.8% retrace + Volume; Exit at swing high/TP/SL — bar-close evaluation',
    params: { lookback: 50, fib_low: 0.5, fib_high: 0.618, tp: 1.5, sl: 1.0, max_bars: 5 },
    lastSeenBarTime: null,
    check(closes, volumes, price, highs, lows, times) {
      if (closes.length < this.params.lookback) return null;
      const window = closes.slice(-this.params.lookback);
      const high = Math.max(...window);
      const low = Math.min(...window);
      const range = high - low;
      if (range === 0) return null;

      const retrace = (high - price) / range;
      const volSMA = calcSMA(volumes, 20);
      const volOK = volSMA ? volumes[volumes.length - 1] > volSMA : true;

      const inProgressBarTime = times && times.length ? times[times.length - 1] : null;
      const justClosedBarTime = times && times.length >= 2 ? times[times.length - 2] : null;
      if (this.lastSeenBarTime == null) this.lastSeenBarTime = inProgressBarTime;
      const isNewBar = inProgressBarTime != null && inProgressBarTime !== this.lastSeenBarTime;

      let signal = null;

      if (!positions['fibonacci'] && retrace >= this.params.fib_low && retrace <= this.params.fib_high && volOK) {
        positions['fibonacci'] = { entry_price: price, entry_bar_time: inProgressBarTime, bars_held: 0 };
        const tp = (price * (1 + this.params.tp / 100)).toFixed(2);
        const sl = (price * (1 - this.params.sl / 100)).toFixed(2);
        signal = { type: 'BUY', strategy: 'Fibonacci', msg: `BUY @ ₹${price} | Retrace=${(retrace * 100).toFixed(1)}% | TP=₹${tp} SL=₹${sl}` };
      } else if (positions['fibonacci']) {
        const pos = positions['fibonacci'];
        const { entry_price, entry_bar_time } = pos;
        const pnl = ((price - entry_price) / entry_price * 100).toFixed(2);

        // TP / SL — tick-based.
        if (price >= entry_price * (1 + this.params.tp / 100)) {
          positions['fibonacci'] = null;
          signal = { type: 'TP', strategy: 'Fibonacci', msg: `TAKE PROFIT @ ₹${price} | P&L: +${pnl}%` };
        } else if (price <= entry_price * (1 - this.params.sl / 100)) {
          positions['fibonacci'] = null;
          signal = { type: 'SL', strategy: 'Fibonacci', msg: `STOP LOSS @ ₹${price} | P&L: ${pnl}%` };
        } else if (price >= high) {
          // Reached prior swing high — tick-based price target, fine to fire intra-bar.
          positions['fibonacci'] = null;
          signal = { type: 'SELL', strategy: 'Fibonacci', msg: `EXIT (reached high) @ ₹${price} | P&L: ${pnl}%` };
        } else if (isNewBar && justClosedBarTime !== entry_bar_time) {
          // Max-bars exit — only on a freshly closed bar, never same bar as entry.
          pos.bars_held++;
          if (pos.bars_held >= this.params.max_bars) {
            positions['fibonacci'] = null;
            signal = { type: 'SELL', strategy: 'Fibonacci', msg: `EXIT (max bars) @ ₹${price} | P&L: ${pnl}% | Bars: ${pos.bars_held}` };
          }
        }
      }

      if (isNewBar) this.lastSeenBarTime = inProgressBarTime;
      return signal;
    }
  }
};

// ── Math Helpers ──

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcSMA(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcATR(highs, lows, closes, period) {
  if (highs.length < period + 1) return null;
  let trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return calcSMA(trs.slice(-period), period);
}

function calcBollingerBands(closes, period, mult) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: sma + mult * std, middle: sma, lower: sma - mult * std, width: (2 * mult * std) / sma * 100 };
}

function calcMACD(closes, fast, slow, signal) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  if (!emaFast || !emaSlow) return null;
  const macd = emaFast - emaSlow;
  return { macd, signal: 0, histogram: macd };
}

function calcStochastic(closes, highs, lows, period) {
  if (closes.length < period) return null;
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  if (h === l) return 50;
  return ((closes[closes.length - 1] - l) / (h - l)) * 100;
}

// ── Chart Analysis Engine ──

function analyzeMarketConditions(data) {
  const { closes, highs, lows, volumes, close: price } = data;
  if (!closes || closes.length < 30) {
    return {
      regime: 'unknown',
      regimeConfidence: 0,
      compositeScore: 0,
      recommendedStrategy: 'rsi2',
      indicators: {
        rsi2: null,
        rsi14: null,
        ema9: null,
        ema21: null,
        sma50: null,
        bb: null,
        atr: null,
        atrPct: null,
        macd: null,
        stoch: null,
        ibs: null,
        volRatio: null,
        adx: null,
        hurst: null,
        varianceRatio: null,
      },
      trend: { ema9above21: false, aboveSMA50: null, direction: 'FLAT' },
      signals: [],
    };
  }

  // RSI
  const rsi2 = calcRSI(closes, 2);
  const rsi14 = calcRSI(closes, 14);

  // Moving averages
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const sma50 = closes.length >= 50 ? calcSMA(closes, 50) : null;

  // Bollinger Bands
  const bb = calcBollingerBands(closes, 20, 2);

  // ATR (volatility)
  const atr = calcATR(highs, lows, closes, 14);
  const atrPct = atr && price ? (atr / price * 100) : null;

  // MACD
  const macd = calcMACD(closes, 12, 26, 9);

  // Stochastic
  const stoch = calcStochastic(closes, highs, lows, 14);

  // IBS
  const h = highs[highs.length - 1];
  const l = lows[lows.length - 1];
  const ibs = h !== l ? (price - l) / (h - l) : 0.5;

  // Volume analysis
  const volSMA = calcSMA(volumes, 20);
  const volRatio = volSMA ? volumes[volumes.length - 1] / volSMA : 1;

  // Trend detection
  const trendUp = ema9 && ema21 && ema9 > ema21;
  const trendDown = ema9 && ema21 && ema9 < ema21;
  const aboveSMA50 = sma50 ? price > sma50 : null;

  // ── Quant-grade regime detection ──
  // ADX: trend strength (>25 = trending, <20 = ranging)
  const adxVal = Quant.adx(highs, lows, closes, 14);
  // Hurst exponent: <0.5 mean-reverting, ≈0.5 random walk, >0.5 trending
  const hurst = Quant.hurst(closes);
  // Variance ratio: <1 mean-reverting, ≈1 random, >1 trending
  const varRatio = Quant.varianceRatio(closes, 5);

  // Regime detection (multi-signal consensus)
  let regime = 'ranging';
  let regimeConfidence = 50;

  // Trend regime: ADX > 25 + EMA confirms direction + Hurst > 0.5
  const trendStrong = adxVal && adxVal > 25;
  const trendingByHurst = hurst != null && hurst > 0.55;
  const trendingByVR = varRatio != null && varRatio > 1.1;

  if (trendStrong && trendUp && (trendingByHurst || trendingByVR)) {
    regime = 'trending_up';
    regimeConfidence = Math.min(95, 70 + (adxVal - 25) * 0.8);
  } else if (trendStrong && trendDown && (trendingByHurst || trendingByVR)) {
    regime = 'trending_down';
    regimeConfidence = Math.min(95, 70 + (adxVal - 25) * 0.8);
  } else if (bb && bb.width < 2) {
    regime = 'squeeze';
    regimeConfidence = 80;
  } else if (bb && bb.width > 5) {
    regime = 'volatile';
    regimeConfidence = 75;
  } else if (adxVal != null && adxVal < 18 && hurst != null && hurst < 0.45) {
    // Strong mean-reverting signal
    regime = 'ranging';
    regimeConfidence = 80;
  } else {
    // Mixed / unclear regime
    regime = 'ranging';
    regimeConfidence = 55;
  }

  // Signals scoring
  const signals = [];
  if (rsi2 !== null && rsi2 < 15) signals.push({ type: 'BUY', reason: `RSI(2) extremely oversold: ${rsi2.toFixed(1)}`, strength: 90 });
  else if (rsi2 !== null && rsi2 < 30) signals.push({ type: 'BUY', reason: `RSI(2) oversold: ${rsi2.toFixed(1)}`, strength: 70 });
  else if (rsi2 !== null && rsi2 > 85) signals.push({ type: 'SELL', reason: `RSI(2) extremely overbought: ${rsi2.toFixed(1)}`, strength: 90 });
  else if (rsi2 !== null && rsi2 > 70) signals.push({ type: 'SELL', reason: `RSI(2) overbought: ${rsi2.toFixed(1)}`, strength: 60 });

  if (ibs < 0.2) signals.push({ type: 'BUY', reason: `IBS very low: ${ibs.toFixed(3)}`, strength: 75 });
  if (ibs > 0.8) signals.push({ type: 'SELL', reason: `IBS very high: ${ibs.toFixed(3)}`, strength: 65 });

  if (bb && price <= bb.lower) signals.push({ type: 'BUY', reason: 'Price at lower Bollinger Band', strength: 65 });
  if (bb && price >= bb.upper) signals.push({ type: 'SELL', reason: 'Price at upper Bollinger Band', strength: 60 });

  if (macd && macd.macd > 0 && trendUp) signals.push({ type: 'BUY', reason: 'MACD positive + uptrend', strength: 55 });
  if (macd && macd.macd < 0 && trendDown) signals.push({ type: 'SELL', reason: 'MACD negative + downtrend', strength: 55 });

  if (stoch !== null && stoch < 20) signals.push({ type: 'BUY', reason: `Stochastic oversold: ${stoch.toFixed(1)}`, strength: 60 });
  if (stoch !== null && stoch > 80) signals.push({ type: 'SELL', reason: `Stochastic overbought: ${stoch.toFixed(1)}`, strength: 55 });

  if (volRatio > 2) signals.push({ type: 'INFO', reason: `Volume spike: ${volRatio.toFixed(1)}x average`, strength: 50 });

  // Composite score: -100 (strong sell) to +100 (strong buy)
  let compositeScore = 0;
  for (const s of signals) {
    compositeScore += s.type === 'BUY' ? s.strength : s.type === 'SELL' ? -s.strength : 0;
  }
  compositeScore = Math.max(-100, Math.min(100, compositeScore));

  // Recommended strategy
  let recommendedStrategy = 'rsi2';
  if (regime === 'squeeze') recommendedStrategy = 'bollinger_breakout';
  else if (regime === 'trending_up' || regime === 'trending_down') recommendedStrategy = 'ema_crossover';
  else if (regime === 'volatile') recommendedStrategy = 'mean_reversion';
  else if (regime === 'ranging') recommendedStrategy = 'rsi2';

  return {
    regime, regimeConfidence, compositeScore, recommendedStrategy,
    indicators: {
      rsi2: rsi2?.toFixed(1), rsi14: rsi14?.toFixed(1),
      ema9: ema9?.toFixed(2), ema21: ema21?.toFixed(2), sma50: sma50?.toFixed(2),
      bb: bb ? { upper: bb.upper.toFixed(2), middle: bb.middle.toFixed(2), lower: bb.lower.toFixed(2), width: bb.width.toFixed(2) } : null,
      atr: atr?.toFixed(2), atrPct: atrPct?.toFixed(2),
      macd: macd?.macd?.toFixed(2), stoch: stoch?.toFixed(1), ibs: ibs.toFixed(3),
      volRatio: volRatio.toFixed(2),
      adx: adxVal?.toFixed(1),
      hurst: hurst?.toFixed(3),
      varianceRatio: varRatio?.toFixed(2),
    },
    trend: { ema9above21: trendUp, aboveSMA50, direction: trendUp ? 'UP' : trendDown ? 'DOWN' : 'FLAT' },
    signals,
  };
}

// ── Pine Script Generator Engine ──

const PINE_TEMPLATES = {
  rsi2: (symbol, params) => `//@version=6
strategy("AI RSI(2) Mean Reversion — ${symbol}", overlay=false, default_qty_type=strategy.percent_of_equity, default_qty_value=100, initial_capital=100000, currency=currency.INR, commission_value=0.03)

// Auto-generated for ${symbol} based on live chart analysis
rsi_len = input.int(2, "RSI Length", minval=1)
oversold = input.int(${params.oversold || 30}, "Oversold Level")
exit_level = input.int(50, "Exit RSI Level")
vol_len = input.int(20, "Volume SMA Length")
tp_pct = input.float(${params.tp || 1.5}, "Take Profit %", step=0.1)
sl_pct = input.float(${params.sl || 1.0}, "Stop Loss %", step=0.1)
max_bars = input.int(${params.maxBars || 5}, "Max Bars Held")

rsi_val = ta.rsi(close, rsi_len)
vol_sma = ta.sma(volume, vol_len)

entry = rsi_val < oversold and volume > vol_sma
exit_rsi = rsi_val > exit_level
exit_time = ta.barssince(entry) >= max_bars

if entry
    strategy.entry("RSI2", strategy.long)

if strategy.position_size > 0
    tp = strategy.position_avg_price * (1 + tp_pct / 100)
    sl = strategy.position_avg_price * (1 - sl_pct / 100)
    strategy.exit("TP/SL", "RSI2", limit=tp, stop=sl)

if exit_rsi or exit_time
    strategy.close("RSI2")

plot(rsi_val, "RSI(2)", color=color.blue, linewidth=2)
hline(oversold, "Oversold", color=color.green)
hline(exit_level, "Exit", color=color.orange)
bgcolor(rsi_val < oversold ? color.new(color.green, 90) : na)

alertcondition(entry, "RSI(2) Buy Signal", "RSI(2) oversold with volume confirmation")
`,

  ema_crossover: (symbol, params) => `//@version=6
strategy("AI EMA Crossover — ${symbol}", overlay=true, default_qty_type=strategy.percent_of_equity, default_qty_value=100, initial_capital=100000, currency=currency.INR, commission_value=0.03)

// Auto-generated for ${symbol} — trend-following strategy
fast_len = input.int(${params.fast || 9}, "Fast EMA")
slow_len = input.int(${params.slow || 21}, "Slow EMA")
tp_pct = input.float(${params.tp || 2.0}, "Take Profit %", step=0.1)
sl_pct = input.float(${params.sl || 1.5}, "Stop Loss %", step=0.1)
use_vol = input.bool(true, "Volume Filter")
vol_len = input.int(20, "Volume SMA Length")

ema_fast = ta.ema(close, fast_len)
ema_slow = ta.ema(close, slow_len)
vol_ok = use_vol ? volume > ta.sma(volume, vol_len) : true

bullish_cross = ta.crossover(ema_fast, ema_slow) and vol_ok
bearish_cross = ta.crossunder(ema_fast, ema_slow)

if bullish_cross
    strategy.entry("Long", strategy.long)

if bearish_cross
    strategy.close("Long")

if strategy.position_size > 0
    tp = strategy.position_avg_price * (1 + tp_pct / 100)
    sl = strategy.position_avg_price * (1 - sl_pct / 100)
    strategy.exit("TP/SL", "Long", limit=tp, stop=sl)

plot(ema_fast, "Fast EMA", color=color.green, linewidth=2)
plot(ema_slow, "Slow EMA", color=color.red, linewidth=2)
bgcolor(ema_fast > ema_slow ? color.new(color.green, 95) : color.new(color.red, 95))

alertcondition(bullish_cross, "EMA Golden Cross", "Fast EMA crossed above Slow EMA")
alertcondition(bearish_cross, "EMA Death Cross", "Fast EMA crossed below Slow EMA")
`,

  bollinger_breakout: (symbol, params) => `//@version=6
strategy("AI Bollinger Squeeze — ${symbol}", overlay=true, default_qty_type=strategy.percent_of_equity, default_qty_value=100, initial_capital=100000, currency=currency.INR, commission_value=0.03)

// Auto-generated for ${symbol} — Bollinger Band squeeze breakout
bb_len = input.int(20, "BB Length")
bb_mult = input.float(2.0, "BB Multiplier", step=0.1)
squeeze_pct = input.float(${params.squeezeThreshold || 2.0}, "Squeeze Width %", step=0.1)
tp_pct = input.float(${params.tp || 2.0}, "Take Profit %", step=0.1)
sl_pct = input.float(${params.sl || 1.0}, "Stop Loss %", step=0.1)

basis = ta.sma(close, bb_len)
dev = bb_mult * ta.stdev(close, bb_len)
upper = basis + dev
lower = basis - dev
width = (upper - lower) / basis * 100

is_squeeze = width < squeeze_pct
breakout_up = is_squeeze[1] and close > upper
breakout_down = is_squeeze[1] and close < lower

if breakout_up
    strategy.entry("BB_Long", strategy.long)

if breakout_down
    strategy.close("BB_Long")

if strategy.position_size > 0
    tp = strategy.position_avg_price * (1 + tp_pct / 100)
    sl = strategy.position_avg_price * (1 - sl_pct / 100)
    strategy.exit("TP/SL", "BB_Long", limit=tp, stop=sl)

plot(upper, "Upper BB", color=color.red)
plot(basis, "Basis", color=color.gray)
plot(lower, "Lower BB", color=color.green)
bgcolor(is_squeeze ? color.new(color.yellow, 85) : na, title="Squeeze Zone")

alertcondition(breakout_up, "Bollinger Breakout Up", "Price broke above upper BB after squeeze")
`,

  mean_reversion: (symbol, params) => `//@version=6
strategy("AI Mean Reversion — ${symbol}", overlay=true, default_qty_type=strategy.percent_of_equity, default_qty_value=100, initial_capital=100000, currency=currency.INR, commission_value=0.03)

// Auto-generated for ${symbol} — multi-signal mean reversion
rsi_len = input.int(2, "RSI Length")
rsi_oversold = input.int(${params.oversold || 25}, "RSI Oversold")
bb_len = input.int(20, "BB Length")
bb_mult = input.float(2.0, "BB Multiplier")
ibs_threshold = input.float(${params.ibsThreshold || 0.3}, "IBS Threshold", step=0.05)
tp_pct = input.float(${params.tp || 1.5}, "Take Profit %", step=0.1)
sl_pct = input.float(${params.sl || 1.5}, "Stop Loss %", step=0.1)

rsi_val = ta.rsi(close, rsi_len)
basis = ta.sma(close, bb_len)
dev = bb_mult * ta.stdev(close, bb_len)
lower_bb = basis - dev
ibs = (close - low) / math.max(high - low, 0.0001)

signal_rsi = rsi_val < rsi_oversold
signal_bb = close <= lower_bb
signal_ibs = ibs < ibs_threshold
vol_ok = volume > ta.sma(volume, 20)

// Score-based entry: need at least 2 of 3 signals + volume
score = (signal_rsi ? 1 : 0) + (signal_bb ? 1 : 0) + (signal_ibs ? 1 : 0)
entry = score >= 2 and vol_ok

if entry
    strategy.entry("MR", strategy.long)

if strategy.position_size > 0
    tp = strategy.position_avg_price * (1 + tp_pct / 100)
    sl = strategy.position_avg_price * (1 - sl_pct / 100)
    strategy.exit("TP/SL", "MR", limit=tp, stop=sl)

if rsi_val > 60
    strategy.close("MR")

plotshape(entry, "Entry", shape.triangleup, location.belowbar, color.green, size=size.small)
plot(basis, "SMA(20)", color=color.gray)
plot(lower_bb, "Lower BB", color=color.green, style=plot.style_circles)

alertcondition(entry, "Mean Reversion Entry", "Multiple oversold signals confirmed")
`,

  vwap_deviation: (symbol, params) => `//@version=6
indicator("AI VWAP Deviation — ${symbol}", overlay=true)

// Auto-generated for ${symbol} — VWAP with standard deviation bands
mult1 = input.float(1.0, "Band 1 Multiplier", step=0.1)
mult2 = input.float(2.0, "Band 2 Multiplier", step=0.1)
mult3 = input.float(3.0, "Band 3 Multiplier", step=0.1)

vwap_val = ta.vwap
vwap_stdev = ta.stdev(close - vwap_val, 20)

upper1 = vwap_val + mult1 * vwap_stdev
upper2 = vwap_val + mult2 * vwap_stdev
upper3 = vwap_val + mult3 * vwap_stdev
lower1 = vwap_val - mult1 * vwap_stdev
lower2 = vwap_val - mult2 * vwap_stdev
lower3 = vwap_val - mult3 * vwap_stdev

plot(vwap_val, "VWAP", color=color.yellow, linewidth=2)
plot(upper1, "+1σ", color=color.new(color.red, 60))
plot(upper2, "+2σ", color=color.new(color.red, 40))
plot(upper3, "+3σ", color=color.new(color.red, 20))
plot(lower1, "-1σ", color=color.new(color.green, 60))
plot(lower2, "-2σ", color=color.new(color.green, 40))
plot(lower3, "-3σ", color=color.new(color.green, 20))

bgcolor(close > upper2 ? color.new(color.red, 90) : close < lower2 ? color.new(color.green, 90) : na)

alertcondition(close < lower2, "VWAP -2σ Bounce", "Price below VWAP -2σ — mean reversion opportunity")
alertcondition(close > upper2, "VWAP +2σ Rejection", "Price above VWAP +2σ — potential pullback")
`,

  momentum_roc: (symbol, params) => `//@version=6
strategy("AI Momentum ROC — ${symbol}", overlay=false, default_qty_type=strategy.percent_of_equity, default_qty_value=100, initial_capital=100000, currency=currency.INR, commission_value=0.03)

// Auto-generated for ${symbol} — Rate of Change momentum strategy
roc_len = input.int(${params.rocLen || 12}, "ROC Length")
signal_len = input.int(9, "Signal Length")
threshold = input.float(${params.threshold || 2.0}, "Entry Threshold %", step=0.1)
tp_pct = input.float(${params.tp || 2.0}, "Take Profit %", step=0.1)
sl_pct = input.float(${params.sl || 1.5}, "Stop Loss %", step=0.1)

roc = (close - close[roc_len]) / close[roc_len] * 100
signal = ta.ema(roc, signal_len)
histogram = roc - signal

bull_cross = ta.crossover(roc, signal) and roc > -threshold
bear_cross = ta.crossunder(roc, signal) and roc < threshold

if bull_cross
    strategy.entry("ROC_Long", strategy.long)

if bear_cross
    strategy.close("ROC_Long")

if strategy.position_size > 0
    tp = strategy.position_avg_price * (1 + tp_pct / 100)
    sl = strategy.position_avg_price * (1 - sl_pct / 100)
    strategy.exit("TP/SL", "ROC_Long", limit=tp, stop=sl)

plot(roc, "ROC", color=color.blue, linewidth=2)
plot(signal, "Signal", color=color.orange)
hline(0, "Zero", color=color.gray)
plot(histogram, "Histogram", style=plot.style_histogram, color=histogram > 0 ? color.green : color.red)

alertcondition(bull_cross, "ROC Bullish Cross", "ROC crossed above signal line")
`,

  stochastic_rsi: (symbol, params) => `//@version=6
strategy("AI Stochastic RSI — ${symbol}", overlay=false, default_qty_type=strategy.percent_of_equity, default_qty_value=100, initial_capital=100000, currency=currency.INR, commission_value=0.03)

// Auto-generated for ${symbol} — Stochastic RSI with smoothing
rsi_len = input.int(14, "RSI Length")
stoch_len = input.int(14, "Stochastic Length")
k_smooth = input.int(3, "K Smoothing")
d_smooth = input.int(3, "D Smoothing")
oversold = input.float(${params.oversold || 20}, "Oversold Level")
overbought = input.float(${params.overbought || 80}, "Overbought Level")
tp_pct = input.float(${params.tp || 1.5}, "Take Profit %", step=0.1)
sl_pct = input.float(${params.sl || 1.0}, "Stop Loss %", step=0.1)

rsi_val = ta.rsi(close, rsi_len)
stoch_k = ta.sma(ta.stoch(rsi_val, rsi_val, rsi_val, stoch_len), k_smooth)
stoch_d = ta.sma(stoch_k, d_smooth)

bull_cross = ta.crossover(stoch_k, stoch_d) and stoch_k < oversold
bear_cross = ta.crossunder(stoch_k, stoch_d) and stoch_k > overbought

if bull_cross
    strategy.entry("StochRSI", strategy.long)

if bear_cross or stoch_k > overbought
    strategy.close("StochRSI")

if strategy.position_size > 0
    tp = strategy.position_avg_price * (1 + tp_pct / 100)
    sl = strategy.position_avg_price * (1 - sl_pct / 100)
    strategy.exit("TP/SL", "StochRSI", limit=tp, stop=sl)

plot(stoch_k, "K", color=color.blue, linewidth=2)
plot(stoch_d, "D", color=color.red)
hline(oversold, "Oversold", color=color.green, linestyle=hline.style_dashed)
hline(overbought, "Overbought", color=color.red, linestyle=hline.style_dashed)
bgcolor(stoch_k < oversold ? color.new(color.green, 90) : stoch_k > overbought ? color.new(color.red, 90) : na)

alertcondition(bull_cross, "StochRSI Buy", "Bullish K/D crossover in oversold zone")
`,
};

function generatePineScript(strategyType, symbol, analysis) {
  const template = PINE_TEMPLATES[strategyType];
  
  // If not in templates, search all pdf/ subfolders
  if (!template) {
    const pdfDir = path.join(__dirname, 'pdf');
    if (fs.existsSync(pdfDir)) {
      const subfolders = fs.readdirSync(pdfDir).filter(f => fs.statSync(path.join(pdfDir, f)).isDirectory());
      for (const folder of subfolders) {
        const filePath = path.join(pdfDir, folder, strategyType + '.pine');
        if (fs.existsSync(filePath)) {
          return fs.readFileSync(filePath, 'utf-8');
        }
      }
    }
    return null;
  }

  // Auto-tune parameters based on analysis
  const params = {};
  if (analysis?.indicators) {
    const atrPct = parseFloat(analysis.indicators.atrPct) || 1.5;
    params.tp = Math.max(1.0, (atrPct * 1.5)).toFixed(1);
    params.sl = Math.max(0.5, atrPct).toFixed(1);

    if (analysis.indicators.rsi2) {
      const rsi = parseFloat(analysis.indicators.rsi2);
      params.oversold = rsi < 20 ? 25 : 30;
    }
    if (analysis.indicators.ibs) {
      params.ibsThreshold = parseFloat(analysis.indicators.ibs) < 0.3 ? 0.35 : 0.3;
    }
    if (analysis.indicators.bb) {
      params.squeezeThreshold = parseFloat(analysis.indicators.bb.width) < 3 ? 2.0 : 3.0;
    }
  }

  return template(symbol || 'AUTO', params);
}

// ── Script DNA Matrix — Compatibility Profiles ──
// Each script has an ideal "environment fingerprint" defining where it performs best.
// Dimensions: regime affinity, volatility preference, trend strength, volume, timeframe, asset class, style

const SCRIPT_DNA = {
  rsi2: {
    name: 'RSI(2) Mean Reversion',
    style: 'mean_reversion', // mean_reversion | trend_following | breakout | hybrid | overlay
    regimeAffinity: { ranging: 95, volatile: 70, squeeze: 40, trending_up: 20, trending_down: 50 },
    volatility: { ideal: 'medium', low: 50, medium: 90, high: 60 }, // performs best in medium vol
    trendStrength: { weak: 90, moderate: 50, strong: 15 }, // needs weak trends
    volumeProfile: { spike: 85, normal: 70, declining: 40 }, // volume spike confirms
    timeframe: { '1': 60, '5': 80, '15': 90, '60': 75, 'D': 50, 'W': 30 },
    assetClass: { equity: 90, futures: 80, crypto: 60, forex: 50 },
    holdingPeriod: '1-5 bars',
    riskLevel: 'low',
    winConditions: ['RSI(2) < 30', 'volume spike', 'price near support'],
    failConditions: ['strong downtrend', 'momentum breakdown', 'low liquidity'],
  },
  ema_crossover: {
    name: 'EMA Crossover (9/21)',
    style: 'trend_following',
    regimeAffinity: { trending_up: 90, trending_down: 70, ranging: 15, squeeze: 30, volatile: 40 },
    volatility: { ideal: 'medium', low: 60, medium: 85, high: 50 },
    trendStrength: { weak: 20, moderate: 80, strong: 95 },
    volumeProfile: { spike: 75, normal: 80, declining: 50 },
    timeframe: { '1': 40, '5': 60, '15': 80, '60': 90, 'D': 85, 'W': 70 },
    assetClass: { equity: 85, futures: 80, crypto: 75, forex: 80 },
    holdingPeriod: '5-20 bars',
    riskLevel: 'medium',
    winConditions: ['clear trend', 'expanding volume on cross', 'above SMA50'],
    failConditions: ['choppy ranging market', 'whipsaw conditions', 'low ATR'],
  },
  bollinger_breakout: {
    name: 'Bollinger Squeeze Breakout',
    style: 'breakout',
    regimeAffinity: { squeeze: 95, ranging: 60, volatile: 30, trending_up: 40, trending_down: 30 },
    volatility: { ideal: 'low', low: 95, medium: 50, high: 20 },
    trendStrength: { weak: 80, moderate: 50, strong: 20 },
    volumeProfile: { spike: 90, normal: 60, declining: 30 },
    timeframe: { '1': 50, '5': 70, '15': 85, '60': 90, 'D': 80, 'W': 60 },
    assetClass: { equity: 85, futures: 90, crypto: 80, forex: 70 },
    holdingPeriod: '3-10 bars',
    riskLevel: 'medium',
    winConditions: ['BB width < 2%', 'volume expansion on breakout', 'directional bias'],
    failConditions: ['already volatile', 'false breakout history', 'no volume confirmation'],
  },
  mean_reversion: {
    name: 'Multi-Signal Mean Reversion',
    style: 'mean_reversion',
    regimeAffinity: { ranging: 85, volatile: 80, squeeze: 50, trending_up: 25, trending_down: 60 },
    volatility: { ideal: 'high', low: 30, medium: 70, high: 95 },
    trendStrength: { weak: 85, moderate: 60, strong: 15 },
    volumeProfile: { spike: 90, normal: 70, declining: 35 },
    timeframe: { '1': 70, '5': 85, '15': 90, '60': 80, 'D': 60, 'W': 40 },
    assetClass: { equity: 90, futures: 85, crypto: 70, forex: 60 },
    holdingPeriod: '1-5 bars',
    riskLevel: 'low',
    winConditions: ['multiple oversold signals', 'volume capitulation', 'near strong support'],
    failConditions: ['trend acceleration', 'gap down continuation', 'sector-wide selloff'],
  },
  vwap_deviation: {
    name: 'VWAP Deviation Bands',
    style: 'overlay',
    regimeAffinity: { ranging: 80, trending_up: 60, trending_down: 60, volatile: 70, squeeze: 40 },
    volatility: { ideal: 'medium', low: 50, medium: 85, high: 75 },
    trendStrength: { weak: 80, moderate: 70, strong: 50 },
    volumeProfile: { spike: 70, normal: 80, declining: 60 },
    timeframe: { '1': 90, '5': 90, '15': 85, '60': 70, 'D': 30, 'W': 10 },
    assetClass: { equity: 85, futures: 90, crypto: 60, forex: 50 },
    holdingPeriod: 'intraday',
    riskLevel: 'low',
    winConditions: ['intraday timeframe', 'price at ±2σ', 'mean-reverting day'],
    failConditions: ['daily/weekly timeframe', 'trending day', 'thin volume'],
  },
  momentum_roc: {
    name: 'Momentum ROC',
    style: 'trend_following',
    regimeAffinity: { trending_down: 80, trending_up: 75, volatile: 60, ranging: 30, squeeze: 40 },
    volatility: { ideal: 'high', low: 30, medium: 65, high: 90 },
    trendStrength: { weak: 25, moderate: 70, strong: 90 },
    volumeProfile: { spike: 80, normal: 70, declining: 45 },
    timeframe: { '1': 40, '5': 60, '15': 75, '60': 85, 'D': 90, 'W': 70 },
    assetClass: { equity: 80, futures: 85, crypto: 80, forex: 75 },
    holdingPeriod: '5-15 bars',
    riskLevel: 'medium',
    winConditions: ['momentum divergence', 'trend reversal starting', 'ROC crossing signal'],
    failConditions: ['choppy sideways', 'no momentum', 'whipsaw zone'],
  },
  stochastic_rsi: {
    name: 'Stochastic RSI',
    style: 'mean_reversion',
    regimeAffinity: { volatile: 85, ranging: 70, trending_down: 55, trending_up: 45, squeeze: 50 },
    volatility: { ideal: 'high', low: 30, medium: 70, high: 90 },
    trendStrength: { weak: 75, moderate: 65, strong: 30 },
    volumeProfile: { spike: 75, normal: 75, declining: 50 },
    timeframe: { '1': 60, '5': 80, '15': 90, '60': 85, 'D': 60, 'W': 40 },
    assetClass: { equity: 80, futures: 80, crypto: 85, forex: 75 },
    holdingPeriod: '2-8 bars',
    riskLevel: 'medium',
    winConditions: ['oversold K/D cross', 'volatility expansion', 'support level nearby'],
    failConditions: ['strong trend (stays overbought/oversold)', 'low volatility range'],
  },
  // ── Community Scripts ──
  entropy_momentum_filter: {
    name: 'Entropy Momentum Filter',
    style: 'hybrid',
    regimeAffinity: { squeeze: 85, ranging: 70, volatile: 60, trending_up: 55, trending_down: 55 },
    volatility: { ideal: 'low', low: 90, medium: 65, high: 40 },
    trendStrength: { weak: 80, moderate: 60, strong: 40 },
    volumeProfile: { spike: 70, normal: 75, declining: 60 },
    timeframe: { '1': 50, '5': 70, '15': 85, '60': 90, 'D': 80, 'W': 60 },
    assetClass: { equity: 80, futures: 85, crypto: 75, forex: 70 },
    holdingPeriod: 'filter-based',
    riskLevel: 'low',
    winConditions: ['low entropy (ordered market)', 'breakout confirmation', 'regime clarity'],
    failConditions: ['chaotic/random price action', 'high entropy persistence'],
  },
  account_guardian: {
    name: 'Account Guardian (R:R Overlay)',
    style: 'overlay',
    regimeAffinity: { volatile: 90, trending_up: 70, trending_down: 80, ranging: 60, squeeze: 50 },
    volatility: { ideal: 'high', low: 40, medium: 70, high: 95 },
    trendStrength: { weak: 50, moderate: 70, strong: 80 },
    volumeProfile: { spike: 80, normal: 70, declining: 60 },
    timeframe: { '1': 60, '5': 75, '15': 85, '60': 90, 'D': 90, 'W': 80 },
    assetClass: { equity: 85, futures: 90, crypto: 85, forex: 80 },
    holdingPeriod: 'any',
    riskLevel: 'risk_management',
    winConditions: ['high volatility', 'need position sizing', 'risk:reward calculation'],
    failConditions: ['already using fixed position sizing with low vol'],
  },
  adaptive_mtf_trend_fusion: {
    name: 'Adaptive MTF Trend Fusion',
    style: 'trend_following',
    regimeAffinity: { trending_up: 95, trending_down: 85, ranging: 20, squeeze: 30, volatile: 50 },
    volatility: { ideal: 'medium', low: 50, medium: 90, high: 65 },
    trendStrength: { weak: 15, moderate: 75, strong: 95 },
    volumeProfile: { spike: 70, normal: 80, declining: 55 },
    timeframe: { '1': 30, '5': 55, '15': 80, '60': 95, 'D': 90, 'W': 75 },
    assetClass: { equity: 90, futures: 90, crypto: 80, forex: 85 },
    holdingPeriod: '10-50 bars',
    riskLevel: 'medium',
    winConditions: ['multi-timeframe alignment', 'strong trend + VWAP support', 'increasing momentum'],
    failConditions: ['conflicting timeframes', 'ranging/choppy', 'mean-reverting session'],
  },
  fibonacci_only_strategy: {
    name: 'Fibonacci-Only Strategy',
    style: 'hybrid',
    regimeAffinity: { ranging: 85, trending_up: 60, trending_down: 50, volatile: 55, squeeze: 40 },
    volatility: { ideal: 'medium', low: 60, medium: 85, high: 55 },
    trendStrength: { weak: 75, moderate: 80, strong: 50 },
    volumeProfile: { spike: 65, normal: 80, declining: 65 },
    timeframe: { '1': 30, '5': 50, '15': 75, '60': 90, 'D': 90, 'W': 85 },
    assetClass: { equity: 85, futures: 85, crypto: 75, forex: 80 },
    holdingPeriod: '5-30 bars',
    riskLevel: 'medium',
    winConditions: ['clear swing high/low', 'retracement to 0.618/0.786', 'confluence with S/R'],
    failConditions: ['no clear structure', 'V-shape reversals', 'news-driven gaps'],
  },
  grid_dca_strategy: {
    name: 'Grid DCA Strategy',
    style: 'mean_reversion',
    regimeAffinity: { volatile: 90, trending_down: 75, ranging: 70, trending_up: 30, squeeze: 40 },
    volatility: { ideal: 'high', low: 20, medium: 60, high: 95 },
    trendStrength: { weak: 60, moderate: 55, strong: 50 },
    volumeProfile: { spike: 85, normal: 65, declining: 50 },
    timeframe: { '1': 30, '5': 50, '15': 70, '60': 85, 'D': 90, 'W': 80 },
    assetClass: { equity: 80, futures: 75, crypto: 95, forex: 70 },
    holdingPeriod: '10-100 bars',
    riskLevel: 'high',
    winConditions: ['high volatility', 'range-bound with dips', 'double bottom pattern'],
    failConditions: ['strong sustained downtrend', 'liquidity crisis', 'gap downs'],
  },
  visible_range_sr: {
    name: 'Visible Range S/R',
    style: 'overlay',
    regimeAffinity: { ranging: 90, trending_up: 65, trending_down: 65, squeeze: 60, volatile: 55 },
    volatility: { ideal: 'medium', low: 65, medium: 90, high: 60 },
    trendStrength: { weak: 85, moderate: 70, strong: 45 },
    volumeProfile: { spike: 60, normal: 80, declining: 70 },
    timeframe: { '1': 50, '5': 70, '15': 85, '60': 90, 'D': 85, 'W': 75 },
    assetClass: { equity: 85, futures: 90, crypto: 80, forex: 80 },
    holdingPeriod: 'level-based',
    riskLevel: 'low',
    winConditions: ['clear range', 'multiple touches at level', 'volume at S/R'],
    failConditions: ['trending market breaking levels', 'no historical pivots'],
  },
  price_action_structure: {
    name: 'Price Action Structure (BOS/CHoCH)',
    style: 'hybrid',
    regimeAffinity: { trending_down: 85, trending_up: 80, volatile: 65, ranging: 50, squeeze: 35 },
    volatility: { ideal: 'medium', low: 45, medium: 90, high: 70 },
    trendStrength: { weak: 40, moderate: 85, strong: 80 },
    volumeProfile: { spike: 80, normal: 75, declining: 50 },
    timeframe: { '1': 40, '5': 65, '15': 85, '60': 90, 'D': 85, 'W': 70 },
    assetClass: { equity: 85, futures: 90, crypto: 85, forex: 85 },
    holdingPeriod: '5-25 bars',
    riskLevel: 'medium',
    winConditions: ['CHoCH signal', 'order block test', 'FVG fill', 'structure break'],
    failConditions: ['no clear structure', 'very small moves (noise)', 'extremely choppy'],
  },
  smart_weekly_lines: {
    name: 'Smart Weekly Lines',
    style: 'overlay',
    regimeAffinity: { ranging: 70, trending_up: 65, trending_down: 65, volatile: 60, squeeze: 55 },
    volatility: { ideal: 'medium', low: 60, medium: 80, high: 65 },
    trendStrength: { weak: 70, moderate: 70, strong: 60 },
    volumeProfile: { spike: 60, normal: 75, declining: 65 },
    timeframe: { '1': 80, '5': 85, '15': 80, '60': 70, 'D': 40, 'W': 20 },
    assetClass: { equity: 80, futures: 85, crypto: 70, forex: 75 },
    holdingPeriod: 'intraday',
    riskLevel: 'low',
    winConditions: ['intraday trading', 'session-based levels needed', 'time-based analysis'],
    failConditions: ['swing/positional timeframe', 'weekly chart'],
  },
  ml_rsi_classification: {
    name: 'ML RSI | AI Classification',
    style: 'hybrid',
    regimeAffinity: { trending_up: 80, trending_down: 80, volatile: 75, ranging: 70, squeeze: 65 },
    volatility: { ideal: 'medium', low: 60, medium: 85, high: 75 },
    trendStrength: { weak: 65, moderate: 80, strong: 80 },
    volumeProfile: { spike: 75, normal: 80, declining: 60 },
    timeframe: { '1': 40, '5': 65, '15': 80, '60': 90, 'D': 85, 'W': 70 },
    assetClass: { equity: 85, futures: 85, crypto: 80, forex: 80 },
    holdingPeriod: '5-20 bars',
    riskLevel: 'medium',
    winConditions: ['sufficient historical data', 'recurring patterns', 'clear regimes'],
    failConditions: ['unprecedented event', 'very new/IPO stock', 'extreme outlier moves'],
  },
  // ── All PDF strategies (formerly loss/profitable/untested — now equal candidates) ──
  bollinger_india_tuned: {
    name: 'Bollinger MR [India Tuned]',
    style: 'mean_reversion',
    regimeAffinity: { ranging: 90, volatile: 75, squeeze: 45, trending_up: 20, trending_down: 55 },
    volatility: { ideal: 'medium', low: 55, medium: 90, high: 65 },
    trendStrength: { weak: 90, moderate: 50, strong: 15 },
    volumeProfile: { spike: 80, normal: 70, declining: 40 },
    timeframe: { '1': 55, '5': 75, '15': 90, '60': 80, 'D': 55, 'W': 30 },
    assetClass: { equity: 90, futures: 80, crypto: 60, forex: 55 },
    holdingPeriod: '2-8 bars',
    riskLevel: 'medium',
    winConditions: ['ranging market', 'price at BB extremes', 'mean-reverting'],
    failConditions: ['strong trend', 'momentum breakout', 'news spike'],
  },
  ema_crossover_india: {
    name: 'EMA Crossover [India]',
    style: 'trend_following',
    regimeAffinity: { trending_up: 90, trending_down: 70, ranging: 15, squeeze: 30, volatile: 40 },
    volatility: { ideal: 'medium', low: 60, medium: 85, high: 50 },
    trendStrength: { weak: 20, moderate: 80, strong: 95 },
    volumeProfile: { spike: 75, normal: 80, declining: 50 },
    timeframe: { '1': 40, '5': 60, '15': 80, '60': 90, 'D': 85, 'W': 70 },
    assetClass: { equity: 90, futures: 80, crypto: 70, forex: 75 },
    holdingPeriod: '5-20 bars',
    riskLevel: 'medium',
    winConditions: ['clear trend', 'EMA 9/21 cross', 'expanding volume'],
    failConditions: ['choppy ranging', 'whipsaw', 'low ATR'],
  },
  macd_strategy_india: {
    name: 'MACD Crossover [India]',
    style: 'trend_following',
    regimeAffinity: { trending_up: 85, trending_down: 75, ranging: 20, squeeze: 35, volatile: 50 },
    volatility: { ideal: 'medium', low: 55, medium: 85, high: 55 },
    trendStrength: { weak: 20, moderate: 75, strong: 90 },
    volumeProfile: { spike: 75, normal: 80, declining: 50 },
    timeframe: { '1': 35, '5': 55, '15': 75, '60': 90, 'D': 85, 'W': 70 },
    assetClass: { equity: 90, futures: 80, crypto: 70, forex: 75 },
    holdingPeriod: '5-25 bars',
    riskLevel: 'medium',
    winConditions: ['clear trend', 'MACD divergence', 'expanding histogram'],
    failConditions: ['choppy sideways', 'whipsaw conditions', 'low volatility'],
  },
  rsi_vwap_india: {
    name: 'RSI + VWAP [India]',
    style: 'mean_reversion',
    regimeAffinity: { ranging: 80, volatile: 70, trending_up: 50, trending_down: 45, squeeze: 40 },
    volatility: { ideal: 'medium', low: 50, medium: 85, high: 70 },
    trendStrength: { weak: 80, moderate: 65, strong: 30 },
    volumeProfile: { spike: 75, normal: 80, declining: 50 },
    timeframe: { '1': 85, '5': 90, '15': 85, '60': 70, 'D': 35, 'W': 10 },
    assetClass: { equity: 90, futures: 85, crypto: 55, forex: 50 },
    holdingPeriod: '2-10 bars',
    riskLevel: 'low',
    winConditions: ['intraday with VWAP', 'RSI oversold + above VWAP', 'mean-reverting'],
    failConditions: ['daily/weekly timeframe', 'no VWAP context', 'trending day'],
  },
  supertrend_india: {
    name: 'Supertrend [India]',
    style: 'trend_following',
    regimeAffinity: { trending_up: 90, trending_down: 85, volatile: 50, ranging: 15, squeeze: 25 },
    volatility: { ideal: 'medium', low: 45, medium: 85, high: 70 },
    trendStrength: { weak: 15, moderate: 70, strong: 95 },
    volumeProfile: { spike: 70, normal: 80, declining: 55 },
    timeframe: { '1': 40, '5': 60, '15': 80, '60': 90, 'D': 85, 'W': 70 },
    assetClass: { equity: 90, futures: 85, crypto: 75, forex: 75 },
    holdingPeriod: '5-30 bars',
    riskLevel: 'medium',
    winConditions: ['clear trending market', 'momentum expansion', 'ATR expansion'],
    failConditions: ['choppy/ranging', 'whipsaw zone', 'low ATR'],
  },
  fibonacci_strategy_india: {
    name: 'Fibonacci Retracement [India]',
    style: 'mean_reversion',
    regimeAffinity: { trending_up: 70, trending_down: 60, ranging: 80, volatile: 55, squeeze: 45 },
    volatility: { ideal: 'medium', low: 55, medium: 85, high: 60 },
    trendStrength: { weak: 60, moderate: 85, strong: 55 },
    volumeProfile: { spike: 65, normal: 80, declining: 65 },
    timeframe: { '1': 30, '5': 50, '15': 75, '60': 90, 'D': 90, 'W': 80 },
    assetClass: { equity: 90, futures: 85, crypto: 70, forex: 75 },
    holdingPeriod: '5-30 bars',
    riskLevel: 'medium',
    winConditions: ['clear swing high/low', 'pullback to 50%/61.8%', 'bullish candle at level'],
    failConditions: ['no clear structure', 'V-shape reversals', 'news-driven gaps'],
  },
  ibs_india_tuned: {
    name: 'IBS Mean Reversion [India]',
    style: 'mean_reversion',
    regimeAffinity: { ranging: 90, volatile: 80, squeeze: 50, trending_up: 25, trending_down: 55 },
    volatility: { ideal: 'medium', low: 40, medium: 85, high: 80 },
    trendStrength: { weak: 90, moderate: 55, strong: 15 },
    volumeProfile: { spike: 90, normal: 70, declining: 35 },
    timeframe: { '1': 50, '5': 70, '15': 85, '60': 80, 'D': 90, 'W': 50 },
    assetClass: { equity: 90, futures: 80, crypto: 55, forex: 45 },
    holdingPeriod: '1-3 bars',
    riskLevel: 'low',
    winConditions: ['IBS < 0.35', 'volume confirmation', 'mean-reverting market'],
    failConditions: ['strong downtrend', 'momentum breakdown', 'gap downs'],
  },
  rsi2_mean_reversion_from_pdf: {
    name: 'RSI(2) MR [PDF Original]',
    style: 'mean_reversion',
    regimeAffinity: { ranging: 95, volatile: 70, squeeze: 40, trending_up: 20, trending_down: 50 },
    volatility: { ideal: 'medium', low: 50, medium: 90, high: 60 },
    trendStrength: { weak: 90, moderate: 50, strong: 15 },
    volumeProfile: { spike: 85, normal: 70, declining: 40 },
    timeframe: { '1': 60, '5': 80, '15': 90, '60': 75, 'D': 50, 'W': 30 },
    assetClass: { equity: 90, futures: 80, crypto: 60, forex: 50 },
    holdingPeriod: '1-5 bars',
    riskLevel: 'low',
    winConditions: ['RSI(2) < 30', 'volume spike', 'price near support'],
    failConditions: ['strong downtrend', 'momentum breakdown', 'low liquidity'],
  },
  bollinger_bands_mean_reversion: {
    name: 'Bollinger Bands Mean Reversion',
    style: 'mean_reversion',
    regimeAffinity: { ranging: 90, volatile: 70, squeeze: 40, trending_up: 20, trending_down: 50 },
    volatility: { ideal: 'medium', low: 50, medium: 90, high: 60 },
    trendStrength: { weak: 90, moderate: 50, strong: 10 },
    volumeProfile: { spike: 80, normal: 70, declining: 40 },
    timeframe: { '1': 50, '5': 75, '15': 90, '60': 80, 'D': 60, 'W': 30 },
    assetClass: { equity: 85, futures: 80, crypto: 65, forex: 60 },
    holdingPeriod: '2-8 bars',
    riskLevel: 'low',
    winConditions: ['price crosses below lower BB', 'ranging market', 'mean-reverting'],
    failConditions: ['strong trend continuation', 'momentum breakdown'],
  },
  gap_and_go: {
    name: 'Gap & Go (Gap Fill)',
    style: 'mean_reversion',
    regimeAffinity: { volatile: 90, ranging: 60, trending_down: 65, trending_up: 40, squeeze: 30 },
    volatility: { ideal: 'high', low: 20, medium: 60, high: 95 },
    trendStrength: { weak: 70, moderate: 55, strong: 30 },
    volumeProfile: { spike: 90, normal: 60, declining: 30 },
    timeframe: { '1': 70, '5': 85, '15': 90, '60': 60, 'D': 90, 'W': 30 },
    assetClass: { equity: 90, futures: 85, crypto: 70, forex: 50 },
    holdingPeriod: '1-3 bars',
    riskLevel: 'medium',
    winConditions: ['gap down open', 'low IBS prev day', 'RSI oversold', 'gap fill tendency'],
    failConditions: ['no gap', 'trending continuation', 'low volume gap'],
  },
  ibs_mean_reversion: {
    name: 'IBS Strict (0.20 threshold)',
    style: 'mean_reversion',
    regimeAffinity: { ranging: 85, volatile: 85, squeeze: 45, trending_up: 20, trending_down: 50 },
    volatility: { ideal: 'high', low: 30, medium: 75, high: 90 },
    trendStrength: { weak: 90, moderate: 50, strong: 10 },
    volumeProfile: { spike: 90, normal: 65, declining: 30 },
    timeframe: { '1': 45, '5': 65, '15': 80, '60': 75, 'D': 90, 'W': 55 },
    assetClass: { equity: 90, futures: 80, crypto: 60, forex: 50 },
    holdingPeriod: '1-2 bars',
    riskLevel: 'low',
    winConditions: ['IBS < 0.20 (extreme)', 'high volume bar', 'clear capitulation'],
    failConditions: ['strong trend', 'no volume', 'gap continuation'],
  },
  monday_reversal: {
    name: 'Monday Reversal',
    style: 'mean_reversion',
    regimeAffinity: { volatile: 80, ranging: 70, trending_down: 65, trending_up: 30, squeeze: 40 },
    volatility: { ideal: 'medium', low: 40, medium: 80, high: 75 },
    trendStrength: { weak: 75, moderate: 60, strong: 25 },
    volumeProfile: { spike: 80, normal: 70, declining: 45 },
    timeframe: { '1': 30, '5': 50, '15': 65, '60': 75, 'D': 95, 'W': 40 },
    assetClass: { equity: 90, futures: 80, crypto: 55, forex: 60 },
    holdingPeriod: '1-5 bars',
    riskLevel: 'medium',
    winConditions: ['Monday gap down', 'RSI oversold', 'weekend effect', 'calendar seasonality'],
    failConditions: ['not Monday', 'gap up', 'strong uptrend already'],
  },
  overnight_swing: {
    name: 'Overnight Swing (Strong Close)',
    style: 'breakout',
    regimeAffinity: { trending_up: 85, volatile: 60, ranging: 40, trending_down: 30, squeeze: 50 },
    volatility: { ideal: 'medium', low: 50, medium: 85, high: 65 },
    trendStrength: { weak: 30, moderate: 75, strong: 90 },
    volumeProfile: { spike: 85, normal: 70, declining: 40 },
    timeframe: { '1': 30, '5': 50, '15': 70, '60': 80, 'D': 95, 'W': 50 },
    assetClass: { equity: 90, futures: 85, crypto: 70, forex: 60 },
    holdingPeriod: '1-2 bars',
    riskLevel: 'medium',
    winConditions: ['close near day high', 'above SMA50', 'volume expansion', 'uptrend'],
    failConditions: ['close near low', 'below SMA50', 'declining volume'],
  },
  trend_following_200sma: {
    name: 'Trend Following 200-SMA',
    style: 'trend_following',
    regimeAffinity: { trending_up: 95, trending_down: 40, ranging: 15, volatile: 35, squeeze: 30 },
    volatility: { ideal: 'low', low: 80, medium: 70, high: 40 },
    trendStrength: { weak: 10, moderate: 60, strong: 95 },
    volumeProfile: { spike: 90, normal: 70, declining: 40 },
    timeframe: { '1': 10, '5': 20, '15': 40, '60': 70, 'D': 95, 'W': 85 },
    assetClass: { equity: 90, futures: 85, crypto: 70, forex: 75 },
    holdingPeriod: '20-100 bars',
    riskLevel: 'low',
    winConditions: ['cross above SMA200', 'volume expansion', 'above SMA50', 'new uptrend'],
    failConditions: ['already well above SMA200', 'no volume', 'whipsaw around SMA200'],
  },
};

// ── Advanced Multi-Factor Scoring Engine ──

// ─── Asset-Adaptive Volatility Thresholds ───
// Different asset classes have wildly different "normal" volatility ranges.
// These are based on typical daily ATR% ranges for each class.
const VOL_THRESHOLDS = {
  equity: { low: 1.0, high: 2.5 },   // Indian/US equities: 1-2.5% normal
  futures: { low: 0.8, high: 2.0 },  // Index futures: 0.5-2% normal
  crypto: { low: 2.0, high: 5.0 },   // BTC/ETH: 2-5% normal, can spike to 10%+
  forex: { low: 0.3, high: 1.0 },    // Major pairs: 0.3-1% normal
};

function classifyVolatility(atrPct, assetClass = 'equity') {
  const t = VOL_THRESHOLDS[assetClass] || VOL_THRESHOLDS.equity;
  if (!atrPct) return 'medium';
  if (atrPct < t.low) return 'low';
  if (atrPct > t.high) return 'high';
  return 'medium';
}

// ─── Volatility Percentile (current vs 100-bar history) ───
// Tells us if current vol is at extremes relative to recent past — far more
// meaningful than absolute thresholds.
function volatilityPercentile(highs, lows, closes, period = 14, lookback = 100) {
  if (closes.length < period + lookback) return null;
  const atrSeries = [];
  for (let i = period; i < closes.length; i++) {
    const slice = { highs: highs.slice(0, i + 1), lows: lows.slice(0, i + 1), closes: closes.slice(0, i + 1) };
    const atr = calcATR(slice.highs, slice.lows, slice.closes, period);
    if (atr) atrSeries.push(atr);
  }
  if (atrSeries.length < lookback) return null;
  const recent = atrSeries.slice(-lookback);
  const current = atrSeries[atrSeries.length - 1];
  const below = recent.filter(v => v < current).length;
  return Math.round((below / recent.length) * 100);
}

// ─── Hurst-like Efficiency Ratio (Kaufman) ───
// > 0.5 = trending (price moves directly), < 0.5 = noisy/mean-reverting.
// Far more reliable signal of "trend vs chop" than EMA crossovers.
function efficiencyRatio(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-period - 1);
  const directionalChange = Math.abs(slice[slice.length - 1] - slice[0]);
  let totalChange = 0;
  for (let i = 1; i < slice.length; i++) {
    totalChange += Math.abs(slice[i] - slice[i - 1]);
  }
  if (totalChange === 0) return 0;
  return directionalChange / totalChange;
}

function classifyTrendStrength(analysis, efficiency) {
  // Use Kaufman's efficiency ratio as primary, fall back to composite if missing
  if (efficiency !== null && efficiency !== undefined) {
    if (efficiency > 0.4) return 'strong';
    if (efficiency > 0.2) return 'moderate';
    return 'weak';
  }
  const { indicators = {}, trend = { direction: 'FLAT', ema9above21: false }, compositeScore = 0 } = analysis || {};
  const rsi14 = parseFloat(indicators.rsi14) || 50;
  const absScore = Math.abs(compositeScore);
  if (absScore > 60 && trend.direction !== 'FLAT') return 'strong';
  if (absScore > 30 || (rsi14 > 60 && trend.ema9above21) || (rsi14 < 40 && !trend.ema9above21)) return 'moderate';
  return 'weak';
}

function classifyVolumeProfile(volRatio) {
  const vr = parseFloat(volRatio) || 1;
  if (vr > 1.8) return 'spike';
  if (vr < 0.6) return 'declining';
  return 'normal';
}

function detectTimeframeCategory(timeframe) {
  const tf = String(timeframe || '15');
  if (['1', '2', '3'].includes(tf)) return '1';
  if (['5', '10'].includes(tf)) return '5';
  if (['15', '30'].includes(tf)) return '15';
  if (['45', '60', '120', '180', '240'].includes(tf)) return '60';
  if (tf === 'D' || tf === '1D') return 'D';
  if (tf === 'W' || tf === '1W') return 'W';
  return '15';
}

function detectAssetClass(symbol) {
  if (!symbol) return 'equity';
  const s = symbol.toUpperCase();
  if (s.match(/^(ES|NQ|YM|RTY|CL|GC|SI|ZB|ZN|ZF|ZT|HG|NG|6E|6J|6B|6A|6C|NKD|FDAX|VX)\d?!?$/) || s.includes('1!')) return 'futures';
  if (s.match(/(BTC|ETH|SOL|BNB|XRP|ADA|DOGE|AVAX|DOT|MATIC|LINK)/) || s.includes('BINANCE') || s.includes('COINBASE') || s.includes('USDT') || s.includes('PERP')) return 'crypto';
  if (s.match(/^(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY){2}$/) || s.includes('FX:') || s.includes('OANDA')) return 'forex';
  return 'equity';
}

// ─── Trend Maturity (O(n) — rolling EMA, no slicing) ───
function computeTrendMaturity(closes) {
  if (!closes || closes.length < 20) return { bars: 0, phase: 'unknown', direction: 'unknown' };

  const k5 = 2 / 6;   // 5-period EMA smoothing constant
  const k10 = 2 / 11; // 10-period EMA smoothing constant

  // Compute full rolling EMA series in O(n)
  const ema5Series = [];
  const ema10Series = [];
  let e5 = closes.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  let e10 = closes.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
  for (let i = 0; i < closes.length; i++) {
    if (i >= 5) e5 = closes[i] * k5 + e5 * (1 - k5);
    if (i >= 10) e10 = closes[i] * k10 + e10 * (1 - k10);
    ema5Series.push(i >= 4 ? e5 : null);
    ema10Series.push(i >= 9 ? e10 : null);
  }

  const lastIdx = closes.length - 1;
  const currentDir = ema5Series[lastIdx] > ema10Series[lastIdx] ? 'up' : 'down';

  // Walk back counting consecutive bars with same EMA relationship
  let bars = 0;
  for (let i = lastIdx; i >= 9; i--) {
    const dir = ema5Series[i] > ema10Series[i] ? 'up' : 'down';
    if (dir !== currentDir) break;
    bars++;
    if (bars > 50) break;
  }

  let phase = 'early';
  if (bars > 20) phase = 'mature';
  else if (bars > 8) phase = 'established';

  return { bars, phase, direction: currentDir };
}

// ─── Swing-Point Based Divergence (proper implementation) ───
// Uses fractal swing detection (5-bar pivots) instead of arbitrary windows.
function detectSwingPoints(values, leftRight = 3) {
  const swings = [];
  for (let i = leftRight; i < values.length - leftRight; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= leftRight; j++) {
      if (values[i - j] >= values[i] || values[i + j] >= values[i]) isHigh = false;
      if (values[i - j] <= values[i] || values[i + j] <= values[i]) isLow = false;
    }
    if (isHigh) swings.push({ idx: i, value: values[i], type: 'high' });
    if (isLow) swings.push({ idx: i, value: values[i], type: 'low' });
  }
  return swings;
}

function detectMomentumDivergence(closes, highs, lows) {
  if (!closes || closes.length < 30) return { bearish: false, bullish: false, regular: false, hidden: false };

  // Compute rolling RSI in O(n)
  const rsi = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= 14) {
      avgGain += gain / 14;
      avgLoss += loss / 14;
      if (i === 14) {
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi.push(100 - 100 / (1 + rs));
      } else {
        rsi.push(null);
      }
    } else {
      avgGain = (avgGain * 13 + gain) / 14;
      avgLoss = (avgLoss * 13 + loss) / 14;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsi.push(100 - 100 / (1 + rs));
    }
  }

  // Detect swing highs in price (last 30 bars)
  const recentHighs = highs.slice(-30);
  const recentLows = lows.slice(-30);
  const offset = highs.length - recentHighs.length;
  const highSwings = detectSwingPoints(recentHighs, 3).filter(s => s.type === 'high');
  const lowSwings = detectSwingPoints(recentLows, 3).filter(s => s.type === 'low');

  let bearishDiv = false, bullishDiv = false;

  // Bearish: last 2 swing highs in price, RSI at those bars
  if (highSwings.length >= 2) {
    const h1 = highSwings[highSwings.length - 2];
    const h2 = highSwings[highSwings.length - 1];
    const rsiH1 = rsi[h1.idx + offset - 1];
    const rsiH2 = rsi[h2.idx + offset - 1];
    if (rsiH1 != null && rsiH2 != null && h2.value > h1.value && rsiH2 < rsiH1) {
      bearishDiv = true;
    }
  }

  // Bullish: last 2 swing lows in price, RSI at those bars
  if (lowSwings.length >= 2) {
    const l1 = lowSwings[lowSwings.length - 2];
    const l2 = lowSwings[lowSwings.length - 1];
    const rsiL1 = rsi[l1.idx + offset - 1];
    const rsiL2 = rsi[l2.idx + offset - 1];
    if (rsiL1 != null && rsiL2 != null && l2.value < l1.value && rsiL2 > rsiL1) {
      bullishDiv = true;
    }
  }

  return { bearish: bearishDiv, bullish: bullishDiv };
}

// ─── Regime Stability — has the regime been consistent or just changed? ───
function regimeStability(closes, highs, lows, currentRegime) {
  if (closes.length < 50) return { stable: false, barsInRegime: 0, transitionRisk: 'unknown' };

  // Re-classify regime over rolling 30-bar windows for the last 30 bars
  const window = 30;
  let consistentBars = 0;
  for (let i = closes.length - 1; i >= closes.length - 30 && i >= window + 20; i--) {
    const slice = closes.slice(0, i + 1);
    const er = efficiencyRatio(slice, 20);
    let priorRegime;
    if (er === null) break;
    if (er > 0.4) {
      const e9 = calcEMA(slice, 9);
      const e21 = calcEMA(slice, 21);
      priorRegime = e9 > e21 ? 'trending_up' : 'trending_down';
    } else {
      const bb = calcBollingerBands(slice, 20, 2);
      if (bb && bb.width < 2) priorRegime = 'squeeze';
      else if (bb && bb.width > 5) priorRegime = 'volatile';
      else priorRegime = 'ranging';
    }
    if (priorRegime === currentRegime) consistentBars++;
    else break;
  }

  let transitionRisk = 'low';
  if (consistentBars < 3) transitionRisk = 'high';      // very fresh regime, may flip
  else if (consistentBars < 10) transitionRisk = 'medium';

  return {
    stable: consistentBars >= 10,
    barsInRegime: consistentBars,
    transitionRisk,
  };
}

// ─── Multi-Timeframe Trend Alignment ───
// Use the existing 250 bars to derive a HTF view (e.g. 5x bars = 5x timeframe).
function multiTimeframeAlignment(closes, currentTfMinutes) {
  if (closes.length < 100) return { aligned: false, htfDirection: 'unknown', confluence: 'low' };

  // LTF: short EMA on current data
  const ltfEma = calcEMA(closes, 20);
  const ltfPrev = calcEMA(closes.slice(0, -10), 20);
  const ltfDir = ltfEma > ltfPrev ? 'up' : 'down';

  // HTF proxy: 50 vs 100 EMA on same data (effectively 5x timeframe view)
  const htfEma50 = calcEMA(closes, 50);
  const htfEma100 = calcEMA(closes, 100);
  const htfDir = htfEma50 > htfEma100 ? 'up' : 'down';

  // HHTF proxy: price vs 200-bar SMA
  const sma200 = closes.length >= 200 ? calcSMA(closes, 200) : null;
  const hhtfDir = sma200 ? (closes[closes.length - 1] > sma200 ? 'up' : 'down') : null;

  const directions = [ltfDir, htfDir, hhtfDir].filter(d => d);
  const upCount = directions.filter(d => d === 'up').length;
  const downCount = directions.filter(d => d === 'down').length;

  const aligned = upCount === directions.length || downCount === directions.length;
  let confluence = 'low';
  if (aligned) confluence = 'high';
  else if (upCount === 2 || downCount === 2) confluence = 'medium';

  return { aligned, ltfDirection: ltfDir, htfDirection: htfDir, hhtfDirection: hhtfDir, confluence };
}

// ─── Session/Time-of-Day Awareness ───
// Uses bar timestamps to determine session phase.
function detectSessionPhase(times, assetClass, timeframeCat) {
  if (!times || times.length === 0 || timeframeCat === 'D' || timeframeCat === 'W') {
    return { phase: 'n/a', dayOfWeek: 'n/a' };
  }
  const lastTime = times[times.length - 1];
  if (!lastTime) return { phase: 'unknown', dayOfWeek: 'unknown' };

  // TradingView bar times are in seconds, convert to ms
  const ms = lastTime > 1e12 ? lastTime : lastTime * 1000;
  const date = new Date(ms);
  const dayOfWeek = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getUTCDay()];

  // Crypto: 24/7, no session phase
  if (assetClass === 'crypto') return { phase: '24h', dayOfWeek };

  // Equity (Indian default): 9:15-15:30 IST = 3:45-10:00 UTC
  // Equity (US): 9:30-16:00 EST = 14:30-21:00 UTC
  // Forex: London 8-17 UTC, NY 13-22 UTC overlap = best liquidity
  const utcHour = date.getUTCHours();
  const utcMin = date.getUTCMinutes();
  const utcTotal = utcHour * 60 + utcMin;

  if (assetClass === 'equity') {
    // Try Indian session first (3:45-10:00 UTC = 9:15-15:30 IST)
    if (utcTotal >= 225 && utcTotal < 270) return { phase: 'open', dayOfWeek };  // first 45 min
    if (utcTotal >= 270 && utcTotal < 540) return { phase: 'midday', dayOfWeek };
    if (utcTotal >= 540 && utcTotal < 600) return { phase: 'close', dayOfWeek };  // last 60 min
    // US session (14:30-21:00 UTC)
    if (utcTotal >= 870 && utcTotal < 915) return { phase: 'open', dayOfWeek };
    if (utcTotal >= 915 && utcTotal < 1200) return { phase: 'midday', dayOfWeek };
    if (utcTotal >= 1200 && utcTotal < 1260) return { phase: 'close', dayOfWeek };
    return { phase: 'closed', dayOfWeek };
  }

  if (assetClass === 'forex') {
    if (utcHour >= 13 && utcHour < 17) return { phase: 'overlap', dayOfWeek };  // London-NY peak
    if (utcHour >= 8 && utcHour < 13) return { phase: 'london', dayOfWeek };
    if (utcHour >= 17 && utcHour < 22) return { phase: 'ny', dayOfWeek };
    if (utcHour >= 0 && utcHour < 8) return { phase: 'asia', dayOfWeek };
    return { phase: 'thin', dayOfWeek };
  }

  return { phase: 'session', dayOfWeek };
}

function scoreScript(scriptId, dna, analysis, context) {
  const { regime, indicators, compositeScore } = analysis;
  const {
    volatilityClass, volPercentile, trendStr, volumeProfile, timeframeCat,
    assetClass, trendMaturity, divergence, mtfAlignment, regimeStab, sessionPhase, efficiency,
  } = context;

  let totalScore = 0;
  const factors = [];

  // ─── Factor 1: Regime Affinity (weight: 25%) ───
  const regimeScore = dna.regimeAffinity[regime] || 50;
  totalScore += regimeScore * 0.25;
  if (regimeScore >= 80) factors.push({ label: `Ideal for ${regime} market`, impact: '+' });
  else if (regimeScore <= 30) factors.push({ label: `Poor fit for ${regime} regime`, impact: '-' });

  // ─── Factor 2: Volatility Match (weight: 15%) ───
  const volScore = dna.volatility[volatilityClass] || 50;
  totalScore += volScore * 0.15;
  if (volatilityClass === dna.volatility.ideal) factors.push({ label: `Ideal volatility (${volatilityClass})`, impact: '+' });
  else if (volScore <= 40) factors.push({ label: `Volatility mismatch (${volatilityClass} vs ideal ${dna.volatility.ideal})`, impact: '-' });

  // ─── Factor 3: Trend Strength (weight: 12%) ───
  const trendScore = dna.trendStrength[trendStr] || 50;
  totalScore += trendScore * 0.12;
  if (trendScore >= 80) factors.push({ label: `${trendStr} trend (ER ${(efficiency * 100).toFixed(0)}%) suits this strategy`, impact: '+' });

  // ─── Factor 4: Timeframe Fit (weight: 12%) ───
  const tfScore = dna.timeframe[timeframeCat] || 60;
  totalScore += tfScore * 0.12;
  if (tfScore >= 85) factors.push({ label: `Optimized for ${timeframeCat}min timeframe`, impact: '+' });
  else if (tfScore <= 40) factors.push({ label: `Suboptimal timeframe (${timeframeCat})`, impact: '-' });

  // ─── Factor 5: Volume Profile (weight: 8%) ───
  const volProfScore = dna.volumeProfile[volumeProfile] || 60;
  totalScore += volProfScore * 0.08;
  if (volumeProfile === 'spike' && volProfScore >= 80) factors.push({ label: 'Volume spike confirms entry', impact: '+' });

  // ─── Factor 6: Asset Class (weight: 8%) ───
  const assetScore = dna.assetClass[assetClass] || 70;
  totalScore += assetScore * 0.08;
  if (assetScore >= 90) factors.push({ label: `Excellent for ${assetClass}`, impact: '+' });

  // ─── Factor 7: Multi-Timeframe Confluence (weight: 10%) ───
  let mtfScore = 60;
  if (mtfAlignment.confluence === 'high') mtfScore = dna.style === 'trend_following' ? 95 : (dna.style === 'mean_reversion' ? 35 : 70);
  else if (mtfAlignment.confluence === 'low') mtfScore = dna.style === 'trend_following' ? 30 : (dna.style === 'mean_reversion' ? 75 : 60);
  totalScore += mtfScore * 0.10;
  if (mtfAlignment.confluence === 'high' && dna.style === 'trend_following') {
    factors.push({ label: `MTF aligned ${mtfAlignment.htfDirection}-trend (high confluence)`, impact: '+' });
  } else if (mtfAlignment.confluence === 'low' && dna.style === 'trend_following') {
    factors.push({ label: 'MTF disagrees — trend strategies risky', impact: '-' });
  }

  // ─── Factor 8: Regime Stability (weight: 10%) ───
  let stabScore = 60;
  if (regimeStab.transitionRisk === 'low') stabScore = 90; // stable regime, any strategy works
  else if (regimeStab.transitionRisk === 'high') {
    // Fresh regime — favor reversal/breakout, penalize trend continuation
    stabScore = dna.style === 'breakout' ? 90 : (dna.style === 'mean_reversion' ? 80 : 45);
  }
  totalScore += stabScore * 0.10;
  if (regimeStab.transitionRisk === 'high' && dna.style === 'breakout') {
    factors.push({ label: 'Fresh regime — breakout setups primed', impact: '+' });
  } else if (regimeStab.transitionRisk === 'high' && dna.style === 'trend_following') {
    factors.push({ label: 'Regime just shifted — trend may not persist', impact: '-' });
  } else if (regimeStab.barsInRegime > 15) {
    factors.push({ label: `Stable ${regime} regime (${regimeStab.barsInRegime} bars)`, impact: '+' });
  }

  // ─── Bonus/Penalty Modifiers ───

  // Volatility percentile bonus
  if (volPercentile != null) {
    if (volPercentile > 80 && dna.style === 'mean_reversion') {
      totalScore += 4; factors.push({ label: `Vol at ${volPercentile}th percentile — mean reversion edge`, impact: '+' });
    }
    if (volPercentile < 20 && dna.style === 'breakout') {
      totalScore += 6; factors.push({ label: `Vol at ${volPercentile}th percentile — breakout coiled`, impact: '+' });
    }
  }

  // Trend maturity
  if (dna.style === 'trend_following') {
    if (trendMaturity.phase === 'early') { totalScore += 5; factors.push({ label: `Early trend (${trendMaturity.bars} bars) — high potential`, impact: '+' }); }
    else if (trendMaturity.phase === 'mature') { totalScore -= 6; factors.push({ label: `Mature trend (${trendMaturity.bars} bars) — exhaustion risk`, impact: '-' }); }
  }
  if (dna.style === 'mean_reversion' && trendMaturity.phase === 'mature') {
    totalScore += 5; factors.push({ label: 'Mature trend — reversal forming', impact: '+' });
  }

  // Divergence
  if (divergence.bullish && dna.style === 'mean_reversion') {
    totalScore += 8; factors.push({ label: 'Bullish RSI divergence on swing lows', impact: '+' });
  }
  if (divergence.bearish && dna.style === 'trend_following' && regime.includes('up')) {
    totalScore -= 6; factors.push({ label: 'Bearish divergence — trend weakening', impact: '-' });
  }

  // Composite signal alignment
  if (compositeScore > 50 && dna.style === 'mean_reversion') totalScore -= 3;
  if (compositeScore < -50 && dna.style === 'mean_reversion') {
    totalScore += 7; factors.push({ label: 'Deep oversold — prime mean reversion zone', impact: '+' });
  }
  if (compositeScore > 50 && dna.style === 'trend_following') {
    totalScore += 5; factors.push({ label: 'Strong bullish momentum — trend following favored', impact: '+' });
  }

  // Session bonus for VWAP-like strategies
  if (dna.style === 'overlay' && (sessionPhase.phase === 'open' || sessionPhase.phase === 'overlap')) {
    totalScore += 3;
    factors.push({ label: `${sessionPhase.phase} session — VWAP/levels active`, impact: '+' });
  }
  if (sessionPhase.phase === 'close' && dna.style === 'mean_reversion') {
    totalScore += 2; factors.push({ label: 'End-of-day — fade extremes', impact: '+' });
  }

  // Sort factors: positive first, then by recency
  factors.sort((a, b) => (a.impact === b.impact) ? 0 : (a.impact === '+' ? -1 : 1));

  const normalizedScore = Math.max(0, Math.min(100, totalScore));

  return {
    id: scriptId,
    name: dna.name,
    score: Math.round(normalizedScore),
    style: dna.style,
    riskLevel: dna.riskLevel,
    holdingPeriod: dna.holdingPeriod,
    factors: factors.slice(0, 5),
    source: BACKTEST_LOGIC[scriptId] ? 'backtested' : 'ai_only',
  };
}

function autoSelectStrategy(analysis, context = {}) {
  if (!analysis) return { strategy: 'rsi2', reason: 'Default — no analysis data', rankings: [], quality: { sufficient: false, reason: 'No analysis data' } };

  const { regime, indicators = {} } = analysis;

  // Quality gates
  const dataQuality = {
    sufficient: context.barCount >= 100,
    barCount: context.barCount || 0,
    warnings: [],
  };
  if (context.barCount < 100) dataQuality.warnings.push(`Only ${context.barCount} bars — insufficient for percentile/MTF analysis`);
  if (context.barCount < 200) dataQuality.warnings.push('Multi-timeframe confluence limited (need 200+ bars)');

  // Build full context
  const atrPct = parseFloat(indicators.atrPct) || 1.5;
  const assetClass = detectAssetClass(context.symbol);
  const volatilityClass = classifyVolatility(atrPct, assetClass);
  const efficiency = context.efficiency != null ? context.efficiency : null;
  const trendStr = classifyTrendStrength(analysis, efficiency);
  const volumeProfile = classifyVolumeProfile(indicators.volRatio);
  const timeframeCat = detectTimeframeCategory(context.timeframe);
  const trendMaturity = context.trendMaturity || { bars: 0, phase: 'unknown' };
  const divergence = context.divergence || { bearish: false, bullish: false };
  const mtfAlignment = context.mtfAlignment || { aligned: false, confluence: 'low', htfDirection: 'unknown' };
  const regimeStab = context.regimeStab || { stable: false, barsInRegime: 0, transitionRisk: 'unknown' };
  const sessionPhase = context.sessionPhase || { phase: 'n/a', dayOfWeek: 'n/a' };
  const volPercentile = context.volPercentile != null ? context.volPercentile : null;

  const scoringContext = {
    volatilityClass, volPercentile, trendStr, volumeProfile, timeframeCat,
    assetClass, trendMaturity, divergence, mtfAlignment, regimeStab, sessionPhase, efficiency: efficiency || 0,
  };

  // Score every script
  const rankings = [];
  for (const [scriptId, dna] of Object.entries(SCRIPT_DNA)) {
    rankings.push(scoreScript(scriptId, dna, analysis, scoringContext));
  }
  rankings.sort((a, b) => b.score - a.score);

  const top = rankings[0];
  const runner = rankings[1];

  // Ambiguity detection: top picks tied
  const ambiguous = runner && (top.score - runner.score) < 5;
  const margin = runner ? top.score - runner.score : 100;

  // Quality verdict
  let qualityVerdict = 'good';
  let actionable = true;
  if (top.score < 50) {
    qualityVerdict = 'poor';
    actionable = false;
    dataQuality.warnings.push('No script scores above 50 — current conditions are unfavorable for any strategy. Consider waiting.');
  } else if (top.score < 65) {
    qualityVerdict = 'fair';
  } else if (top.score >= 80) {
    qualityVerdict = 'excellent';
  }

  if (ambiguous) {
    dataQuality.warnings.push(`Top picks within ${margin} pts — multiple strategies viable, consider both`);
  }

  // Confidence: combine score, ambiguity, and data quality
  let confidence = 'low';
  if (top.score >= 80 && !ambiguous && dataQuality.sufficient) confidence = 'high';
  else if (top.score >= 65 && dataQuality.sufficient) confidence = 'medium';

  // Generate reason
  const topPositive = top.factors.filter(f => f.impact === '+').slice(0, 2);
  const reason = topPositive.length > 0
    ? `${top.name} scores ${top.score}/100. ${topPositive.map(f => f.label).join('. ')}.`
    : `${top.name} best fits current ${regime} conditions (score: ${top.score}/100).`;

  return {
    strategy: top.id,
    reason,
    score: top.score,
    source: top.source,
    confidence,
    actionable,
    qualityVerdict,
    margin,
    ambiguous,
    dataQuality,
    context: {
      regime,
      regimeStability: regimeStab.transitionRisk,
      regimeBars: regimeStab.barsInRegime,
      volatility: volatilityClass,
      volatilityPercentile: volPercentile,
      trendStrength: trendStr,
      efficiencyRatio: efficiency != null ? Math.round(efficiency * 100) : null,
      trendMaturity: trendMaturity.phase,
      trendDirection: trendMaturity.direction,
      mtfConfluence: mtfAlignment.confluence,
      htfDirection: mtfAlignment.htfDirection,
      volumeProfile,
      timeframe: timeframeCat,
      assetClass,
      session: sessionPhase.phase,
      dayOfWeek: sessionPhase.dayOfWeek,
      divergence: divergence.bullish ? 'bullish' : divergence.bearish ? 'bearish' : 'none',
    },
    rankings: rankings.slice(0, 5),
    alt: runner ? { strategy: runner.id, reason: `${runner.name} (score: ${runner.score}/100)`, score: runner.score } : null,
  };
}

// ── Backtest & Re-Rank ──
// Quant-grade scoring (Citadel/Jane Street-style):
//   STAGE 1: Run backtest on all candidates → get PSR, Wilson-LB WR, Calmar, Sortino, OOS, regime fit
//   STAGE 2: HARD FILTERS (multiplicative penalties — losing strategies cannot rank #1)
//        - Net loss:           score *= 0.15  (aggressive penalty for losers)
//        - Profit Factor < 1:  score *= 0.20  (loses money long-term)
//        - Trades < 5:         score *= 0.40  (insufficient sample, "unproven")
//        - DD > 25%:           score *= 0.65  (excessive risk)
//        - Negative expectancy: score *= 0.30
//   STAGE 3: Compute weighted quantScore (re-balanced toward direct profit metrics):
//        - Net Profit ratio (return/initial)         20% (direct profitability)
//        - Profit Factor                             18% (raised from 5%)
//        - Sharpe Ratio                              12% (risk-adjusted return)
//        - PSR (probability Sharpe > 0)              12%
//        - Wilson-LB Win Rate (statistical edge)     10%
//        - Calmar (return/DD)                        10%
//        - Sortino (downside risk)                    7%
//        - Sample-size confidence                     5%
//        - Regime fit (current vs historical)         6%
//   STAGE 4: Deflated Sharpe correction for picking best of N
//   STAGE 5: Penalize unbacktested ("unproven") strategies — cap at 50 if no backtest
//   STAGE 6: Final blend: quantScore × 0.80 + aiScore × 0.20 (backtest dominates)
function backtestAndRerank(rankings, data, analysis, opts = {}) {
  const full = opts.full || false;
  const numCandidates = (rankings || []).length || 1;
  const currentRegime = analysis?.regime || 'unknown';

  const enriched = (rankings || []).map(r => {
    let backtest = null;
    let quantScore = null;
    let hardFilters = []; // track which penalties applied (for transparency)

    if (BACKTEST_LOGIC[r.id]) {
      const bt = runBacktest(r.id, { ...data, analysis }, {});
      if (bt) {
        // ── Component sub-scores (each 0-100) ──

        // 1. Net Profit Ratio — direct profitability (Citadel emphasizes this)
        // Return %: -10% → 20, 0% → 50, +10% → 75, +25% → 92, +50% → 98
        const returnPct = bt.capital?.returnPct || 0;
        const netProfitScore = Quant.scale(returnPct, 5, 0.15); // sigmoid centered at 5%

        // 2. Profit Factor — saturating: PF=1.0 → 50, PF=1.5 → 70, PF=2.5 → 90
        const pfScore = Quant.scale(bt.profitFactor || 0, 1.5, 1.5);

        // 3. Sharpe Ratio — direct risk-adjusted return: Sharpe=0.5 → 60, Sharpe=1.5 → 87
        const sharpeScore = Quant.scale(bt.sharpe || 0, 0.5, 2);

        // 4. PSR — already 0-1, scale to 0-100
        const psrScore = bt.psr || 0;

        // 5. Wilson-LB WR (out-of-sample preferred, fallback to in-sample)
        const oosWilson = bt.oos?.wilsonWR || 0;
        const wilsonWR = bt.wilsonWR || 0;
        const wrScore = (bt.oos?.trades >= 5) ? oosWilson : (wilsonWR * 0.7);

        // 6. Calmar — saturating sigmoid: Calmar=2 → 60, Calmar=5 → 90
        const calmarScore = Quant.scale(bt.calmar || 0, 1.5, 0.7);

        // 7. Sortino — sigmoid: Sortino=0.5 → 60, Sortino=1.5 → 90
        const sortinoScore = Quant.scale(bt.sortino || 0, 0.4, 3);

        // 8. Sample size confidence (more trades = more confidence)
        const sampleScore = Quant.scale(bt.totalTrades || 0, 15, 0.20);

        // 9. Regime fit — did this strategy win in the CURRENT regime historically?
        let regimeFit = 50;
        const rPerf = bt.regimePerformance?.[currentRegime];
        if (rPerf && rPerf.count >= 3) {
          regimeFit = Quant.wilsonLower(rPerf.wins, rPerf.count) * 100;
        } else if (rPerf && rPerf.count > 0) {
          regimeFit = (rPerf.winRate * 0.4) + (bt.winRate * 0.6) * 0.7;
        }

        // ── Weighted composite (Citadel-style: profitability > statistical metrics) ──
        const rawScore =
          netProfitScore * 0.20 +  // direct profit (was missing)
          pfScore        * 0.18 +  // profitability (was 5%)
          sharpeScore    * 0.12 +  // risk-adjusted return (was implicit only)
          psrScore       * 0.12 +  // probabilistic significance
          wrScore        * 0.10 +  // statistical edge
          calmarScore    * 0.10 +  // return per unit DD
          sortinoScore   * 0.07 +  // downside risk
          sampleScore    * 0.05 +  // sample confidence
          regimeFit      * 0.06;   // regime alignment

        // ── HARD FILTERS (multiplicative penalties — losing strategies CANNOT rank #1) ──
        let penalty = 1.0;

        // Net loss → aggressive 85% penalty (Citadel won't deploy losing systems)
        if ((bt.totalPnl || 0) < 0 || returnPct < 0) {
          penalty *= 0.15;
          hardFilters.push('NET_LOSS');
        }

        // Profit Factor < 1 → loses money long-term
        if ((bt.profitFactor || 0) < 1.0) {
          penalty *= 0.20;
          hardFilters.push('PF_LT_1');
        }

        // Insufficient sample size → unproven
        if ((bt.totalTrades || 0) < 5) {
          penalty *= 0.40;
          hardFilters.push('LOW_SAMPLE');
        } else if ((bt.totalTrades || 0) < 10) {
          penalty *= 0.75;
          hardFilters.push('LIMITED_SAMPLE');
        }

        // Excessive drawdown → too risky for institutional capital
        const ddPct = bt.maxDrawdown || 0;
        if (ddPct > 25) {
          penalty *= 0.65;
          hardFilters.push('HIGH_DD');
        } else if (ddPct > 15) {
          penalty *= 0.85;
          hardFilters.push('MODERATE_DD');
        }

        // Negative expectancy → loses on average per trade
        if ((bt.expectancy || 0) < 0) {
          penalty *= 0.30;
          hardFilters.push('NEG_EXPECTANCY');
        }

        // Low PSR (likely noise) → not statistically significant
        if (psrScore < 30) {
          penalty *= 0.80;
          hardFilters.push('LOW_PSR');
        }

        // ── Deflated Sharpe correction: penalize for picking best of N ──
        const dsrPenalty = Math.max(0.85, 1 - Math.log(Math.max(numCandidates, 1)) / 30);
        quantScore = Math.round(rawScore * penalty * dsrPenalty);

        backtest = full ? {
          totalTrades: bt.totalTrades,
          wins: bt.wins,
          losses: bt.losses,
          winRate: bt.winRate,
          totalPnl: bt.totalPnl,
          profitFactor: bt.profitFactor,
          maxDrawdown: bt.maxDrawdown,
          sharpe: bt.sharpe,
          expectancy: bt.expectancy,
          avgBarsHeld: bt.avgBarsHeld,
          avgWin: bt.avgWin,
          avgLoss: bt.avgLoss,
          currentSignal: bt.currentSignal,
          equity: bt.equity,
          barsAnalyzed: bt.barsAnalyzed,
          name: bt.name,
          capital: bt.capital,
          // Quant metrics
          wilsonWR: bt.wilsonWR,
          psr: bt.psr,
          sortino: bt.sortino,
          calmar: bt.calmar,
          ulcer: bt.ulcer,
          bootstrap95: bt.bootstrap95,
          skew: bt.skew,
          kurtosis: bt.kurtosis,
          oos: bt.oos,
          regimePerformance: bt.regimePerformance,
          quantScore,
          hardFilters,
          rawScore: Math.round(rawScore),
          penaltyMultiplier: parseFloat(penalty.toFixed(3)),
          components: {
            netProfit: Math.round(netProfitScore),
            profitFactor: Math.round(pfScore),
            sharpe: Math.round(sharpeScore),
            psr: Math.round(psrScore),
            wilsonWR: Math.round(wrScore),
            calmar: Math.round(calmarScore),
            sortino: Math.round(sortinoScore),
            sample: Math.round(sampleScore),
            regimeFit: Math.round(regimeFit),
          },
        } : {
          totalTrades: bt.totalTrades,
          winRate: bt.winRate,
          totalPnl: bt.totalPnl,
          profitFactor: bt.profitFactor,
          currentSignal: bt.currentSignal,
          capital: bt.capital,
          // Compact quant metrics
          psr: bt.psr,
          wilsonWR: bt.wilsonWR,
          sharpe: bt.sharpe,
          sortino: bt.sortino,
          calmar: bt.calmar,
          oos: bt.oos,
          quantScore,
          hardFilters,
        };
      }
    }

    // ── Final blended score ──
    // BACKTESTED strategies: 80% quant, 20% AI (was 65/35 — backtest dominates)
    // UNBACKTESTED strategies: aiScore capped at 50 (Citadel: untested = unproven, max neutral)
    const aiScore = r.score || 0;
    let finalScore;
    if (quantScore != null) {
      finalScore = Math.round(quantScore * 0.80 + aiScore * 0.20);
    } else {
      // Cap unbacktested at 50 — they cannot rank above proven losers
      finalScore = Math.min(50, Math.round(aiScore * 0.6));
    }

    return {
      ...r,
      backtest,
      monitorable: !!BACKTEST_LOGIC[r.id] || !!STRATEGIES[r.id],
      aiScore,
      quantScore,
      finalScore,
      hardFilters: hardFilters.length > 0 ? hardFilters : undefined,
      proven: quantScore != null,
    };
  });

  // Sort by finalScore (highest first)
  enriched.sort((a, b) => b.finalScore - a.finalScore);

  return enriched;
}

// ── Unified Selection Context Builder ──
// Single entry point that runs all the analytics in O(n) and returns the full context.
function buildSelectionContext(data, analysis) {
  const closes = data.closes || [];
  const highs = data.highs || [];
  const lows = data.lows || [];
  const times = data.times || [];

  const trendMaturity = computeTrendMaturity(closes);
  const divergence = detectMomentumDivergence(closes, highs, lows);
  const efficiency = efficiencyRatio(closes, 20);
  const volPercentile = volatilityPercentile(highs, lows, closes, 14, 100);
  const mtfAlignment = multiTimeframeAlignment(closes, parseInt(data.timeframe) || 15);
  const regimeStab = regimeStability(closes, highs, lows, analysis.regime);
  const assetClass = detectAssetClass(data.symbol);
  const timeframeCat = detectTimeframeCategory(data.timeframe);
  const sessionPhase = detectSessionPhase(times, assetClass, timeframeCat);

  return {
    symbol: data.symbol,
    timeframe: data.timeframe,
    barCount: closes.length,
    trendMaturity,
    divergence,
    efficiency,
    volPercentile,
    mtfAlignment,
    regimeStab,
    sessionPhase,
  };
}

// ── Selection Log (feedback infrastructure) ──
let selectionLog = loadJSON('selection-log.json', []);

function logSelection(entry) {
  selectionLog.unshift(entry);
  if (selectionLog.length > 500) selectionLog.length = 500;
  debouncedSave('selection-log.json', () => selectionLog);
}

// Aggregate stats per strategy: how often picked, avg score, regime distribution
function selectionStats() {
  const byStrategy = {};
  for (const entry of selectionLog) {
    if (!byStrategy[entry.topPick]) {
      byStrategy[entry.topPick] = { count: 0, avgScore: 0, scoreSum: 0, regimes: {}, symbols: new Set() };
    }
    const s = byStrategy[entry.topPick];
    s.count++;
    s.scoreSum += entry.score || 0;
    s.avgScore = Math.round(s.scoreSum / s.count);
    s.regimes[entry.regime] = (s.regimes[entry.regime] || 0) + 1;
    s.symbols.add(entry.symbol);
  }
  for (const k in byStrategy) {
    byStrategy[k].symbolCount = byStrategy[k].symbols.size;
    delete byStrategy[k].symbols;
    delete byStrategy[k].scoreSum;
  }
  return byStrategy;
}

// ══════════════════════════════════════════════════════════════════════
// ── QUANT MATH — Statistical helpers (Jane Street-style rigor)
// ══════════════════════════════════════════════════════════════════════
const Quant = {
  // Welford's online mean/variance (numerically stable)
  stats(arr) {
    const n = arr.length;
    if (n === 0) return { mean: 0, std: 0, skew: 0, kurt: 0, n: 0 };
    let mean = 0, M2 = 0, M3 = 0, M4 = 0;
    for (let i = 0; i < n; i++) {
      const x = arr[i];
      const delta = x - mean;
      const delta_n = delta / (i + 1);
      const delta_n2 = delta_n * delta_n;
      const term1 = delta * delta_n * i;
      mean += delta_n;
      M4 += term1 * delta_n2 * (i * i - 3 * i + 3) + 6 * delta_n2 * M2 - 4 * delta_n * M3;
      M3 += term1 * delta_n * (i - 1) - 3 * delta_n * M2;
      M2 += term1;
    }
    const variance = n > 1 ? M2 / (n - 1) : 0;
    const std = Math.sqrt(variance);
    const skew = n > 2 && M2 > 0 ? (Math.sqrt(n) * M3) / Math.pow(M2, 1.5) : 0;
    const kurt = n > 3 && M2 > 0 ? (n * M4) / (M2 * M2) - 3 : 0; // excess kurtosis
    return { mean, std, variance, skew, kurt, n };
  },

  // Wilson score interval — better than Wald for small samples
  // Returns lower bound at given confidence (default 95%)
  wilsonLower(wins, n, z = 1.96) {
    if (n === 0) return 0;
    const p = wins / n;
    const denom = 1 + (z * z) / n;
    const center = p + (z * z) / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    return Math.max(0, (center - margin) / denom);
  },

  // Probabilistic Sharpe Ratio (Bailey & López de Prado 2012)
  // Probability that the true Sharpe > benchmark Sharpe (default 0)
  probabilisticSharpe(returns, benchmarkSR = 0) {
    const s = Quant.stats(returns);
    if (s.n < 4 || s.std === 0) return 0;
    const sr = s.mean / s.std;
    const psrDenom = Math.sqrt((1 - s.skew * sr + ((s.kurt) / 4) * sr * sr) / (s.n - 1));
    if (psrDenom === 0) return sr > benchmarkSR ? 1 : 0;
    const z = (sr - benchmarkSR) / psrDenom;
    return Quant.normalCDF(z);
  },

  // Deflated Sharpe Ratio — corrects for selection bias when picking best of N
  deflatedSharpe(returns, numTrials = 1) {
    const s = Quant.stats(returns);
    if (s.n < 4 || s.std === 0 || numTrials < 1) return 0;
    const sr = s.mean / s.std;
    // Expected max SR from N independent trials (Bailey & López de Prado)
    const emc = 0.5772156649; // Euler-Mascheroni
    const expectedMax = Math.sqrt(2 * Math.log(Math.max(numTrials, 2))) -
      (emc / Math.sqrt(2 * Math.log(Math.max(numTrials, 2))));
    const psrDenom = Math.sqrt((1 - s.skew * sr + (s.kurt / 4) * sr * sr) / (s.n - 1));
    if (psrDenom === 0) return 0;
    const z = (sr - expectedMax) / psrDenom;
    return Quant.normalCDF(z);
  },

  // Standard normal CDF (Abramowitz & Stegun approximation)
  normalCDF(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
  },

  // Sortino ratio — uses downside deviation only
  sortino(returns, mar = 0) {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const downside = returns.filter(r => r < mar).map(r => (r - mar) ** 2);
    if (downside.length === 0) return mean > 0 ? 99 : 0;
    const downsideStd = Math.sqrt(downside.reduce((a, b) => a + b, 0) / downside.length);
    return downsideStd > 0 ? (mean - mar) / downsideStd : 0;
  },

  // Calmar ratio — return / max drawdown
  calmar(totalReturn, maxDrawdown) {
    if (maxDrawdown <= 0) return totalReturn > 0 ? 99 : 0;
    return totalReturn / maxDrawdown;
  },

  // Ulcer Index — measures depth and duration of drawdowns
  ulcerIndex(equity) {
    if (equity.length < 2) return 0;
    let sumSqDD = 0, peak = equity[0];
    for (const v of equity) {
      peak = Math.max(peak, v);
      const dd = peak === 0 ? 0 : ((v - peak) / Math.max(Math.abs(peak), 1)) * 100;
      sumSqDD += dd * dd;
    }
    return Math.sqrt(sumSqDD / equity.length);
  },

  // Bootstrap percentile confidence interval for mean P&L
  bootstrapMean(returns, iterations = 1000, confidence = 0.95) {
    if (returns.length < 5) return { lower: 0, upper: 0, mean: 0 };
    const n = returns.length;
    const means = new Array(iterations);
    for (let it = 0; it < iterations; it++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += returns[Math.floor(Math.random() * n)];
      means[it] = sum / n;
    }
    means.sort((a, b) => a - b);
    const lo = Math.floor(((1 - confidence) / 2) * iterations);
    const hi = Math.floor((1 - (1 - confidence) / 2) * iterations);
    const mean = returns.reduce((a, b) => a + b, 0) / n;
    return { lower: means[lo], upper: means[hi], mean };
  },

  // ADX (Average Directional Index) — trend strength 0-100
  adx(highs, lows, closes, period = 14) {
    const n = closes.length;
    if (n < period * 2) return null;
    const trs = [], plusDMs = [], minusDMs = [];
    for (let i = 1; i < n; i++) {
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      const upMove = highs[i] - highs[i - 1];
      const downMove = lows[i - 1] - lows[i];
      trs.push(tr);
      plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }
    // Wilder smoothing
    let trAvg = trs.slice(0, period).reduce((a, b) => a + b, 0);
    let plusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
    let minusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
    const dxs = [];
    for (let i = period; i < trs.length; i++) {
      trAvg = trAvg - trAvg / period + trs[i];
      plusDM = plusDM - plusDM / period + plusDMs[i];
      minusDM = minusDM - minusDM / period + minusDMs[i];
      const plusDI = trAvg > 0 ? (plusDM / trAvg) * 100 : 0;
      const minusDI = trAvg > 0 ? (minusDM / trAvg) * 100 : 0;
      const sumDI = plusDI + minusDI;
      const dx = sumDI > 0 ? (Math.abs(plusDI - minusDI) / sumDI) * 100 : 0;
      dxs.push(dx);
    }
    if (dxs.length < period) return null;
    let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < dxs.length; i++) adx = (adx * (period - 1) + dxs[i]) / period;
    return adx;
  },

  // Hurst exponent (R/S analysis) — H<0.5 mean-reverting, H=0.5 random, H>0.5 trending
  hurst(values) {
    if (values.length < 50) return null;
    const N = values.length;
    const lags = [10, 20, 40, Math.min(80, Math.floor(N / 2))];
    const rsVals = [];
    const lagVals = [];
    for (const lag of lags) {
      if (lag >= N) continue;
      // Compute log returns
      const returns = [];
      for (let i = 1; i < lag + 1; i++) returns.push(Math.log(values[N - lag + i - 1] / values[N - lag + i - 2]));
      if (returns.length < 2) continue;
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      let cumDev = 0, minCum = 0, maxCum = 0;
      for (const r of returns) {
        cumDev += r - mean;
        minCum = Math.min(minCum, cumDev);
        maxCum = Math.max(maxCum, cumDev);
      }
      const range = maxCum - minCum;
      const std = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length);
      if (std === 0 || range === 0) continue;
      rsVals.push(Math.log(range / std));
      lagVals.push(Math.log(lag));
    }
    if (rsVals.length < 2) return null;
    // Linear regression slope
    const m = rsVals.length;
    const sumX = lagVals.reduce((a, b) => a + b, 0);
    const sumY = rsVals.reduce((a, b) => a + b, 0);
    const sumXY = lagVals.reduce((s, x, i) => s + x * rsVals[i], 0);
    const sumXX = lagVals.reduce((s, x) => s + x * x, 0);
    const slope = (m * sumXY - sumX * sumY) / (m * sumXX - sumX * sumX);
    return slope;
  },

  // Variance ratio test — random walk if VR ≈ 1; trending if > 1; mean-reverting if < 1
  varianceRatio(closes, lag = 5) {
    if (closes.length < lag * 4) return null;
    const returns = [];
    for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
    const lagReturns = [];
    for (let i = lag; i < closes.length; i++) lagReturns.push(Math.log(closes[i] / closes[i - lag]));
    const var1 = Quant.stats(returns).variance;
    const varK = Quant.stats(lagReturns).variance;
    if (var1 === 0) return null;
    return varK / (lag * var1);
  },

  // Sigmoid scaling: smoothly maps any value to (0, 100)
  scale(x, midpoint, steepness = 1) {
    return 100 / (1 + Math.exp(-steepness * (x - midpoint)));
  },
};

// ══════════════════════════════════════════════════════════════════════
// ── BACKTEST ENGINE — Simulates strategies bar-by-bar on historical data
// ══════════════════════════════════════════════════════════════════════

// Strategy logic definitions for backtesting.
// Each returns { entry: bool, exit: bool } per bar, given indicators state.
const BACKTEST_LOGIC = {
  rsi2: {
    name: 'RSI(2) Mean Reversion',
    warmup: 20,
    run(bars, params = {}) {
      const tp = params.tp || 1.5, sl = params.sl || 1.0, maxBars = params.maxBars || 5;
      const oversold = params.oversold || 30, exitLevel = params.exitLevel || 50;
      return backtestLoop(bars, (i, state) => {
        const rsi = rollingRSI(bars.closes, 2, i);
        const volSMA = sma(bars.volumes, 20, i);
        const volOK = volSMA > 0 && bars.volumes[i] > volSMA;
        const entry = !state.inTrade && rsi !== null && rsi < oversold && volOK;
        const exitSignal = state.inTrade && rsi !== null && rsi > exitLevel;
        return { entry, exitSignal };
      }, { tp, sl, maxBars });
    },
  },
  ema_crossover: {
    name: 'EMA Crossover (9/21)',
    warmup: 25,
    run(bars, params = {}) {
      const tp = params.tp || 2.0, sl = params.sl || 1.5;
      const fast = params.fast || 9, slow = params.slow || 21;
      // Pre-compute EMA series
      const emaF = emaSeries(bars.closes, fast);
      const emaS = emaSeries(bars.closes, slow);
      return backtestLoop(bars, (i, state) => {
        if (i < slow + 1) return { entry: false, exitSignal: false };
        const cross = emaF[i] > emaS[i] && emaF[i - 1] <= emaS[i - 1];
        const deathCross = emaF[i] < emaS[i] && emaF[i - 1] >= emaS[i - 1];
        return { entry: !state.inTrade && cross, exitSignal: state.inTrade && deathCross };
      }, { tp, sl, maxBars: 30 });
    },
  },
  bollinger_breakout: {
    name: 'Bollinger Squeeze Breakout',
    warmup: 25,
    run(bars, params = {}) {
      const tp = params.tp || 2.0, sl = params.sl || 1.0;
      return backtestLoop(bars, (i, state) => {
        if (i < 21) return { entry: false, exitSignal: false };
        const slice = bars.closes.slice(i - 19, i + 1);
        const mean = slice.reduce((a, b) => a + b, 0) / 20;
        const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
        const upper = mean + 2 * std;
        const width = (4 * std) / mean * 100;
        const prevSlice = bars.closes.slice(i - 20, i);
        const prevMean = prevSlice.reduce((a, b) => a + b, 0) / 20;
        const prevStd = Math.sqrt(prevSlice.reduce((a, b) => a + (b - prevMean) ** 2, 0) / 20);
        const prevWidth = (4 * prevStd) / prevMean * 100;
        const wasSqueeze = prevWidth < 3;
        const breakout = wasSqueeze && bars.closes[i] > upper;
        return { entry: !state.inTrade && breakout, exitSignal: state.inTrade && bars.closes[i] < mean };
      }, { tp, sl, maxBars: 15 });
    },
  },
  mean_reversion: {
    name: 'Multi-Signal Mean Reversion',
    warmup: 25,
    run(bars, params = {}) {
      const tp = params.tp || 1.5, sl = params.sl || 1.5;
      return backtestLoop(bars, (i, state) => {
        if (i < 21) return { entry: false, exitSignal: false };
        const rsi = rollingRSI(bars.closes, 2, i);
        const slice = bars.closes.slice(i - 19, i + 1);
        const mean = slice.reduce((a, b) => a + b, 0) / 20;
        const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
        const lowerBB = mean - 2 * std;
        const ibs = bars.highs[i] !== bars.lows[i] ? (bars.closes[i] - bars.lows[i]) / (bars.highs[i] - bars.lows[i]) : 0.5;
        const sigRSI = rsi !== null && rsi < 25;
        const sigBB = bars.closes[i] <= lowerBB;
        const sigIBS = ibs < 0.3;
        const volSMA = sma(bars.volumes, 20, i);
        const volOK = volSMA > 0 && bars.volumes[i] > volSMA;
        const score = (sigRSI ? 1 : 0) + (sigBB ? 1 : 0) + (sigIBS ? 1 : 0);
        const entry = !state.inTrade && score >= 2 && volOK;
        const exitRSI = rsi !== null && rsi > 60;
        return { entry, exitSignal: state.inTrade && exitRSI };
      }, { tp, sl, maxBars: 5 });
    },
  },
  vwap_deviation: {
    name: 'VWAP Deviation Bands',
    warmup: 25,
    run(bars, params = {}) {
      // Simulate VWAP bounce: buy below -2σ, exit at mean
      const tp = params.tp || 1.5, sl = params.sl || 1.5;
      return backtestLoop(bars, (i, state) => {
        if (i < 21) return { entry: false, exitSignal: false };
        // Use volume-weighted average of recent 20 bars as VWAP proxy
        let sumPV = 0, sumV = 0;
        for (let j = i - 19; j <= i; j++) { sumPV += bars.closes[j] * bars.volumes[j]; sumV += bars.volumes[j]; }
        const vwap = sumV > 0 ? sumPV / sumV : bars.closes[i];
        const slice = bars.closes.slice(i - 19, i + 1);
        const std = Math.sqrt(slice.reduce((a, b) => a + (b - vwap) ** 2, 0) / 20);
        const lower2 = vwap - 2 * std;
        const entry = !state.inTrade && bars.closes[i] < lower2;
        const exitSignal = state.inTrade && bars.closes[i] > vwap;
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 10 });
    },
  },
  momentum_roc: {
    name: 'Momentum ROC',
    warmup: 20,
    run(bars, params = {}) {
      const tp = params.tp || 2.0, sl = params.sl || 1.5, rocLen = params.rocLen || 12;
      return backtestLoop(bars, (i, state) => {
        if (i < rocLen + 9) return { entry: false, exitSignal: false };
        const roc = (bars.closes[i] - bars.closes[i - rocLen]) / bars.closes[i - rocLen] * 100;
        const prevRoc = (bars.closes[i - 1] - bars.closes[i - 1 - rocLen]) / bars.closes[i - 1 - rocLen] * 100;
        // Signal line (9-EMA of ROC) approximation: just use prev ROC
        const bullCross = roc > prevRoc && prevRoc < 0 && roc > -2;
        const bearCross = roc < prevRoc && roc < 0;
        return { entry: !state.inTrade && bullCross, exitSignal: state.inTrade && bearCross };
      }, { tp, sl, maxBars: 20 });
    },
  },
  stochastic_rsi: {
    name: 'Stochastic RSI',
    warmup: 30,
    run(bars, params = {}) {
      const tp = params.tp || 1.5, sl = params.sl || 1.0;
      return backtestLoop(bars, (i, state) => {
        if (i < 28) return { entry: false, exitSignal: false };
        const rsi = rollingRSI(bars.closes, 14, i);
        const prevRsi = rollingRSI(bars.closes, 14, i - 1);
        if (rsi === null || prevRsi === null) return { entry: false, exitSignal: false };
        // Stochastic of RSI over 14 bars (simplified)
        let minRSI = rsi, maxRSI = rsi;
        for (let j = i - 13; j <= i; j++) {
          const r = rollingRSI(bars.closes, 14, j);
          if (r !== null) { minRSI = Math.min(minRSI, r); maxRSI = Math.max(maxRSI, r); }
        }
        const stochK = maxRSI !== minRSI ? ((rsi - minRSI) / (maxRSI - minRSI)) * 100 : 50;
        const entry = !state.inTrade && stochK < 20;
        const exitSignal = state.inTrade && stochK > 80;
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 10 });
    },
  },
  // ── All PDF strategies (unified — no category bias) ──
  bollinger_india_tuned: {
    name: 'Bollinger MR [India Tuned]',
    warmup: 25,
    run(bars, params = {}) {
      const tp = params.tp || 1.5, sl = params.sl || 2.5;
      return backtestLoop(bars, (i, state) => {
        if (i < 21) return { entry: false, exitSignal: false };
        const slice = bars.closes.slice(i - 19, i + 1);
        const mean = slice.reduce((a, b) => a + b, 0) / 20;
        const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
        const lower = mean - 2 * std;
        const entry = !state.inTrade && bars.closes[i] < lower;
        const exitSignal = state.inTrade && bars.closes[i] > mean;
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 10 });
    },
  },
  ema_crossover_india: {
    name: 'EMA Crossover [India]',
    warmup: 25,
    run(bars, params = {}) {
      const tp = params.tp || 2.0, sl = params.sl || 1.5;
      const emaF = emaSeries(bars.closes, 9);
      const emaS = emaSeries(bars.closes, 21);
      return backtestLoop(bars, (i, state) => {
        if (i < 22) return { entry: false, exitSignal: false };
        const cross = emaF[i] > emaS[i] && emaF[i - 1] <= emaS[i - 1];
        const deathCross = emaF[i] < emaS[i] && emaF[i - 1] >= emaS[i - 1];
        return { entry: !state.inTrade && cross, exitSignal: state.inTrade && deathCross };
      }, { tp, sl, maxBars: 30 });
    },
  },
  macd_strategy_india: {
    name: 'MACD Crossover [India]',
    warmup: 30,
    run(bars, params = {}) {
      const tp = params.tp || 2.0, sl = params.sl || 1.5;
      const emaF = emaSeries(bars.closes, 12);
      const emaS = emaSeries(bars.closes, 26);
      const macd = emaF.map((v, i) => v - emaS[i]);
      const signal = emaSeries(macd, 9);
      return backtestLoop(bars, (i, state) => {
        if (i < 35) return { entry: false, exitSignal: false };
        const bullCross = macd[i] > signal[i] && macd[i - 1] <= signal[i - 1];
        const bearCross = macd[i] < signal[i] && macd[i - 1] >= signal[i - 1];
        return { entry: !state.inTrade && bullCross, exitSignal: state.inTrade && bearCross };
      }, { tp, sl, maxBars: 30 });
    },
  },
  rsi_vwap_india: {
    name: 'RSI + VWAP [India]',
    warmup: 25,
    run(bars, params = {}) {
      const tp = params.tp || 1.5, sl = params.sl || 2.0;
      return backtestLoop(bars, (i, state) => {
        if (i < 21) return { entry: false, exitSignal: false };
        const rsi = rollingRSI(bars.closes, 14, i);
        let sumPV = 0, sumV = 0;
        for (let j = i - 19; j <= i; j++) { sumPV += bars.closes[j] * bars.volumes[j]; sumV += bars.volumes[j]; }
        const vwap = sumV > 0 ? sumPV / sumV : bars.closes[i];
        const entry = !state.inTrade && rsi !== null && rsi < 30 && bars.closes[i] > vwap;
        const exitSignal = state.inTrade && (rsi > 70 || bars.closes[i] < vwap * 0.98);
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 12 });
    },
  },
  supertrend_india: {
    name: 'Supertrend [India]',
    warmup: 15,
    run(bars, params = {}) {
      const tp = params.tp || 3.0, sl = params.sl || 2.0;
      const period = 10, mult = 2.0;
      const atrArr = [];
      for (let i = 0; i < bars.closes.length; i++) {
        if (i < period) { atrArr.push(0); continue; }
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) {
          sum += Math.max(bars.highs[j] - bars.lows[j], Math.abs(bars.highs[j] - bars.closes[j - 1]), Math.abs(bars.lows[j] - bars.closes[j - 1]));
        }
        atrArr.push(sum / period);
      }
      const dir = new Array(bars.closes.length).fill(1);
      const upperBand = [], lowerBand = [];
      for (let i = 0; i < bars.closes.length; i++) {
        const hl2 = (bars.highs[i] + bars.lows[i]) / 2;
        upperBand.push(hl2 + mult * atrArr[i]);
        lowerBand.push(hl2 - mult * atrArr[i]);
      }
      for (let i = 1; i < bars.closes.length; i++) {
        if (bars.closes[i] > upperBand[i - 1]) dir[i] = 1;
        else if (bars.closes[i] < lowerBand[i - 1]) dir[i] = -1;
        else dir[i] = dir[i - 1];
      }
      return backtestLoop(bars, (i, state) => {
        if (i < period + 1) return { entry: false, exitSignal: false };
        const bullFlip = dir[i] === 1 && dir[i - 1] === -1;
        const bearFlip = dir[i] === -1 && dir[i - 1] === 1;
        return { entry: !state.inTrade && bullFlip, exitSignal: state.inTrade && bearFlip };
      }, { tp, sl, maxBars: 40 });
    },
  },
  fibonacci_strategy_india: {
    name: 'Fibonacci Retracement [India]',
    warmup: 55,
    run(bars, params = {}) {
      const tp = params.tp || 3.0, sl = params.sl || 1.5;
      const lookback = 50;
      return backtestLoop(bars, (i, state) => {
        if (i < lookback) return { entry: false, exitSignal: false };
        let hh = -Infinity, ll = Infinity;
        for (let j = i - lookback; j <= i; j++) {
          if (bars.highs[j] > hh) hh = bars.highs[j];
          if (bars.lows[j] < ll) ll = bars.lows[j];
        }
        const range = hh - ll;
        if (range === 0) return { entry: false, exitSignal: false };
        const fib618 = hh - range * 0.618;
        const fib50 = hh - range * 0.5;
        const bullishCandle = bars.closes[i] > bars.opens[i];
        const atFib = bars.lows[i] <= fib618 * 1.005 && bars.closes[i] > fib618;
        const atFib50 = bars.lows[i] <= fib50 * 1.005 && bars.closes[i] > fib50;
        const entry = !state.inTrade && bullishCandle && (atFib || atFib50);
        const fib236 = hh - range * 0.236;
        const exitSignal = state.inTrade && bars.closes[i] > fib236;
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 30 });
    },
  },
  ibs_india_tuned: {
    name: 'IBS Mean Reversion [India v2 — Swing]',
    warmup: 200,
    run(bars, params = {}) {
      const tp = params.tp || 2.5, sl = params.sl || 1.5, maxBars = params.maxBars || 3;
      const ibsEntry = params.ibsEntry || 0.35;
      const ibsExit = params.ibsExit || 0.65;
      const volMult = params.volMult || 1.0;
      const trendLen = params.trendLen || 200;
      const gapThresh = params.gapThresh || 2.0;
      const minTurnover = params.minTurnover || 2e7;
      const minAtrPct = params.minAtrPct || 1.5;
      const maxAtrPct = params.maxAtrPct || 5.0;
      const minPrice = params.minPrice || 100;
      const useTrend = params.useTrend !== false;
      const useGap = params.useGap !== false;
      const useLiquidity = params.useLiquidity !== false;
      const useVolatility = params.useVolatility !== false;
      const useMinPrice = params.useMinPrice !== false;

      // Pre-compute ATR(14) series
      const atrLen = 14;
      const trArr = new Array(bars.closes.length).fill(0);
      for (let i = 1; i < bars.closes.length; i++) {
        const tr = Math.max(
          bars.highs[i] - bars.lows[i],
          Math.abs(bars.highs[i] - bars.closes[i - 1]),
          Math.abs(bars.lows[i] - bars.closes[i - 1])
        );
        trArr[i] = tr;
      }
      const atrArr = new Array(bars.closes.length).fill(0);
      for (let i = atrLen; i < bars.closes.length; i++) {
        let sum = 0;
        for (let k = i - atrLen + 1; k <= i; k++) sum += trArr[k];
        atrArr[i] = sum / atrLen;
      }

      return backtestLoop(bars, (i, state) => {
        if (i < trendLen) return { entry: false, exitSignal: false };

        const prevH = bars.highs[i - 1], prevL = bars.lows[i - 1], prevC = bars.closes[i - 1];
        const ibsPrev = prevH !== prevL ? (prevC - prevL) / (prevH - prevL) : 0.5;
        const curH = bars.highs[i], curL = bars.lows[i], curC = bars.closes[i];
        const ibsCur = curH !== curL ? (curC - curL) / (curH - curL) : 0.5;

        // Volume confirmation
        const volSMA = sma(bars.volumes, 20, i - 1);
        const volOK = volSMA > 0 && bars.volumes[i - 1] > volSMA * volMult;

        // Trend filter
        const trendSMA = sma(bars.closes, trendLen, i - 1);
        const trendOK = !useTrend || (trendSMA > 0 && bars.closes[i - 1] > trendSMA);

        // Volatility filter — ATR must be in tradeable range
        const atrPctPrev = atrArr[i - 1] > 0 && bars.closes[i - 1] > 0
          ? (atrArr[i - 1] / bars.closes[i - 1]) * 100 : 0;
        const volatilityOK = !useVolatility || (atrPctPrev >= minAtrPct && atrPctPrev <= maxAtrPct);

        // Min price filter
        const priceOK = !useMinPrice || bars.closes[i - 1] >= minPrice;

        // Gap-down filter
        const openPrice = (bars.opens && bars.opens[i]) || bars.closes[i];
        const gapOK = !useGap || openPrice >= bars.closes[i - 1] * (1 - gapThresh / 100);

        // Liquidity filter
        let liquidityOK = true;
        if (useLiquidity) {
          let turnoverSum = 0, count = 0;
          for (let k = Math.max(0, i - 20); k < i; k++) {
            turnoverSum += bars.volumes[k] * bars.closes[k];
            count++;
          }
          const turnoverSMA = count > 0 ? turnoverSum / count : 0;
          liquidityOK = turnoverSMA >= minTurnover;
        }

        const entry = !state.inTrade
                    && ibsPrev < ibsEntry
                    && volOK
                    && trendOK
                    && volatilityOK
                    && priceOK
                    && gapOK
                    && liquidityOK;

        const exitSignal = state.inTrade && ibsCur > ibsExit;

        return { entry, exitSignal };
      }, { tp, sl, maxBars });
    },
  },
  ibs_india_tuned_intraday: {
    name: 'IBS Mean Reversion [India — Intraday]',
    warmup: 25,
    run(bars, params = {}) {
      const tp = params.tp || 0.7, sl = params.sl || 0.5, maxBars = params.maxBars || 12;
      const ibsEntry = params.ibsEntry || 0.25;
      const ibsExit = params.ibsExit || 0.75;
      const volMult = params.volMult || 1.5;
      const minAtrPct = params.minAtrPct || 0.15;
      const useVolatility = params.useVolatility !== false;

      return backtestLoop(bars, (i, state) => {
        if (i < 25) return { entry: false, exitSignal: false };

        const prevH = bars.highs[i - 1], prevL = bars.lows[i - 1], prevC = bars.closes[i - 1];
        const ibsPrev = prevH !== prevL ? (prevC - prevL) / (prevH - prevL) : 0.5;
        const curH = bars.highs[i], curL = bars.lows[i], curC = bars.closes[i];
        const ibsCur = curH !== curL ? (curC - curL) / (curH - curL) : 0.5;

        // Volume confirmation (stricter for intraday)
        const volSMA = sma(bars.volumes, 20, i - 1);
        const volOK = volSMA > 0 && bars.volumes[i - 1] > volSMA * volMult;

        // VWAP filter — proxy: rolling mean of typical price
        // (true intraday VWAP requires session-aware reset, this is a rolling approximation)
        let vwapOK = true;
        const vwapLen = 20;
        if (i >= vwapLen) {
          let pvSum = 0, vSum = 0;
          for (let k = i - vwapLen + 1; k <= i; k++) {
            const tp_price = (bars.highs[k] + bars.lows[k] + bars.closes[k]) / 3;
            pvSum += tp_price * bars.volumes[k];
            vSum += bars.volumes[k];
          }
          const vwap = vSum > 0 ? pvSum / vSum : bars.closes[i];
          vwapOK = bars.closes[i] > vwap;
        }

        // Volatility (intraday ATR % — much smaller threshold)
        let volatilityOK = true;
        if (useVolatility && i >= 14) {
          let trSum = 0;
          for (let k = i - 13; k <= i; k++) {
            const tr = Math.max(
              bars.highs[k] - bars.lows[k],
              Math.abs(bars.highs[k] - bars.closes[k - 1] || 0),
              Math.abs(bars.lows[k] - bars.closes[k - 1] || 0)
            );
            trSum += tr;
          }
          const atr = trSum / 14;
          const atrPct = bars.closes[i] > 0 ? (atr / bars.closes[i]) * 100 : 0;
          volatilityOK = atrPct >= minAtrPct;
        }

        const entry = !state.inTrade
                    && ibsPrev < ibsEntry
                    && volOK
                    && vwapOK
                    && volatilityOK;

        const exitSignal = state.inTrade && ibsCur > ibsExit;

        return { entry, exitSignal };
      }, { tp, sl, maxBars });
    },
  },
  rsi2_mean_reversion_from_pdf: {
    name: 'RSI(2) MR [PDF Original]',
    warmup: 20,
    run(bars, params = {}) {
      const tp = params.tp || 1.5, sl = params.sl || 1.0, maxBars = params.maxBars || 5;
      return backtestLoop(bars, (i, state) => {
        const rsi = rollingRSI(bars.closes, 2, i);
        const volSMA = sma(bars.volumes, 20, i);
        const volOK = volSMA > 0 && bars.volumes[i] > volSMA;
        const entry = !state.inTrade && rsi !== null && rsi < 30 && volOK;
        const exitSignal = state.inTrade && rsi !== null && rsi > 50;
        return { entry, exitSignal };
      }, { tp, sl, maxBars });
    },
  },
  bollinger_bands_mean_reversion: {
    name: 'Bollinger Bands Mean Reversion',
    warmup: 25,
    run(bars, params = {}) {
      const tp = params.tp || 1.5, sl = params.sl || 2.0;
      return backtestLoop(bars, (i, state) => {
        if (i < 21) return { entry: false, exitSignal: false };
        const slice = bars.closes.slice(i - 19, i + 1);
        const mean = slice.reduce((a, b) => a + b, 0) / 20;
        const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
        const lower = mean - 2 * std;
        const entry = !state.inTrade && bars.closes[i] < lower;
        const exitSignal = state.inTrade && bars.closes[i] > mean;
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 10 });
    },
  },
  ibs_mean_reversion: {
    name: 'IBS Strict (0.20 threshold)',
    warmup: 25,
    run(bars, params = {}) {
      const tp = params.tp || 0.7, sl = params.sl || 1.5;
      return backtestLoop(bars, (i, state) => {
        if (i < 21) return { entry: false, exitSignal: false };
        const prevH = bars.highs[i - 1], prevL = bars.lows[i - 1], prevC = bars.closes[i - 1];
        const ibs = prevH !== prevL ? (prevC - prevL) / (prevH - prevL) : 0.5;
        const volSMA = sma(bars.volumes, 20, i - 1);
        const volOK = volSMA > 0 && bars.volumes[i - 1] > volSMA;
        const entry = !state.inTrade && ibs < 0.20 && volOK;
        const exitSignal = state.inTrade && bars.closes[i] > bars.closes[i - 1];
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 3 });
    },
  },
  gap_and_go: {
    name: 'Gap & Go (Gap Fill)',
    warmup: 25,
    run(bars, params = {}) {
      const tp = params.tp || 0.5, sl = params.sl || 1.0;
      return backtestLoop(bars, (i, state) => {
        if (i < 6) return { entry: false, exitSignal: false };
        const gap = (bars.opens[i] - bars.closes[i - 1]) / bars.closes[i - 1] * 100;
        const prevH = bars.highs[i - 1], prevL = bars.lows[i - 1], prevC = bars.closes[i - 1];
        const ibs = prevH !== prevL ? (prevC - prevL) / (prevH - prevL) : 0.5;
        const rsi = rollingRSI(bars.closes, 5, i - 1);
        const entry = !state.inTrade && gap < -0.15 && ibs < 0.25 && rsi !== null && rsi < 45;
        const exitSignal = state.inTrade && bars.closes[i] > bars.closes[i - 1];
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 3 });
    },
  },
  monday_reversal: {
    name: 'Monday Reversal',
    warmup: 25,
    run(bars, params = {}) {
      const tp = params.tp || 1.5, sl = params.sl || 1.5;
      return backtestLoop(bars, (i, state) => {
        if (i < 21) return { entry: false, exitSignal: false };
        const gap = (bars.opens[i] - bars.closes[i - 1]) / bars.closes[i - 1] * 100;
        const rsi = rollingRSI(bars.closes, 5, i);
        const volSMA = sma(bars.volumes, 20, i);
        const volOK = volSMA > 0 && bars.volumes[i] > volSMA;
        const entry = !state.inTrade && gap < -0.1 && rsi !== null && rsi < 40 && volOK;
        const exitSignal = state.inTrade && bars.closes[i] > bars.closes[i - 1];
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 5 });
    },
  },
  overnight_swing: {
    name: 'Overnight Swing (Strong Close)',
    warmup: 55,
    run(bars, params = {}) {
      const tp = params.tp || 0.8, sl = params.sl || 1.0;
      return backtestLoop(bars, (i, state) => {
        if (i < 50) return { entry: false, exitSignal: false };
        const range = bars.highs[i] - bars.lows[i];
        if (range === 0) return { entry: false, exitSignal: false };
        const closePosition = (bars.closes[i] - bars.lows[i]) / range;
        const sma50 = sma(bars.closes, 50, i);
        const volSMA = sma(bars.volumes, 20, i);
        const volOK = volSMA > 0 && bars.volumes[i] > volSMA;
        const entry = !state.inTrade && closePosition > 0.9 && bars.closes[i] > sma50 && volOK;
        const exitSignal = state.inTrade;
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 2 });
    },
  },
  trend_following_200sma: {
    name: 'Trend Following 200-SMA',
    warmup: 205,
    run(bars, params = {}) {
      const tp = params.tp || 5.0, sl = params.sl || 3.0;
      return backtestLoop(bars, (i, state) => {
        if (i < 200) return { entry: false, exitSignal: false };
        const sma200 = sma(bars.closes, 200, i);
        const sma50Val = sma(bars.closes, 50, i);
        const prevSma200 = sma(bars.closes, 200, i - 1);
        const volSMA = sma(bars.volumes, 20, i);
        const volOK = volSMA > 0 && bars.volumes[i] > volSMA * 1.5;
        const crossAbove = bars.closes[i] > sma200 && bars.closes[i - 1] <= prevSma200;
        const entry = !state.inTrade && crossAbove && bars.closes[i] > sma50Val && volOK;
        const exitSignal = state.inTrade && bars.closes[i] < sma200;
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 100 });
    },
  },
  fibonacci_only_strategy: {
    name: 'Fibonacci-Only Strategy',
    warmup: 55,
    run(bars, params = {}) {
      const tp = params.tp || 3.0, sl = params.sl || 1.5;
      const lookback = 50;
      return backtestLoop(bars, (i, state) => {
        if (i < lookback) return { entry: false, exitSignal: false };
        let hh = -Infinity, ll = Infinity;
        for (let j = i - lookback; j <= i; j++) {
          if (bars.highs[j] > hh) hh = bars.highs[j];
          if (bars.lows[j] < ll) ll = bars.lows[j];
        }
        const range = hh - ll;
        if (range === 0) return { entry: false, exitSignal: false };
        const fib19 = hh - range * 0.19;
        const fib82 = hh - range * 0.8256;
        const fib618 = hh - range * 0.618;
        const bullish = bars.closes[i] > bars.opens[i];
        const atLevel = (bars.lows[i] <= fib618 * 1.005 && bars.closes[i] > fib618) ||
                        (bars.lows[i] <= fib82 * 1.005 && bars.closes[i] > fib82);
        const entry = !state.inTrade && bullish && atLevel;
        const exitSignal = state.inTrade && bars.closes[i] > fib19;
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 30 });
    },
  },
  grid_dca_strategy: {
    name: 'Grid DCA Strategy',
    warmup: 25,
    run(bars, params = {}) {
      const tp = params.tp || 2.0, sl = params.sl || 5.0;
      return backtestLoop(bars, (i, state) => {
        if (i < 21) return { entry: false, exitSignal: false };
        let recentHigh = -Infinity;
        for (let j = i - 19; j <= i; j++) { if (bars.highs[j] > recentHigh) recentHigh = bars.highs[j]; }
        const drawdown = (bars.closes[i] - recentHigh) / recentHigh * 100;
        let recentLow = Infinity;
        for (let j = i - 10; j < i; j++) { if (bars.lows[j] < recentLow) recentLow = bars.lows[j]; }
        const doubleBottom = Math.abs(bars.lows[i] - recentLow) / recentLow < 0.005;
        const entry = !state.inTrade && drawdown < -2 && doubleBottom;
        const exitSignal = state.inTrade && bars.closes[i] > recentHigh * 0.98;
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 30 });
    },
  },
  adaptive_mtf_trend_fusion: {
    name: 'Adaptive MTF Trend Fusion',
    warmup: 55,
    run(bars, params = {}) {
      const tp = params.tp || 3.0, sl = params.sl || 2.0;
      const ema9 = emaSeries(bars.closes, 9);
      const ema21 = emaSeries(bars.closes, 21);
      const ema50 = emaSeries(bars.closes, 50);
      return backtestLoop(bars, (i, state) => {
        if (i < 50) return { entry: false, exitSignal: false };
        const allBullish = ema9[i] > ema21[i] && ema21[i] > ema50[i] && bars.closes[i] > ema9[i];
        const prevNotAligned = !(ema9[i - 1] > ema21[i - 1] && ema21[i - 1] > ema50[i - 1]);
        const entry = !state.inTrade && allBullish && prevNotAligned;
        const exitSignal = state.inTrade && bars.closes[i] < ema21[i];
        return { entry, exitSignal };
      }, { tp, sl, maxBars: 50 });
    },
  },
};

// ── Backtest Helpers ──

function rollingRSI(closes, period, endIdx) {
  if (endIdx < period) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function sma(values, period, endIdx) {
  if (endIdx < period - 1) return 0;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) sum += values[i];
  return sum / period;
}

function emaSeries(closes, period) {
  const result = new Array(closes.length).fill(0);
  let ema = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      ema += closes[i] / period;
      result[i] = i === period - 1 ? ema : 0;
    } else {
      ema = closes[i] * (2 / (period + 1)) + ema * (1 - 2 / (period + 1));
      result[i] = ema;
    }
  }
  return result;
}

// Core backtest loop — walks through bars, manages position lifecycle.
// Quant-grade: next-bar-open entry, transaction costs, slippage, regime tagging, IS/OOS split.
function backtestLoop(bars, logic, { tp, sl, maxBars }) {
  // ── Capital & Position Sizing ──
  const INITIAL_CAPITAL = 100000; // ₹1,00,000
  const POSITION_SIZE_PCT = 100;  // Full capital per trade (matches Pine default_qty_value=100)

  // Realistic execution params
  const TXN_COST_BPS = 10; // 5 bps each side = 10 bps round-trip (~0.1%)
  const SLIPPAGE_BPS = 5;  // Adverse fill assumption
  const COST_PCT = (TXN_COST_BPS + SLIPPAGE_BPS) / 100; // total drag in % per round-trip

  const trades = [];
  const equity = [0]; // cumulative P&L %
  let state = { inTrade: false, entryPrice: 0, entryIdx: 0, signaledAt: -1 };
  let cumPnl = 0;
  let maxEquity = 0, maxDrawdown = 0;
  let currentSignal = null;
  let capitalEquity = INITIAL_CAPITAL; // absolute ₹ equity (compounds)

  // Lightweight regime tag per bar (for regime-conditional analysis)
  const regimeAtBar = new Array(bars.closes.length).fill('unknown');
  for (let i = 50; i < bars.closes.length; i++) {
    const slice = bars.closes.slice(Math.max(0, i - 49), i + 1);
    const sliceH = bars.highs.slice(Math.max(0, i - 49), i + 1);
    const sliceL = bars.lows.slice(Math.max(0, i - 49), i + 1);
    const adxVal = Quant.adx(sliceH, sliceL, slice, 14);
    const ema9_i = emaSeries(slice, 9);
    const ema21_i = emaSeries(slice, 21);
    const last = slice.length - 1;
    const trendUp = ema9_i[last] && ema21_i[last] && ema9_i[last] > ema21_i[last];
    const trendDown = ema9_i[last] && ema21_i[last] && ema9_i[last] < ema21_i[last];
    if (adxVal && adxVal > 25 && trendUp) regimeAtBar[i] = 'trending_up';
    else if (adxVal && adxVal > 25 && trendDown) regimeAtBar[i] = 'trending_down';
    else if (adxVal && adxVal < 18) regimeAtBar[i] = 'ranging';
    else regimeAtBar[i] = 'mixed';
  }

  // IS/OOS split: train on first 70%, test on last 30%
  const totalBars = bars.closes.length;
  const oosStartIdx = Math.floor(totalBars * 0.7);

  const startIdx = 30;
  for (let i = startIdx; i < totalBars; i++) {
    const { entry, exitSignal } = logic(i, state);

    if (state.inTrade) {
      const barsHeld = i - state.entryIdx;
      const price = bars.closes[i];
      // Gross P&L
      const grossPnl = ((price - state.entryPrice) / state.entryPrice) * 100;
      // Net P&L (subtract transaction costs once at exit; entry cost included in entry price assumption)
      const netPnl = grossPnl - COST_PCT;

      let exitReason = null;
      let exitPrice = price;
      if (grossPnl >= tp) { exitReason = 'TP'; exitPrice = state.entryPrice * (1 + tp / 100); }
      else if (grossPnl <= -sl) { exitReason = 'SL'; exitPrice = state.entryPrice * (1 - sl / 100); }
      else if (barsHeld >= maxBars) exitReason = 'MAX_BARS';
      else if (exitSignal) exitReason = 'SIGNAL';

      if (exitReason) {
        const finalGross = ((exitPrice - state.entryPrice) / state.entryPrice) * 100;
        const finalNet = finalGross - COST_PCT;
        cumPnl += finalNet;
        // Absolute ₹ P&L: position = 5% of current equity
        const positionValue = capitalEquity * (POSITION_SIZE_PCT / 100);
        const absProfit = positionValue * (finalNet / 100);
        capitalEquity += absProfit;
        trades.push({
          entryIdx: state.entryIdx,
          exitIdx: i,
          entryPrice: state.entryPrice,
          exitPrice,
          pnl: parseFloat(finalNet.toFixed(3)),
          grossPnl: parseFloat(finalGross.toFixed(3)),
          absProfit: Math.round(absProfit),  // ₹ profit/loss this trade
          barsHeld,
          exitReason,
          regime: regimeAtBar[state.entryIdx] || 'unknown',
          isOOS: state.entryIdx >= oosStartIdx, // out-of-sample flag
        });
        state = { inTrade: false, entryPrice: 0, entryIdx: 0, signaledAt: -1 };
      }
    } else if (entry && state.signaledAt !== i) {
      // Signal fires NOW — enter on NEXT bar's OPEN to avoid lookahead
      state.signaledAt = i;
    } else if (state.signaledAt === i - 1 && i < totalBars) {
      // Execute entry at next bar's open with slippage
      const openPrice = bars.opens[i] || bars.closes[i];
      const slippageAdj = openPrice * (SLIPPAGE_BPS / 10000); // adverse slippage
      state = { inTrade: true, entryPrice: openPrice + slippageAdj, entryIdx: i, signaledAt: -1 };
    }

    equity.push(parseFloat(cumPnl.toFixed(3)));
    maxEquity = Math.max(maxEquity, cumPnl);
    const dd = maxEquity - cumPnl;
    maxDrawdown = Math.max(maxDrawdown, dd);

    if (i === totalBars - 1) {
      if (state.inTrade) {
        const grossPnl = ((bars.closes[i] - state.entryPrice) / state.entryPrice) * 100;
        const netPnl = grossPnl - COST_PCT;
        currentSignal = { type: 'IN_TRADE', entryPrice: state.entryPrice, unrealizedPnl: parseFloat(netPnl.toFixed(2)), barsHeld: i - state.entryIdx };
      } else if (state.signaledAt === i) {
        currentSignal = { type: 'BUY', price: bars.closes[i], reason: 'Entry on next bar open' };
      } else {
        const { entry: wouldEntry } = logic(i, { inTrade: false, entryPrice: 0, entryIdx: 0, signaledAt: -1 });
        currentSignal = { type: wouldEntry ? 'BUY' : 'WAIT', price: bars.closes[i] };
      }
    }
  }

  // ── Stats ──
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : wins.length > 0 ? 99 : 0;
  const avgBarsHeld = trades.length > 0 ? trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length : 0;
  const expectancy = trades.length > 0 ? totalPnl / trades.length : 0;

  // Trade returns array for stat calcs
  const tradeReturns = trades.map(t => t.pnl);

  // Sharpe (per-trade; not annualized)
  const stats = Quant.stats(tradeReturns);
  const sharpe = stats.std > 0 ? stats.mean / stats.std : 0;

  // ── Quant-grade metrics ──
  const wilsonWR = trades.length > 0 ? Quant.wilsonLower(wins.length, trades.length) : 0;
  const psr = Quant.probabilisticSharpe(tradeReturns, 0);
  const sortino = Quant.sortino(tradeReturns, 0);
  const calmar = Quant.calmar(totalPnl, maxDrawdown);
  const ulcer = Quant.ulcerIndex(equity);
  const bootstrap = Quant.bootstrapMean(tradeReturns, 500, 0.95);

  // OOS-only metrics
  const oosTrades = trades.filter(t => t.isOOS);
  const oosWins = oosTrades.filter(t => t.pnl > 0);
  const oosTotalPnl = oosTrades.reduce((s, t) => s + t.pnl, 0);
  const oosWR = oosTrades.length > 0 ? Math.round((oosWins.length / oosTrades.length) * 100) : 0;
  const oosWilson = oosTrades.length > 0 ? Quant.wilsonLower(oosWins.length, oosTrades.length) : 0;

  // Regime-conditional performance (for the most-frequent regime in trades)
  const regimeStats = {};
  for (const t of trades) {
    if (!regimeStats[t.regime]) regimeStats[t.regime] = { count: 0, wins: 0, pnl: 0 };
    regimeStats[t.regime].count++;
    if (t.pnl > 0) regimeStats[t.regime].wins++;
    regimeStats[t.regime].pnl += t.pnl;
  }
  for (const r of Object.keys(regimeStats)) {
    const rs = regimeStats[r];
    rs.winRate = rs.count > 0 ? Math.round((rs.wins / rs.count) * 100) : 0;
    rs.avgPnl = rs.count > 0 ? parseFloat((rs.pnl / rs.count).toFixed(2)) : 0;
    rs.totalPnl = parseFloat(rs.pnl.toFixed(2));
  }

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? Math.round((wins.length / trades.length) * 100) : 0,
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
    expectancy: parseFloat(expectancy.toFixed(2)),
    sharpe: parseFloat(sharpe.toFixed(2)),
    avgBarsHeld: Math.round(avgBarsHeld),
    equity: equity.length > 50 ? equity.filter((_, i) => i % Math.ceil(equity.length / 50) === 0 || i === equity.length - 1) : equity,
    trades: trades.slice(-10),
    currentSignal,
    barsAnalyzed: totalBars - 30,

    // ── Capital-based metrics (₹1,00,000 @ 100% per trade) ──
    capital: {
      initial: INITIAL_CAPITAL,
      final: Math.round(capitalEquity),
      netProfit: Math.round(capitalEquity - INITIAL_CAPITAL),
      returnPct: parseFloat(((capitalEquity - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100).toFixed(2)),
      positionSizePct: POSITION_SIZE_PCT,
      maxPositionValue: Math.round(INITIAL_CAPITAL * POSITION_SIZE_PCT / 100),
      maxDrawdownRs: Math.round(maxDrawdown * POSITION_SIZE_PCT / 100 * INITIAL_CAPITAL / 100),
    },

    // ── Quant metrics (Jane Street-grade) ──
    wilsonWR: parseFloat((wilsonWR * 100).toFixed(1)),       // 95% lower bound on win rate
    psr: parseFloat((psr * 100).toFixed(1)),                  // P(true Sharpe > 0) %
    sortino: parseFloat(sortino.toFixed(2)),                  // Downside risk-adjusted
    calmar: parseFloat(calmar.toFixed(2)),                    // Return / DD
    ulcer: parseFloat(ulcer.toFixed(2)),                      // Drawdown depth+duration
    bootstrap95: { lower: parseFloat(bootstrap.lower.toFixed(2)), upper: parseFloat(bootstrap.upper.toFixed(2)) },
    skew: parseFloat(stats.skew.toFixed(2)),
    kurtosis: parseFloat(stats.kurt.toFixed(2)),

    // OOS validation
    oos: {
      trades: oosTrades.length,
      winRate: oosWR,
      wilsonWR: parseFloat((oosWilson * 100).toFixed(1)),
      totalPnl: parseFloat(oosTotalPnl.toFixed(2)),
    },

    // Regime-conditional
    regimePerformance: regimeStats,
  };
}

// Run backtest for a given strategy on market data
function runBacktest(strategyId, data, params = {}) {
  const logic = BACKTEST_LOGIC[strategyId];
  if (!logic) return null;

  const bars = {
    closes: data.closes || [],
    opens: data.opens || [],
    highs: data.highs || [],
    lows: data.lows || [],
    volumes: data.volumes || [],
  };

  if (bars.closes.length < 50) return null;

  // Auto-tune params from market analysis
  if (!params.tp && data.analysis) {
    const atrPct = parseFloat(data.analysis?.indicators?.atrPct) || 1.5;
    params.tp = Math.max(1.0, atrPct * 1.5);
    params.sl = Math.max(0.5, atrPct);
  }

  const result = logic.run(bars, params);
  return {
    strategy: strategyId,
    name: logic.name,
    symbol: data.symbol,
    timeframe: data.timeframe,
    ...result,
  };
}

// ── Data Fetcher ──

async function fetchMarketData() {
  return evaluate(`
    (function() {
      try {
        var chart = ${CHART_API};
        var m = ${MODEL};
        var bars = m.mainSeries().bars();
        var last = bars.lastIndex();
        var times = [], closes = [], highs = [], lows = [], volumes = [], opens = [];
        // Fetch 250 bars for proper percentile/regime/swing analysis
        for (var i = Math.max(0, last - 249); i <= last; i++) {
          var v = bars.valueAt(i);
          if (v) { times.push(v[0]); opens.push(v[1]); highs.push(v[2]); lows.push(v[3]); closes.push(v[4]); volumes.push(v[5]||0); }
        }
        var lastBar = bars.valueAt(last);
        var prevBar = bars.valueAt(last - 1);
        var change = lastBar && prevBar ? lastBar[4] - prevBar[4] : 0;
        var changePct = prevBar && prevBar[4] ? (change / prevBar[4] * 100).toFixed(2) : '0';
        return {
          symbol: chart.symbol(),
          timeframe: chart.resolution(),
          close: closes[closes.length-1],
          open: opens[opens.length-1],
          high: highs[highs.length-1],
          low: lows[lows.length-1],
          volume: volumes[volumes.length-1],
          change: change,
          changePercent: parseFloat(changePct),
          times: times,
          closes: closes,
          opens: opens,
          highs: highs,
          lows: lows,
          volumes: volumes
        };
      } catch(e) { return { error: e.message }; }
    })()
  `);
}

async function switchSymbol(symbol) {
  try {
    await execFileAsync('node', ['src/cli/index.js', 'symbol', symbol], { cwd: process.cwd() });
    return true;
  } catch (e) {
    return false;
  }
}

// Fetch market data at a specific timeframe. If TF differs from current,
// temporarily switches the chart, fetches data, then restores the original TF.
async function fetchMarketDataAtTimeframe(targetTf) {
  if (!targetTf) return await fetchMarketData();

  // Get current chart timeframe
  const currentTf = await evaluate(`(function(){try{return ${CHART_API}.resolution();}catch(e){return null;}})()`);
  if (currentTf === targetTf) return await fetchMarketData();

  // Switch to target TF, wait for bars to load, fetch, then restore
  try {
    await chartSetTimeframe({ timeframe: targetTf });
    await new Promise(r => setTimeout(r, 1500)); // let bars load
    const data = await fetchMarketData();
    // Restore original TF
    await chartSetTimeframe({ timeframe: currentTf });
    await new Promise(r => setTimeout(r, 600));
    return data;
  } catch (e) {
    // On failure, try to restore TF
    try { await chartSetTimeframe({ timeframe: currentTf }); } catch {}
    throw e;
  }
}

// ── Monitoring Loop ──

async function runMonitorTick() {
  try {
    const data = await fetchMarketData();
    if (!data || data.error) return;

    lastData = data;
    currentSymbol = data.symbol;

    for (const stratKey of activeStrategies) {
      // Legacy strategies with position tracking
      const strat = STRATEGIES[stratKey];
      if (strat) {
        const signal = strat.check(data.closes, data.volumes, data.close, data.highs, data.lows, data.times);
        if (signal) {
          const alert = {
            id: Date.now() + Math.random(),
            time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
            symbol: data.symbol,
            ...signal,
          };
          alerts.unshift(alert);
          if (alerts.length > 200) alerts.pop();

          if (signal.type === 'SELL' || signal.type === 'TP' || signal.type === 'SL') {
            tradeHistory.unshift(alert);
            if (tradeHistory.length > 100) tradeHistory.pop();
            debouncedSave('trades.json', () => tradeHistory);
          }

          debouncedSave('alerts.json', () => alerts);

          if (notificationsEnabled) {
            sendDesktopNotification(`${signal.type} — ${data.symbol}`, signal.msg);
          }
          if (settings.telegram?.enabled && settings.telegram?.scanAlerts) {
            getTelegram().sendScanAlert(alert).catch(() => {});
          }
          broadcastSSE({ type: 'alert', data: alert });
        }
        continue;
      }

      // Backtest-engine strategies (smart mode) — signal detection via backtest logic
      if (BACKTEST_LOGIC[stratKey]) {
        const analysis = analyzeMarketConditions(data);
        const bt = runBacktest(stratKey, { ...data, analysis }, {});
        if (bt && bt.currentSignal && bt.currentSignal.type !== 'WAIT') {
          const sig = bt.currentSignal;
          // Deduplicate: only alert if this is a new signal (not same type within last 5 alerts for this strat)
          const recentSame = alerts.slice(0, 10).find(a => a.strategy === (BACKTEST_LOGIC[stratKey].name || stratKey) && a.type === sig.type);
          if (!recentSame) {
            const alert = {
              id: Date.now() + Math.random(),
              time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
              symbol: data.symbol,
              type: sig.type,
              strategy: BACKTEST_LOGIC[stratKey].name || stratKey,
              msg: `[${BACKTEST_LOGIC[stratKey].name || stratKey}] ${sig.reason || sig.type} @ ₹${data.close}`,
            };
            alerts.unshift(alert);
            if (alerts.length > 200) alerts.pop();
            debouncedSave('alerts.json', () => alerts);

            if (notificationsEnabled) {
              sendDesktopNotification(`${sig.type} — ${data.symbol}`, alert.msg);
            }
            if (settings.telegram?.enabled && settings.telegram?.scanAlerts) {
              getTelegram().sendScanAlert(alert).catch(() => {});
            }
            broadcastSSE({ type: 'alert', data: alert });
          }
        }
      }
    }

    // Check price alerts
    checkPriceAlerts(data.close);

    // Broadcast status update
    const rsi = calcRSI(data.closes, 2);
    const ema20 = calcEMA(data.closes, 20);
    broadcastSSE({
      type: 'status',
      data: {
        symbol: data.symbol,
        price: data.close,
        open: data.open,
        high: data.high,
        low: data.low,
        volume: data.volume,
        change: data.change,
        changePercent: data.changePercent,
        rsi2: rsi?.toFixed(1) || 'N/A',
        ema20: ema20?.toFixed(2) || null,
        positions: Object.entries(positions).filter(([, v]) => v).map(([k, v]) => `${k}: ₹${v.entry_price}`),
        activeStrategies: activeStrategies,
        time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
      }
    });
  } catch (err) {
    // silent retry on connection errors
  }
}

function checkPriceAlerts(currentPrice) {
  if (!currentPrice) return;
  for (const alert of priceAlerts) {
    if (alert.triggered) continue;
    let shouldTrigger = false;
    if (alert.condition === 'above' && currentPrice >= alert.price) shouldTrigger = true;
    if (alert.condition === 'below' && currentPrice <= alert.price) shouldTrigger = true;
    if (alert.condition === 'cross' && Math.abs(currentPrice - alert.price) < alert.price * 0.001) shouldTrigger = true;

    if (shouldTrigger) {
      alert.triggered = true;
      alert.triggeredAt = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
      debouncedSave('price-alerts.json', () => priceAlerts);

      const alertMsg = `Price ${alert.condition} ₹${alert.price} triggered! ${alert.note || ''}`;

      // Desktop notification
      if (notificationsEnabled) {
        sendDesktopNotification('Price Alert Triggered', alertMsg);
      }
      if (settings.telegram?.enabled && settings.telegram?.priceAlerts) {
        getTelegram().sendPriceAlert({ ...alert, symbol: alert.symbol || currentSymbol }).catch(() => {});
      }

      broadcastSSE({
        type: 'alert',
        data: {
          id: Date.now(),
          type: 'PRICE_ALERT',
          strategy: 'Price Alert',
          symbol: alert.symbol || currentSymbol,
          time: alert.triggeredAt,
          msg: alertMsg
        }
      });
    }
  }
}

function startMonitoring(symbol, strategies, interval = 60000) {
  if (monitoring) stopMonitoring();
  activeStrategies = strategies;
  positions = {};
  monitoring = true;
  monitorInterval = setInterval(runMonitorTick, interval);
  runMonitorTick();
}

function stopMonitoring() {
  monitoring = false;
  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = null;
  positions = {};
}

// ── Multi-Symbol Background Scanner (Many-to-Many: Symbol ↔ Strategy) ──

let scannerSymbols = []; // Which symbols to scan (empty = none, ['ALL'] = full watchlist)
let scannerResults = {}; // Per-symbol results: { symbol: { strategy, signal, backtest, ... } }
let scannerStrategyOverrides = {}; // Per-symbol strategy override: { symbol: strategyId }
let scannerManagedByTipsSource = false;
let tipsSourceTimer = null;
let tipsSourceState = {
  lastRunAt: null,
  lastStatus: 'idle',
  lastError: null,
  lastSymbols: [],
  mergedSymbols: [],
  endpointStats: [],
  managedMatrix: false,
};

function nowUnixSec() {
  return Math.floor(Date.now() / 1000);
}

function isNseMarketOpenNow() {
  return isNseSessionBar(nowUnixSec());
}

function getIstNowParts() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const out = {};
  for (const p of parts) out[p.type] = p.value;
  return {
    weekday: out.weekday,
    hour: Number(out.hour || 0),
    minute: Number(out.minute || 0),
  };
}

function isNsePremarketNow() {
  const { weekday, hour, minute } = getIstNowParts();
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const mins = hour * 60 + minute;
  // Pre-market fetch window: 07:00 to 09:14 IST
  return mins >= 7 * 60 && mins < 9 * 60 + 15;
}

function normalizeScannerSymbol(sym) {
  if (!sym) return '';
  const s = String(sym).trim().toUpperCase();
  if (!s) return '';
  if (s.includes(':')) return s;
  return `NSE:${s}`;
}

function normalizeForCompare(sym) {
  const s = normalizeScannerSymbol(sym);
  return s.includes(':') ? s.split(':')[1] : s;
}

function hasWatchlistSymbol(sym) {
  const compare = normalizeForCompare(sym);
  return watchlist.some(w => normalizeForCompare(w.symbol) === compare);
}

function getTipsSourceUrls(cfg = {}) {
  const fallback = [
    'https://munafasutra.com/nse/intradayTradingTips/',
    'https://munafasutra.com/nse/BestIntradayTips',
  ];
  let urls = Array.isArray(cfg.urls) ? cfg.urls.map(v => String(v || '').trim()).filter(Boolean) : fallback;
  if (cfg.includeIntradayTradingTips === false) {
    urls = urls.filter(u => !/intradayTradingTips/i.test(u));
  }
  if (cfg.includeBestIntradayTips === false) {
    urls = urls.filter(u => !/BestIntradayTips/i.test(u));
  }
  if (urls.length === 0) urls = fallback;
  return urls;
}

function parseMunafaSymbolsFromHtml(html, maxSymbols = 500) {
  const symbolSet = new Set();
  const patterns = [
    /\/nse\/intradayTipsBTST\/([A-Z0-9_.&-]+)/g,
    /\/nse\/stock\/([A-Z0-9_.&-]+)/g,
    /[?&]symbol=([A-Z0-9_.&-]+)/gi,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const raw = (m[1] || '').toUpperCase();
      const cleaned = raw.replace(/[^A-Z0-9_.&-]/g, '');
      if (!cleaned) continue;
      symbolSet.add(`NSE:${cleaned}`);
      if (symbolSet.size >= maxSymbols) return Array.from(symbolSet);
    }
  }

  return Array.from(symbolSet);
}

async function fetchMunafaEndpointSymbols(url, maxSymbols = 500) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'tradingview-mcp/1.0 (+dashboard)',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!resp.ok) throw new Error(`Tips fetch failed (${resp.status})`);
  const html = await resp.text();
  return parseMunafaSymbolsFromHtml(html, maxSymbols);
}

async function fetchMunafaTipsSymbols() {
  const cfg = settings.tipsSource || {};
  const maxSymbols = Number(cfg.maxSymbols) || 500;
  const urls = getTipsSourceUrls(cfg);

  // Fetch ALL symbols from each endpoint (no per-URL cap)
  const perUrlResults = [];
  const endpointStats = [];

  for (const url of urls) {
    try {
      const symbols = await fetchMunafaEndpointSymbols(url, 60);
      perUrlResults.push(symbols);
      endpointStats.push({ url, success: true, fetched: symbols.length, accepted: 0 });
    } catch (e) {
      perUrlResults.push([]);
      endpointStats.push({ url, success: false, fetched: 0, accepted: 0, error: e.message });
    }
  }

  // Round-robin merge: alternate between sources for balanced contribution
  const merged = [];
  const seen = new Set();
  let done = false;
  while (!done && merged.length < maxSymbols) {
    done = true;
    for (let i = 0; i < perUrlResults.length; i++) {
      const arr = perUrlResults[i];
      const next = arr.shift();
      if (!next) continue;
      done = false;
      if (seen.has(next)) continue;
      seen.add(next);
      merged.push(next);
      endpointStats[i].accepted++;
      if (merged.length >= maxSymbols) break;
    }
  }

  return {
    symbols: merged,
    endpointStats,
  };
}

function syncTipsSymbolsIntoWatchlist(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return { added: 0, symbols: [] };

  let added = 0;
  for (const s of symbols) {
    const sym = normalizeScannerSymbol(s);
    if (!sym) continue;
    if (hasWatchlistSymbol(sym)) continue;
    watchlist.push({
      symbol: sym,
      price: null,
      change: null,
      signal: null,
      addedAt: Date.now(),
      source: 'munafasutra',
    });
    added++;
  }

  if (added > 0) {
    debouncedSave('watchlist.json', () => watchlist, 500);
    broadcastSSE({ type: 'watchlist_update', data: watchlist });
  }

  return { added, symbols: symbols.map(normalizeScannerSymbol).filter(Boolean) };
}

/**
 * Persist munafa scan to DB, run multibagger scoring, auto-add high scorers to watchlist.
 * @param {string[]} symbols — normalized munafa symbols
 * @param {Array} endpointStats — per-endpoint fetch details
 * @returns {Promise<{persisted: number, scored: number, autoAdded: string[]}>}
 */
async function persistAndScoreMunafaScan(symbols, endpointStats = []) {
  if (!isDbConfigured() || !symbols.length) return { persisted: 0, scored: 0, autoAdded: [] };

  try {
    // 1. Purge old scans (before today)
    const purged = await dbPurgeMunafaScans();
    if (purged > 0) console.log(`[munafa-db] Purged ${purged} old scan entries`);

    // 2. Insert today's scan results
    const scanItems = symbols.map(sym => {
      const ep = endpointStats.find(e => e.symbols?.includes(sym));
      return { symbol: sym, endpoint_url: ep?.url || null };
    });
    const persisted = await dbInsertMunafaScan(scanItems);
    console.log(`[munafa-db] Persisted ${persisted} scan results for today`);

    // 3. Run quick multibagger scoring on scan symbols
    let scored = 0;
    const autoAdded = [];
    try {
      const { screenUniverse } = await import('./src/engine/multibagger/index.js');
      const screenResult = await screenUniverse({ universe: symbols, topN: 0 });
      if (screenResult?.results?.length) {
        const scoreUpdates = screenResult.results
          .filter(r => r.multibaggerScore != null)
          .map(r => ({ symbol: r.snapshot?.symbol || r.symbol, score: r.multibaggerScore }));
        await dbUpdateMunafaScores(scoreUpdates);
        scored = scoreUpdates.length;

        // 4. Auto-add high scorers (score >= 60) to watchlist
        const MULTIBAGGER_THRESHOLD = 60;
        const highScorers = scoreUpdates.filter(s => s.score >= MULTIBAGGER_THRESHOLD);
        if (highScorers.length > 0) {
          const wlItems = highScorers.map(s => ({
            symbol: s.symbol,
            source: 'multibagger',
            price: null,
          }));
          await dbBulkAddToWatchlist(wlItems);
          // Update multibagger_score on watchlist rows
          for (const s of highScorers) {
            await dbAddToWatchlist(s.symbol, { source: 'multibagger', multibagger_score: s.score });
          }
          await dbMarkAutoWatchlisted(highScorers.map(s => s.symbol));
          autoAdded.push(...highScorers.map(s => s.symbol));
          console.log(`[munafa-db] Auto-watchlisted ${autoAdded.length} multibagger candidates (score >= ${MULTIBAGGER_THRESHOLD})`);
        }
      }
    } catch (e) {
      console.warn('[munafa-db] Multibagger scoring failed (non-fatal):', e.message);
    }

    return { persisted, scored, autoAdded };
  } catch (e) {
    console.warn('[munafa-db] Persist failed:', e.message);
    return { persisted: 0, scored: 0, autoAdded: [] };
  }
}

function getTipsMatrixStrategies(cfg = {}) {
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  const implemented = STRATEGY_CODES.filter(code =>
    fs.existsSync(path.join(__dir, 'src', 'engine', 'strategies', `${code}.js`))
  );
  let selected = [];
  if (cfg.matrixUseAllStrategies !== false) {
    selected = [...implemented];
  } else if (Array.isArray(cfg.matrixStrategies)) {
    selected = cfg.matrixStrategies.filter(code => implemented.includes(code));
  }
  if (!selected.length) selected = [...implemented];
  return selected.slice(0, 13);
}

async function runTipsSourceCycle(reason = 'scheduled') {
  const cfg = settings.tipsSource || {};
  const enabled = cfg.enabled === true;
  const onlyMarketHours = cfg.onlyMarketHours !== false;
  const includePremarket = cfg.includePremarket !== false;

  tipsSourceState.lastRunAt = new Date().toISOString();
  tipsSourceState.lastError = null;

  if (!enabled) {
    tipsSourceState.lastStatus = 'disabled';
    return { success: false, skipped: true, reason: 'disabled' };
  }
  if (onlyMarketHours && !isNseMarketOpenNow() && !(includePremarket && isNsePremarketNow())) {
    tipsSourceState.lastStatus = 'outside_market_hours';
    return { success: false, skipped: true, reason: 'outside_market_hours' };
  }

  try {
    const merged = await fetchMunafaTipsSymbols();
    const symbols = merged.symbols || [];
    tipsSourceState.endpointStats = merged.endpointStats || [];
    tipsSourceState.mergedSymbols = symbols;

    if (symbols.length === 0) {
      tipsSourceState.lastStatus = 'empty';
      return { success: false, skipped: true, reason: 'no_symbols' };
    }

    const sync = syncTipsSymbolsIntoWatchlist(symbols);
    tipsSourceState.lastSymbols = sync.symbols;

    // Persist to DB + multibagger scoring + auto-watchlist
    const dbResult = await persistAndScoreMunafaScan(sync.symbols, merged.endpointStats);
    if (dbResult.autoAdded.length > 0) {
      broadcastSSE({ type: 'watchlist_update', data: await dbGetWatchlist() || watchlist });
    }

    const targetSymbols = sync.symbols.filter(sym => watchlist.some(w => w.symbol === sym));
    const autoStartScanner = cfg.autoStartScanner !== false;
    const autoStartMatrixScanner = cfg.autoStartMatrixScanner !== false;
    const scannerIntervalMs = [60000, 120000, 300000, 600000].includes(cfg.scannerIntervalMs)
      ? cfg.scannerIntervalMs
      : 120000;
    const matrixIntervalMs = [30000, 60000, 120000, 300000, 600000].includes(Number(cfg.matrixIntervalMs))
      ? Number(cfg.matrixIntervalMs)
      : 120000;
    const matrixTimeframe = ['1', '5', '15', '30', '60', '1D', '1W', '4h', '1h'].includes(cfg.matrixTimeframe)
      ? cfg.matrixTimeframe
      : '1D';
    const matrixMode = cfg.matrixMode === 'live' ? 'live' : 'backtest';
    const matrixStrategies = getTipsMatrixStrategies(cfg);

    let scanned = targetSymbols.length;
    let matrixStarted = false;
    let truncated = false;

    if (autoStartMatrixScanner && targetSymbols.length > 0 && matrixStrategies.length > 0) {
      const matrixSymbols = targetSymbols;
      truncated = false;
      const signature = `${matrixSymbols.join('|')}::${matrixStrategies.join('|')}::${matrixTimeframe}::${matrixMode}::${matrixIntervalMs}`;

      if (!matrixScannerEnabled || !matrixScannerManagedByTipsSource || matrixScannerManagedSignature !== signature) {
        startMatrixScanner({
          symbols: matrixSymbols,
          strategies: matrixStrategies,
          timeframe: matrixTimeframe,
          mode: matrixMode,
          intervalMs: matrixIntervalMs,
          managedByTipsSource: true,
          managedSignature: signature,
        });
        matrixStarted = true;
      }

      scanned = matrixSymbols.length * matrixStrategies.length;
      tipsSourceState.managedMatrix = true;
    } else if (autoStartScanner) {
      if (!scannerEnabled || scannerManagedByTipsSource) {
        startScanner(scannerIntervalMs, targetSymbols);
        scannerManagedByTipsSource = true;
      }
      tipsSourceState.managedMatrix = false;
    }

    tipsSourceState.lastStatus = 'ok';
    broadcastSSE({
      type: 'tips_source_update',
      data: {
        provider: 'munafasutra',
        reason,
        fetched: symbols.length,
        added: sync.added,
        scanned,
        mergedSymbols: symbols,
        endpointStats: merged.endpointStats || [],
        matrixStarted,
        truncated,
      }
    });

    return {
      success: true,
      provider: 'munafasutra',
      reason,
      fetched: symbols.length,
      added: sync.added,
      scanned,
      mergedSymbols: symbols,
      endpointStats: merged.endpointStats || [],
      matrixStarted,
      truncated,
    };
  } catch (e) {
    tipsSourceState.lastStatus = 'error';
    tipsSourceState.lastError = e.message;
    return { success: false, error: e.message };
  }
}

function stopTipsSourceScheduler() {
  if (tipsSourceTimer) {
    clearInterval(tipsSourceTimer);
    tipsSourceTimer = null;
  }
}

function startTipsSourceScheduler() {
  stopTipsSourceScheduler();
  const cfg = settings.tipsSource || {};
  if (cfg.enabled !== true) return;

  const pollMs = Math.max(60000, Number(cfg.pollMs) || 300000);
  tipsSourceTimer = setInterval(() => {
    runTipsSourceCycle('scheduled').catch(() => {});
  }, pollMs);

  runTipsSourceCycle('startup').catch(() => {});
}

// ── Live Matrix Scanner (v2 engine — no chart switching, N×M continuous) ──

let matrixScannerEnabled = false;
let matrixScannerTimer = null;
let matrixScannerSymbols = [];
let matrixScannerStrategies = [];
let matrixScannerTimeframe = '1D';
let matrixScannerMode = 'backtest';
let matrixScannerIntervalMs = 120000;
let matrixScannerResults = {};
let matrixScannerLastRunAt = null;
let matrixScannerRunning = false;
let matrixScannerManagedByTipsSource = false;
let matrixScannerManagedSignature = '';

function _buildSignalReason(sigType, result) {
  if (!result) return '';
  const parts = [];
  if (sigType === 'BUY') {
    parts.push(`${result.name || result.code} triggered BUY`);
    if (result.winRate != null) parts.push(`Win rate: ${result.winRate}%`);
    if (result.profitFactor != null) parts.push(`PF: ${result.profitFactor}`);
    if (result.exitRules) {
      const er = result.exitRules;
      if (er.tp) parts.push(`TP: ${er.tp}%`);
      if (er.sl) parts.push(`SL: ${er.sl}%`);
    }
  } else if (sigType === 'SELL') {
    parts.push(`${result.name || result.code} triggered SELL (short)`);
    if (result.winRate != null) parts.push(`Win rate: ${result.winRate}%`);
  } else if (sigType === 'IN_TRADE') {
    parts.push(`Currently in position`);
    const cs = result.currentSignal;
    if (cs?.unrealizedPnl != null) parts.push(`Unrealized: ${cs.unrealizedPnl}%`);
    if (cs?.barsHeld != null) parts.push(`Bars held: ${cs.barsHeld}`);
  }
  if (result.regime) parts.push(`Regime: ${result.regime}`);
  return parts.join(' | ');
}

async function runMatrixScannerTick() {
  if (matrixScannerRunning) return;
  if (!matrixScannerSymbols.length || !matrixScannerStrategies.length) return;

  matrixScannerRunning = true;
  const t0 = Date.now();

  try {
    const jobs = [];
    for (const symbol of matrixScannerSymbols) {
      for (const code of matrixScannerStrategies) {
        jobs.push({ code, symbol, timeframe: matrixScannerTimeframe });
      }
    }

    const results = await engineScanMatrix({
      jobs,
      mode: matrixScannerMode,
      concurrency: 6,
    });

    const now = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    matrixScannerLastRunAt = now;

    for (const r of results) {
      const key = `${r.symbol}::${r.code}`;
      const prev = matrixScannerResults[key];

      let signal, sigType, metrics, detail;
      if (r.ok && r.result) {
        const cs = r.result.currentSignal;
        signal = cs || { type: 'HOLD' };
        sigType = typeof signal === 'string' ? signal : signal?.type;
        metrics = {
          totalTrades: r.result.totalTrades ?? null,
          winRate: r.result.winRate ?? null,
          totalPnl: r.result.totalPnl ?? null,
          profitFactor: r.result.profitFactor ?? null,
          sharpe: r.result.sharpe ?? null,
          maxDrawdown: r.result.maxDrawdown ?? null,
        };
        // Build detailed signal context
        const lastTrade = Array.isArray(r.result.tradesPreview) ? r.result.tradesPreview[r.result.tradesPreview.length - 1] : null;
        detail = {
          strategyDescription: r.result.description || null,
          params: r.result.params || null,
          exitRules: r.result.exitRules || null,
          signalDirection: signal.direction || null,
          signalPrice: signal.price ?? (r.result.price || null),
          entryPrice: signal.entryPrice || null,
          unrealizedPnl: signal.unrealizedPnl ?? null,
          barsHeld: signal.barsHeld ?? null,
          signalReason: signal.reason || _buildSignalReason(sigType, r.result),
          lastTrade: lastTrade ? {
            direction: lastTrade.direction,
            entryPrice: lastTrade.entryPrice,
            exitPrice: lastTrade.exitPrice,
            pnl: lastTrade.pnl,
            exitType: lastTrade.exitType,
            barsHeld: lastTrade.barsHeld,
          } : null,
          barsAnalyzed: r.result.barsAnalyzed ?? null,
          regimePerformance: r.result.regimePerformance || null,
        };
      } else {
        signal = { type: 'ERROR', reason: r.error || 'unknown' };
        sigType = 'ERROR';
        metrics = null;
        detail = null;
      }

      const entry = {
        symbol: r.symbol,
        code: r.code,
        name: r.result?.name || r.code,
        timeframe: r.timeframe,
        signalType: sigType,
        signal,
        price: signal?.price || r.result?.lastPrice || r.result?.price || null,
        metrics,
        detail,
        regime: r.result?.regime || null,
        lastScanned: now,
      };

      matrixScannerResults[key] = entry;

      // Alert on new actionable signals
      if (sigType && !['WAIT', 'HOLD', 'ERROR'].includes(sigType)) {
        if (!prev || prev.signalType !== sigType) {
          const reason = detail?.signalReason || signal.reason || sigType;
          const alert = {
            id: Date.now() + Math.random(),
            time: now,
            symbol: r.symbol,
            type: sigType,
            strategy: r.code,
            strategyName: entry.name,
            price: entry.price,
            detail: detail ? {
              direction: detail.signalDirection,
              params: detail.params,
              exitRules: detail.exitRules,
              winRate: metrics?.winRate,
              profitFactor: metrics?.profitFactor,
              regime: entry.regime,
              lastTrade: detail.lastTrade,
            } : null,
            msg: `[MATRIX] ${entry.name}: ${sigType} on ${r.symbol} — ${reason}`,
          };
          alerts.unshift(alert);
          if (alerts.length > 200) alerts.pop();
          debouncedSave('alerts.json', () => alerts);

          if (notificationsEnabled) {
            sendDesktopNotification(`Matrix: ${sigType} \u2014 ${r.symbol}`, `${entry.name}: ${signal.reason || sigType}`);
          }
          if (settings.telegram?.enabled && settings.telegram?.scanAlerts) {
            getTelegram().sendScanAlert(alert).catch(() => {});
          }
          broadcastSSE({ type: 'alert', data: alert });
        }
      }
    }

    broadcastSSE({
      type: 'matrix_scanner_update',
      data: {
        results: Object.values(matrixScannerResults),
        symbols: matrixScannerSymbols.length,
        strategies: matrixScannerStrategies.length,
        lastRunAt: now,
        elapsedMs: Date.now() - t0,
      },
    });

  } catch (e) {
    console.warn('[matrix-scanner] tick failed:', e.message);
  } finally {
    matrixScannerRunning = false;
  }
}

/**
 * Run an on-demand matrix scan for morning scheduler / /scan bot command.
 * Uses engineScanMatrix (no chart-switching, headless-safe).
 * @param {string[]} symbols
 * @param {string[]} strategies
 * @returns {Promise<object[]>} Flat results array
 */
async function runMorningMatrixScan(symbols, strategies) {
  const timeframe = settings.tipsSource?.matrixTimeframe || '1D';
  const mode = 'backtest';
  const results = await engineScanMatrix({
    symbols,
    strategies,
    timeframe,
    mode,
    concurrency: 4,
  });
  return results
    .filter(r => r.ok && r.result)
    .map(r => ({
      symbol: r.symbol,
      code: r.code,
      name: r.result.name || r.code,
      timeframe: r.timeframe,
      signalType: r.result.currentSignal?.type || 'HOLD',
      signal: r.result.currentSignal || { type: 'HOLD' },
      price: r.result.lastPrice || r.result.price || null,
      metrics: {
        totalTrades: r.result.totalTrades ?? null,
        winRate: r.result.winRate ?? null,
        totalPnl: r.result.totalPnl ?? null,
        profitFactor: r.result.profitFactor ?? null,
      },
    }));
}

function startMatrixScanner({ symbols, strategies, timeframe, mode, intervalMs, managedByTipsSource = false, managedSignature = '' }) {
  stopMatrixScanner();
  matrixScannerSymbols = symbols;
  matrixScannerStrategies = strategies;
  matrixScannerTimeframe = timeframe || '1D';
  matrixScannerMode = mode || 'backtest';
  matrixScannerIntervalMs = intervalMs || 120000;
  matrixScannerEnabled = true;
  matrixScannerResults = {};
  matrixScannerManagedByTipsSource = managedByTipsSource;
  matrixScannerManagedSignature = managedSignature || '';
  tipsSourceState.managedMatrix = managedByTipsSource;

  matrixScannerTimer = setInterval(runMatrixScannerTick, matrixScannerIntervalMs);
  runMatrixScannerTick();
  console.log(`[matrix-scanner] started — ${symbols.length} symbols × ${strategies.length} strategies, ${timeframe}, every ${intervalMs / 1000}s`);
}

function stopMatrixScanner() {
  matrixScannerEnabled = false;
  if (matrixScannerTimer) {
    clearInterval(matrixScannerTimer);
    matrixScannerTimer = null;
  }
  matrixScannerRunning = false;
  matrixScannerManagedByTipsSource = false;
  matrixScannerManagedSignature = '';
  tipsSourceState.managedMatrix = false;
}

async function scanSymbol(symbol) {
  try {
    // Switch chart to the symbol
    await switchSymbol(symbol);
    await new Promise(r => setTimeout(r, 3000)); // Wait for data to load

    const data = await fetchMarketData();
    if (!data || data.error) return null;

    // Check if user has a strategy override for this symbol
    const override = scannerStrategyOverrides[symbol];
    let selection;

    if (override && (BACKTEST_LOGIC[override] || STRATEGIES[override])) {
      // Use the user-specified strategy instead of auto-detection
      const dna = SCRIPT_DNA[override];
      selection = {
        strategy: override,
        score: 100, // User-selected = full confidence
        confidence: 'user-selected',
        source: 'manual',
      };
    } else {
      // Analyze this symbol independently — find its OPTIMAL strategy
      const analysis = analyzeMarketConditions(data);
      const context = buildSelectionContext(data, analysis);
      selection = autoSelectStrategy(analysis, context);
    }

    const analysis = analyzeMarketConditions(data);

    // Run backtest with the selected strategy for THIS symbol
    let backtest = null;
    let currentSignal = { type: 'WAIT', reason: 'No JS backtest logic' };
    if (BACKTEST_LOGIC[selection.strategy]) {
      const btResult = runBacktest(selection.strategy, { ...data, analysis }, {});
      if (btResult) {
        backtest = {
          totalTrades: btResult.totalTrades,
          winRate: btResult.winRate,
          totalPnl: btResult.totalPnl,
          profitFactor: btResult.profitFactor,
          maxDrawdown: btResult.maxDrawdown,
          sharpe: btResult.sharpe,
        };
        currentSignal = btResult.currentSignal || currentSignal;
      }
    }

    // Also check legacy strategy signals for immediate alerts
    const signals = [];
    const legacyStrats = activeStrategies.length ? activeStrategies : ['rsi2', 'ibs', 'fibonacci'];
    for (const stratKey of legacyStrats) {
      const strat = STRATEGIES[stratKey];
      if (!strat) continue;
      const signal = strat.check(data.closes, data.volumes, data.close, data.highs, data.lows, data.times);
      if (signal) {
        signals.push({ ...signal, symbol });
      }
    }

    const now = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

    // Build enriched result for this symbol
    const result = {
      symbol,
      price: data.close,
      change: data.changePercent,
      optimalStrategy: {
        id: selection.strategy,
        name: SCRIPT_DNA[selection.strategy]?.name || selection.strategy,
        score: selection.score,
        confidence: selection.confidence,
        source: selection.source,
      },
      signal: currentSignal,
      backtest,
      regime: analysis.regime,
      volatility: selection.context?.volatility || 'unknown',
      lastScanned: now,
      signals, // legacy signals for alerts
    };

    // Update watchlist item
    const wlItem = watchlist.find(w => w.symbol === symbol);
    if (wlItem) {
      wlItem.price = data.close;
      wlItem.change = data.changePercent;
      wlItem.signal = currentSignal.type !== 'WAIT' ? currentSignal.type : (signals.length > 0 ? signals[0].type : null);
      wlItem.lastScanned = now;
      wlItem.optimalStrategy = result.optimalStrategy.id;
    }

    // Store in scanner results
    scannerResults[symbol] = result;

    return result;
  } catch (e) {
    return null;
  }
}

async function runScannerTick() {
  // Determine which symbols to scan
  const symbolsToScan = scannerSymbols.includes('ALL')
    ? watchlist.map(w => w.symbol)
    : scannerSymbols.filter(s => watchlist.some(w => w.symbol === s));

  if (symbolsToScan.length === 0) return;

  const originalSymbol = currentSymbol;

  for (const sym of symbolsToScan) {
    const result = await scanSymbol(sym);
    if (result) {
      // Broadcast per-symbol result via SSE
      broadcastSSE({ type: 'scanner_result', data: result });

      // Generate alerts for actionable signals
      const alertSignals = [];
      if (result.signal && result.signal.type !== 'WAIT') {
        alertSignals.push({
          type: result.signal.type,
          msg: `[${result.optimalStrategy.name}] ${result.signal.reason || result.signal.type}`,
          strategy: result.optimalStrategy.id,
        });
      }
      for (const sig of (result.signals || [])) {
        alertSignals.push(sig);
      }

      for (const signal of alertSignals) {
        const alert = {
          id: Date.now() + Math.random(),
          time: result.lastScanned,
          symbol: sym,
          ...signal,
          msg: `[SCAN] ${signal.msg}`,
        };
        alerts.unshift(alert);
        if (alerts.length > 200) alerts.pop();
        debouncedSave('alerts.json', () => alerts);

        if (notificationsEnabled) {
          sendDesktopNotification(`Scanner: ${signal.type} — ${sym}`, signal.msg);
        }
        if (settings.telegram?.enabled && settings.telegram?.scanAlerts) {
          getTelegram().sendScanAlert(alert).catch(() => {});
        }
        broadcastSSE({ type: 'alert', data: alert });
      }
    }
  }

  // Broadcast updated watchlist + full scan results
  debouncedSave('watchlist.json', () => watchlist);
  broadcastSSE({ type: 'watchlist_update', data: watchlist });
  broadcastSSE({ type: 'scanner_complete', data: { results: scannerResults, scanned: symbolsToScan.length } });

  // Switch back to original symbol
  if (originalSymbol && originalSymbol !== currentSymbol) {
    await switchSymbol(originalSymbol);
  }
}

function startScanner(intervalMs = 120000, symbols = []) {
  if (scannerInterval) clearInterval(scannerInterval);
  scannerEnabled = true;
  scannerSymbols = symbols.length > 0 ? symbols : ['ALL'];
  scannerInterval = setInterval(runScannerTick, intervalMs);
  runScannerTick();
}

function stopScanner() {
  scannerEnabled = false;
  if (scannerInterval) clearInterval(scannerInterval);
  scannerInterval = null;
}

// ── SSE ──

const sseClients = new Set();

function broadcastSSE(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
  // Feed into live ring buffer (skip noisy status ticks unless they have signals)
  if (payload.type && payload.type !== 'status') {
    pushLiveEvent(payload.type, { data: payload.data });
  }
}

// ── Static File Serving ──

function serveStaticFile(req, res) {
  let filePath = req.url.split('?')[0];
  if (filePath === '/') filePath = '/index.html';

  // Security: prevent path traversal
  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(UI_DIST, filePath);

  // Ensure file is within UI_DIST
  if (!fullPath.startsWith(UI_DIST)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    const ext = path.extname(fullPath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(fullPath).pipe(res);
    return true;
  }

  // SPA fallback: serve index.html for non-API routes
  if (!req.url.startsWith('/api/')) {
    const indexPath = path.join(UI_DIST, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(indexPath).pipe(res);
      return true;
    }
  }

  return false;
}

// ── JSON body parser ──

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 1048576) {
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let url, pathname;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
    pathname = url.pathname;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Invalid URL' }));
    return;
  }

  // ── API Routes ──

  // Health check (used by Fly.io, Docker, uptime monitors)
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), headless: HEADLESS, version: '1.0.0' }));
    return;
  }

  // ── Telegram API ──

  if (pathname === '/api/telegram/status' && req.method === 'GET') {
    const tg = getTelegram();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      ready: tg.ready,
      enabled: settings.telegram?.enabled || false,
      chatId: settings.telegram?.chatId ? '****' + String(settings.telegram.chatId).slice(-4) : null,
    }));
    return;
  }

  if (pathname === '/api/telegram/test' && req.method === 'POST') {
    try {
      const tg = getTelegram();
      if (!tg.ready) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Bot not initialized — check token and chatId in settings' }));
        return;
      }
      await tg.sendTestMessage();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Test message sent' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // v2 API — symbol-aware engine (see src/api/v2.js for full list)
  if (pathname.startsWith('/api/v2/')) {
    try {
      if (await v2Router(req, res, pathname)) return;
    } catch (e) {
      console.error(`[Dashboard] v2 route ${pathname} error:`, e.message, e.stack ? `\n${e.stack}` : '');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
      return;
    }
  }

  // SSE stream
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Status
  if (pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      monitoring,
      symbol: currentSymbol,
      strategies: activeStrategies,
      price: lastData?.close || null,
      alerts: alerts.slice(0, 10)
    }));
    return;
  }

  // Smart Analyze for Control Panel — runs Pine Lab scoring on a symbol
  if (pathname === '/api/monitor/analyze' && req.method === 'POST') {
    try {
      const { symbol } = await parseBody(req);
      if (!symbol || typeof symbol !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Symbol required' }));
        return;
      }

      try { await getClient(); } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Cannot connect to TradingView' }));
        return;
      }

      await switchSymbol(symbol);
      await new Promise(r => setTimeout(r, 3000));

      const data = await fetchMarketData();
      if (!data || data.error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Cannot read chart data' }));
        return;
      }

      const analysis = analyzeMarketConditions(data);
      const context = buildSelectionContext(data, analysis);
      const selection = autoSelectStrategy(analysis, context);

      // Backtest all ranked strategies, blend scores (40% AI + 60% backtest), re-rank
      const rankedWithBacktest = backtestAndRerank(selection.rankings, data, analysis, { full: false });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        symbol: data.symbol,
        price: data.close,
        regime: analysis.regime,
        selection: {
          ...selection,
          rankings: rankedWithBacktest,
        },
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // ── AI Agent: Full Quant Snapshot (for Copilot Chat / MCP tools) ──
  if (pathname === '/api/ai/snapshot' && req.method === 'POST') {
    try {
      const { symbol, switchFirst } = await parseBody(req);
      if (!symbol || typeof symbol !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Symbol required' }));
        return;
      }

      try { await getClient(); } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Cannot connect to TradingView' }));
        return;
      }

      // Save monitored symbol BEFORE switching, so we can restore after briefing
      const wasMonitoring = monitoring;
      const monitoredSymbol = currentSymbol;
      const briefingSymbolUpper = symbol.toUpperCase();

      if (switchFirst !== false) {
        // Fast-path: skip switch if already on this symbol (saves 3s per call)
        const onSame = currentSymbol && currentSymbol.toUpperCase() === briefingSymbolUpper;
        if (!onSame) {
          await switchSymbol(symbol);
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      const data = await fetchMarketData();
      if (!data || data.error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Cannot read chart data' }));
        return;
      }

      const analysis = analyzeMarketConditions(data);
      const context = buildSelectionContext(data, analysis);
      const selection = autoSelectStrategy(analysis, context);
      const rankedWithBacktest = backtestAndRerank(selection.rankings, data, analysis, { full: true });
      const top5 = rankedWithBacktest.slice(0, 5);

      // Restore chart to monitored symbol if we switched away (race-fix)
      let chartRestored = false;
      if (wasMonitoring && monitoredSymbol && monitoredSymbol.toUpperCase() !== briefingSymbolUpper) {
        try {
          await switchSymbol(monitoredSymbol);
          await new Promise(r => setTimeout(r, 1500));
          chartRestored = true;
        } catch {}
      }

      // Build prompt markdown
      const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      // Pretty-print null/undefined as em-dash so the prompt never shows "null" / "undefined"
      const fmt = (v, suffix = '') => {
        if (v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v))) return '—';
        return `${v}${suffix}`;
      };
      const ind = analysis.indicators || {};
      const insufficientData = analysis.regime === 'unknown' || ind.rsi2 == null;
      const promptLines = [
        `## AI Briefing: ${data.symbol} — ${now} IST`,
        '',
        `**Price**: ₹${fmt(data.close)} | Change: ${data.changePercent > 0 ? '+' : ''}${fmt(data.changePercent)}% | Day Range: ${fmt(data.low)}–${fmt(data.high)} | Volume: ${data.volume?.toLocaleString() || '—'}`,
        '',
      ];
      if (insufficientData) {
        promptLines.push(
          `> ⚠ **Insufficient data** — fewer than 30 bars on ${data.timeframe || '?'} timeframe for ${data.symbol}. Indicators and regime detection need more history. Try a longer timeframe (15m, 1h, D) or pick a more liquid symbol.`,
          ''
        );
      }
      promptLines.push(
        `### Market Regime`,
        `**${analysis.regime.toUpperCase()}** (confidence ${Math.round(analysis.regimeConfidence)}%) | Composite: ${analysis.compositeScore > 0 ? '+' : ''}${analysis.compositeScore}`,
        `- Trend: ${analysis.trend.direction} | EMA9 > EMA21: ${analysis.trend.ema9above21} | Above SMA50: ${analysis.trend.aboveSMA50 ?? '—'}`,
        `- ADX: ${fmt(ind.adx)} | Hurst: ${fmt(ind.hurst)} | Var.Ratio: ${fmt(ind.varianceRatio)}`,
        '',
        `### Key Indicators`,
        `| Indicator | Value |`,
        `|-----------|-------|`,
        `| RSI(2) | ${fmt(ind.rsi2)} |`,
        `| RSI(14) | ${fmt(ind.rsi14)} |`,
        `| IBS | ${fmt(ind.ibs)} |`,
        `| ATR% | ${ind.atrPct == null ? '—' : ind.atrPct + '%'} |`,
        `| MACD | ${fmt(ind.macd)} |`,
        `| Stochastic | ${fmt(ind.stoch)} |`,
        `| BB Width | ${fmt(ind.bb?.width)} |`,
        `| Vol Ratio | ${ind.volRatio == null ? '—' : ind.volRatio + 'x'} |`,
        '',
        `### Signals`,
        ...(analysis.signals.length ? analysis.signals.map(s => `- **${s.type}** (${s.strength}%): ${s.reason}`) : ['_No active signals._']),
        '',
        `### Top Strategies (Quant-Ranked)`,
        ...top5.map((r, i) => {
          const sig = r.backtest?.currentSignal;
          const sigType = typeof sig === 'string' ? sig : sig?.type;
          return `${i + 1}. **${r.name || r.id}** — Score: ${r.finalScore} | ${r.proven ? '✓ Proven' : '? Unproven'}${r.backtest ? ` | WR: ${r.backtest.winRate}% | PF: ${r.backtest.profitFactor?.toFixed(2)} | Sharpe: ${r.backtest.sharpe?.toFixed(2)} | Signal: ${sigType || 'HOLD'}` : ''}${r.hardFilters?.length ? ` | ⚠ ${r.hardFilters.join(',')}` : ''}`;
        }),
        '',
        `### Recent Alerts`,
        ...(alerts.slice(0, 5).map(a => `- [${a.type}] ${a.symbol || ''} ${a.msg || a.reason || ''} @ ${a.time || ''}`)),
        '',
        `---`,
        `**MCP tools you can use**: \`quote_get\`, \`data_get_study_values\`, \`data_get_ohlcv(summary:true)\`, \`data_get_pine_lines\`, \`data_get_pine_labels\`, \`capture_screenshot\`, \`tv_live_feed_get(since:${liveFeedSeq})\``,
      );
      const prompt = promptLines.join('\n');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        meta: { symbol: data.symbol, timeframe: data.timeframe, timestamp: now },
        quote: { price: data.close, open: data.open, high: data.high, low: data.low, volume: data.volume, change: data.change, changePercent: data.changePercent },
        regime: { regime: analysis.regime, confidence: Math.round(analysis.regimeConfidence), composite: analysis.compositeScore, trend: analysis.trend, signals: analysis.signals },
        indicators: analysis.indicators,
        rankings: top5,
        recentAlerts: alerts.slice(0, 10),
        recentTrades: tradeHistory.slice(0, 5),
        scannerHits: Object.values(scannerResults).filter(r => r.signal && r.signal !== 'HOLD').slice(0, 8),
        prompt,
        feedCursor: liveFeedSeq,
        chartRestored,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // ── AI Agent: Live Feed (cursor-based pull for MCP streaming) ──
  if (pathname === '/api/ai/feed' && req.method === 'GET') {
    const params = new URL(req.url, `http://localhost`).searchParams;
    const since = parseInt(params.get('since') || '0', 10) || 0;
    const limit = Math.min(parseInt(params.get('limit') || '200', 10) || 200, 500);
    const typesParam = params.get('types');
    const types = typesParam ? typesParam.split(',').map(t => t.trim()) : null;

    let events = liveFeed.filter(e => e.seq > since);
    if (types) events = events.filter(e => types.includes(e.type));
    events = events.slice(-limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      events,
      cursor: liveFeedSeq,
      count: events.length,
    }));
    return;
  }

  // Start monitoring
  if (pathname === '/api/start' && req.method === 'POST') {
    try {
      const { symbol, strategies, interval } = await parseBody(req);

      if (!symbol || typeof symbol !== 'string' || !/^[A-Z][A-Z0-9_ ]*:[A-Z0-9_.&]+$/i.test(symbol)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid symbol format. Use EXCHANGE:SYMBOL (e.g., NSE:RELIANCE, AMEX:SOXS, BINANCE:BTCUSDT)' }));
        return;
      }

      // Validate and filter strategies - accept legacy (STRATEGIES), backtest engine, or SCRIPT_DNA keys
      let validatedStrategies = Array.isArray(strategies) ? strategies.filter(s => STRATEGIES[s] || BACKTEST_LOGIC[s]) : [];

      // If no valid monitorable strategies, fallback to legacy defaults
      if (validatedStrategies.length === 0) {
        validatedStrategies = ['rsi2', 'ibs', 'fibonacci'];
      }

      const validInterval = [15000, 30000, 60000, 120000].includes(interval) ? interval : 60000;

      try { await getClient(); } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Cannot connect to TradingView. Ensure it is running with --remote-debugging-port=9222' }));
        return;
      }

      await switchSymbol(symbol);
      await new Promise(r => setTimeout(r, 2000));

      startMonitoring(symbol, validatedStrategies, validInterval);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, symbol, strategies: validatedStrategies }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Stop monitoring
  if (pathname === '/api/stop' && req.method === 'POST') {
    stopMonitoring();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Get alerts
  if (pathname === '/api/alerts' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ alerts }));
    return;
  }

  // ── Price Alerts ──

  if (pathname === '/api/price-alerts' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, alerts: priceAlerts }));
    return;
  }

  if (pathname === '/api/price-alerts' && req.method === 'POST') {
    try {
      const alertData = await parseBody(req);
      if (!alertData.price || isNaN(alertData.price)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid price' }));
        return;
      }
      const newAlert = {
        id: alertData.id || Date.now(),
        symbol: alertData.symbol || currentSymbol || 'ANY',
        price: parseFloat(alertData.price),
        condition: ['above', 'below', 'cross'].includes(alertData.condition) ? alertData.condition : 'above',
        note: typeof alertData.note === 'string' ? alertData.note.slice(0, 200) : '',
        triggered: false,
        createdAt: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
      };
      priceAlerts.unshift(newAlert);
      if (priceAlerts.length > 50) priceAlerts.pop();
      debouncedSave('price-alerts.json', () => priceAlerts, 500);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, alert: newAlert }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (pathname.startsWith('/api/price-alerts/') && req.method === 'DELETE') {
    const id = parseFloat(pathname.split('/').pop());
    priceAlerts = priceAlerts.filter(a => a.id !== id);
    debouncedSave('price-alerts.json', () => priceAlerts, 500);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // ── Switch Chart Symbol ──

  if (pathname === '/api/chart/set-symbol' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { symbol } = JSON.parse(body);
        if (!symbol) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Symbol required' }));
          return;
        }
        const ok = await switchSymbol(symbol);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: ok, symbol }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── Symbol Search (proxied from TradingView public API) ──

  if (pathname === '/api/symbol-search' && req.method === 'GET') {
    const query = new URL(req.url, 'http://localhost').searchParams.get('q');
    if (!query || query.length < 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, results: [] }));
      return;
    }
    try {
      const params = new URLSearchParams({
        text: query.slice(0, 30),
        hl: '1',
        exchange: '',
        lang: 'en',
        search_type: '',
        domain: 'production',
      });
      const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
        headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
      });
      if (!resp.ok) throw new Error(`TV API: ${resp.status}`);
      const data = await resp.json();
      const strip = s => (s || '').replace(/<\/?em>/g, '');
      const results = (data.symbols || data || []).slice(0, 12).map(r => {
        const sym = strip(r.symbol);
        const prefix = r.prefix || r.exchange || '';
        return {
          symbol: sym,
          description: strip(r.description),
          exchange: r.exchange || r.prefix || '',
          prefix,
          type: r.type || '',
          full_name: prefix ? `${prefix}:${sym}` : sym,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, results: [], error: e.message }));
    }
    return;
  }

  // ── Watchlist ──

  if (pathname === '/api/watchlist' && req.method === 'GET') {
    try {
      const dbWl = await dbGetWatchlist();
      if (dbWl) {
        // DB-backed: return from Postgres
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, watchlist: dbWl, source: 'database' }));
        return;
      }
    } catch {}
    // Fallback: file-based
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, watchlist }));
    return;
  }

  if (pathname === '/api/watchlist' && req.method === 'POST') {
    try {
      const { symbol } = await parseBody(req);
      if (!symbol || typeof symbol !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Symbol required' }));
        return;
      }
      const cleanSymbol = symbol.trim().toUpperCase().slice(0, 30);

      // DB path
      try {
        const row = await dbAddToWatchlist(cleanSymbol, { source: 'manual' });
        if (row) {
          const dbWl = await dbGetWatchlist();
          broadcastSSE({ type: 'watchlist_update', data: dbWl });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, watchlist: dbWl, source: 'database' }));
          return;
        }
      } catch {}

      // Fallback: file-based
      if (watchlist.find(w => w.symbol === cleanSymbol)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Already in watchlist' }));
        return;
      }
      const item = { symbol: cleanSymbol, price: null, change: null, signal: null, addedAt: Date.now() };
      watchlist.push(item);
      debouncedSave('watchlist.json', () => watchlist, 500);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, watchlist }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/watchlist/bulk' && req.method === 'POST') {
    try {
      const { symbols } = await parseBody(req);
      if (!Array.isArray(symbols) || symbols.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'symbols[] required' }));
        return;
      }

      const cleaned = symbols.map(s => normalizeScannerSymbol(s)).filter(Boolean).map(s => s.slice(0, 30));

      // DB path
      try {
        const items = cleaned.map(s => ({ symbol: s, source: 'munafasutra' }));
        const count = await dbBulkAddToWatchlist(items);
        if (count !== null && count !== undefined) {
          const dbWl = await dbGetWatchlist();
          broadcastSSE({ type: 'watchlist_update', data: dbWl });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, added: count, symbols: cleaned, watchlist: dbWl, source: 'database' }));
          return;
        }
      } catch {}

      // Fallback: file-based
      let added = 0;
      const accepted = [];
      for (const cleanSymbol of cleaned) {
        if (watchlist.find(w => normalizeForCompare(w.symbol) === normalizeForCompare(cleanSymbol))) continue;
        watchlist.push({
          symbol: cleanSymbol,
          price: null,
          change: null,
          signal: null,
          addedAt: Date.now(),
          source: 'munafasutra',
        });
        accepted.push(cleanSymbol);
        added++;
      }

      debouncedSave('watchlist.json', () => watchlist, 500);
      broadcastSSE({ type: 'watchlist_update', data: watchlist });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, added, symbols: accepted, watchlist }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (pathname.startsWith('/api/watchlist/') && req.method === 'DELETE') {
    const symbol = decodeURIComponent(pathname.split('/').pop());

    // DB path
    try {
      const removed = await dbRemoveFromWatchlist(symbol);
      if (removed) {
        const dbWl = await dbGetWatchlist();
        broadcastSSE({ type: 'watchlist_update', data: dbWl });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, watchlist: dbWl, source: 'database' }));
        return;
      }
    } catch {}

    // Fallback: file-based
    watchlist = watchlist.filter(w => w.symbol !== symbol);
    debouncedSave('watchlist.json', () => watchlist, 500);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, watchlist }));
    return;
  }

  // ── Recommendation endpoint ──
  if (pathname.startsWith('/api/recommendation/') && req.method === 'GET') {
    const rsi = lastData ? calcRSI(lastData.closes, 2) : null;
    const ema20 = lastData ? calcEMA(lastData.closes, 20) : null;
    const price = lastData?.close;

    let recommendation = 'HOLD';
    let confidence = 'low';
    let reason = 'Insufficient data';

    if (rsi !== null && price) {
      if (rsi < 30) {
        recommendation = 'BUY';
        confidence = rsi < 15 ? 'high' : 'medium';
        reason = `RSI(2) = ${rsi.toFixed(1)} (oversold)`;
      } else if (rsi > 70) {
        recommendation = 'SELL';
        confidence = rsi > 85 ? 'high' : 'medium';
        reason = `RSI(2) = ${rsi.toFixed(1)} (overbought)`;
      } else if (ema20 && price > ema20) {
        recommendation = 'HOLD';
        confidence = 'medium';
        reason = 'Price above EMA(20), trend is up';
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, recommendation, confidence, reason, price, rsi: rsi?.toFixed(1) }));
    return;
  }

  // ── Trade History ──
  if (pathname === '/api/trades' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, trades: tradeHistory }));
    return;
  }

  if (pathname === '/api/trades/clear' && req.method === 'POST') {
    tradeHistory = [];
    saveJSON('trades.json', []);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // ── Available Strategies List ──

  if (pathname === '/api/strategies' && req.method === 'GET') {
    const strategies = Object.entries(BACKTEST_LOGIC).map(([id, s]) => ({ id, name: s.name, engine: 'legacy' }));
    // Also include legacy STRATEGIES that aren't in BACKTEST_LOGIC
    for (const [id, s] of Object.entries(STRATEGIES)) {
      if (!BACKTEST_LOGIC[id]) strategies.push({ id, name: s.name, engine: 'legacy' });
    }
    // Include v2 engine strategies (used by matrix scanner)
    for (const code of STRATEGY_CODES) {
      if (!strategies.find(s => s.id === code)) {
        strategies.push({ id: code, name: code.replace(/_/g, ' '), engine: 'v2' });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, strategies }));
    return;
  }

  // ── Scanner (Multi-Symbol Background Scanning) ──

  if (pathname === '/api/scanner/start' && req.method === 'POST') {
    try {
      const { interval, symbols, strategyOverrides } = await parseBody(req);
      const validInterval = [60000, 120000, 300000, 600000].includes(interval) ? interval : 120000;
      // symbols: array of selected symbols, or ['ALL'] or empty for all
      const selectedSymbols = Array.isArray(symbols) ? symbols.map(s => String(s).trim().toUpperCase().slice(0, 30)) : [];
      // strategyOverrides: { symbol: strategyId } — per-symbol strategy override
      const validOverrides = {};
      if (strategyOverrides && typeof strategyOverrides === 'object') {
        for (const [sym, strat] of Object.entries(strategyOverrides)) {
          if (strat && strat !== 'auto' && (BACKTEST_LOGIC[strat] || STRATEGIES[strat])) {
            validOverrides[sym.trim().toUpperCase()] = strat;
          }
        }
      }
      scannerStrategyOverrides = validOverrides;
      startScanner(validInterval, selectedSymbols);
      scannerManagedByTipsSource = false;
      const scanCount = selectedSymbols.includes('ALL') || selectedSymbols.length === 0 ? watchlist.length : selectedSymbols.length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, scanning: true, interval: validInterval, symbols: scanCount, selectedSymbols: scannerSymbols }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/scanner/stop' && req.method === 'POST') {
    stopScanner();
    scannerManagedByTipsSource = false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, scanning: false }));
    return;
  }

  if (pathname === '/api/scanner/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      scanning: scannerEnabled,
      symbols: scannerSymbols,
      watchlistCount: watchlist.length,
      managedByTipsSource: scannerManagedByTipsSource,
      matrixManagedByTipsSource: matrixScannerManagedByTipsSource,
      tipsSource: {
        ...(settings.tipsSource || {}),
        ...tipsSourceState,
      },
    }));
    return;
  }

  if (pathname === '/api/scanner/tips-source/refresh' && req.method === 'POST') {
    try {
      const result = await runTipsSourceCycle('manual');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/scanner/tips-source/symbols' && req.method === 'GET') {
    // Prefer DB for persisted scan results with scores
    try {
      const dbScans = await dbGetTodayMunafaScans();
      if (dbScans && dbScans.length > 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          provider: 'munafasutra',
          symbols: dbScans.map(s => s.symbol),
          scans: dbScans,
          count: dbScans.length,
          endpointStats: tipsSourceState.endpointStats || [],
          lastRunAt: tipsSourceState.lastRunAt,
          lastStatus: tipsSourceState.lastStatus,
          lastError: tipsSourceState.lastError,
          source: 'database',
        }));
        return;
      }
    } catch {}

    // Fallback: in-memory
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      provider: 'munafasutra',
      symbols: tipsSourceState.mergedSymbols || [],
      count: (tipsSourceState.mergedSymbols || []).length,
      endpointStats: tipsSourceState.endpointStats || [],
      lastRunAt: tipsSourceState.lastRunAt,
      lastStatus: tipsSourceState.lastStatus,
      lastError: tipsSourceState.lastError,
    }));
    return;
  }

  if (pathname === '/api/scanner/results' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, results: scannerResults, count: Object.keys(scannerResults).length }));
    return;
  }

  // ── Live Matrix Scanner (v2 engine — N×M continuous) ──

  if (pathname === '/api/scanner/matrix/start' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { symbols, strategies, timeframe, mode, interval } = body;
      if (!Array.isArray(symbols) || symbols.length === 0) throw new Error('symbols[] required');
      if (!Array.isArray(strategies) || strategies.length === 0) throw new Error('strategies[] required');
      if (symbols.length > 30) throw new Error('max 30 symbols');
      if (strategies.length > 13) throw new Error('max 13 strategies');
      if (symbols.length * strategies.length > 200) throw new Error(`Too many jobs (${symbols.length * strategies.length}). Max 200.`);

      const validInterval = [30000, 60000, 120000, 300000, 600000].includes(interval) ? interval : 120000;
      const cleanSymbols = symbols.map(s => String(s).trim().toUpperCase().slice(0, 30));
      const cleanStrategies = strategies
        .map(s => String(s).trim().slice(0, 50))
        .filter(code => STRATEGY_CODES.includes(code));
      if (!cleanStrategies.length) throw new Error('No valid v2 engine strategies selected');
      const tf = ['1', '5', '15', '30', '60', '1D', '1W', '4h', '1h'].includes(timeframe) ? timeframe : '1D';
      const engineMode = mode === 'live' ? 'live' : 'backtest';

      startMatrixScanner({ symbols: cleanSymbols, strategies: cleanStrategies, timeframe: tf, mode: engineMode, intervalMs: validInterval });
      matrixScannerManagedByTipsSource = false;
      matrixScannerManagedSignature = '';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        scanning: true,
        symbols: cleanSymbols.length,
        strategies: cleanStrategies.length,
        jobs: cleanSymbols.length * cleanStrategies.length,
        interval: validInterval,
        timeframe: tf,
        mode: engineMode,
      }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/scanner/matrix/stop' && req.method === 'POST') {
    stopMatrixScanner();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, scanning: false }));
    return;
  }

  if (pathname === '/api/scanner/matrix/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      scanning: matrixScannerEnabled,
      symbols: matrixScannerSymbols,
      strategies: matrixScannerStrategies,
      timeframe: matrixScannerTimeframe,
      mode: matrixScannerMode,
      interval: matrixScannerIntervalMs,
      jobs: matrixScannerSymbols.length * matrixScannerStrategies.length,
      lastRunAt: matrixScannerLastRunAt,
      resultCount: Object.keys(matrixScannerResults).length,
      managedByTipsSource: matrixScannerManagedByTipsSource,
    }));
    return;
  }

  if (pathname === '/api/scanner/matrix/results' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      results: Object.values(matrixScannerResults),
      count: Object.keys(matrixScannerResults).length,
      lastRunAt: matrixScannerLastRunAt,
    }));
    return;
  }

  // ── Settings (notifications toggle) ──

  if (pathname === '/api/settings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      notifications: notificationsEnabled,
      scanning: scannerEnabled,
      tipsSource: {
        ...(settings.tipsSource || {}),
        ...tipsSourceState,
      },
    }));
    return;
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (typeof body.notifications === 'boolean') {
        notificationsEnabled = body.notifications;
      }

      if (body.tipsSource && typeof body.tipsSource === 'object') {
        const merged = { ...(settings.tipsSource || {}), ...body.tipsSource };
        merged.enabled = merged.enabled === true;
        merged.provider = 'munafasutra';
        const defaultUrls = [
          'https://munafasutra.com/nse/intradayTradingTips/',
          'https://munafasutra.com/nse/BestIntradayTips',
        ];
        merged.urls = Array.isArray(merged.urls)
          ? merged.urls.map(v => String(v || '').trim()).filter(Boolean)
          : defaultUrls;
        if (!merged.urls.length) merged.urls = defaultUrls;
        merged.includeIntradayTradingTips = merged.includeIntradayTradingTips !== false;
        merged.includeBestIntradayTips = merged.includeBestIntradayTips !== false;
        merged.maxSymbols = Math.max(1, Number(merged.maxSymbols) || 500);
        merged.pollMs = Math.max(60000, Number(merged.pollMs) || 300000);
        merged.scannerIntervalMs = [60000, 120000, 300000, 600000].includes(Number(merged.scannerIntervalMs))
          ? Number(merged.scannerIntervalMs)
          : 120000;
        merged.matrixIntervalMs = [30000, 60000, 120000, 300000, 600000].includes(Number(merged.matrixIntervalMs))
          ? Number(merged.matrixIntervalMs)
          : 120000;
        merged.matrixTimeframe = ['1', '5', '15', '30', '60', '1D', '1W', '4h', '1h'].includes(merged.matrixTimeframe)
          ? merged.matrixTimeframe
          : '1D';
        merged.matrixMode = merged.matrixMode === 'live' ? 'live' : 'backtest';
        merged.matrixUseAllStrategies = merged.matrixUseAllStrategies !== false;
        merged.matrixStrategies = Array.isArray(merged.matrixStrategies)
          ? merged.matrixStrategies.filter(code => STRATEGY_CODES.includes(code)).slice(0, 13)
          : [];
        merged.onlyMarketHours = merged.onlyMarketHours !== false;
        merged.includePremarket = merged.includePremarket !== false;
        merged.autoStartScanner = merged.autoStartScanner !== false;
        merged.autoStartMatrixScanner = merged.autoStartMatrixScanner !== false;
        settings.tipsSource = merged;
      }

      settings.notifications = notificationsEnabled;

      // Merge telegram settings and re-init bot if changed
      if (body.telegram && typeof body.telegram === 'object') {
        const prev = settings.telegram || {};
        settings.telegram = {
          enabled: body.telegram.enabled === true,
          botToken: String(body.telegram.botToken || prev.botToken || '').trim(),
          chatId: String(body.telegram.chatId || prev.chatId || '').trim(),
          morningDigest: body.telegram.morningDigest !== false,
          scanAlerts: body.telegram.scanAlerts !== false,
          priceAlerts: body.telegram.priceAlerts !== false,
          commands: body.telegram.commands !== false,
        };
        initTelegram(settings.telegram).then(ok => {
          if (ok) {
            getTelegram().onStatusRequest(async () => ({
              scanning: scannerEnabled || matrixScannerEnabled,
              watchlistCount: watchlist.length,
              tipsSource: { enabled: settings.tipsSource?.enabled, ...tipsSourceState },
            }));
          }
        }).catch(err => console.warn('[telegram] re-init error:', err.message));
      }

      saveJSON('settings.json', settings);
      startTipsSourceScheduler();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        notifications: notificationsEnabled,
        tipsSource: {
          ...(settings.tipsSource || {}),
          ...tipsSourceState,
        },
      }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // ── Clear Alerts ──

  if (pathname === '/api/alerts/clear' && req.method === 'POST') {
    alerts = [];
    saveJSON('alerts.json', []);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // ── Quick Actions ──

  // ── Pine Script Lab ──

  // Analyze chart and recommend strategy
  if (pathname === '/api/pine/analyze' && req.method === 'GET') {
    try {
      const tfOverride = url.searchParams.get('timeframe');
      const data = tfOverride ? await fetchMarketDataAtTimeframe(tfOverride) : (lastData || await fetchMarketData());
      if (!data || data.error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Cannot read chart data. Ensure TradingView is running.' }));
        return;
      }
      const analysis = analyzeMarketConditions(data);
      const context = buildSelectionContext(data, analysis);
      const selection = autoSelectStrategy(analysis, context);

      // Backtest all ranked strategies, blend scores (40% AI + 60% backtest), re-rank
      const rankedWithBacktest = backtestAndRerank(selection.rankings, data, analysis, { full: true });

      // Log selection for feedback/learning (use re-ranked #1)
      logSelection({
        timestamp: Date.now(),
        symbol: data.symbol,
        timeframe: data.timeframe,
        price: data.close,
        regime: analysis.regime,
        topPick: rankedWithBacktest[0]?.id || selection.strategy,
        score: rankedWithBacktest[0]?.finalScore || selection.score,
        confidence: selection.confidence,
        actionable: selection.actionable,
        context: selection.context,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        symbol: data.symbol,
        price: data.close,
        analysis,
        selection: { ...selection, rankings: rankedWithBacktest },
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Generate Pine Script
  if (pathname === '/api/pine/generate' && req.method === 'POST') {
    try {
      const { strategy: stratType, symbol, auto } = await parseBody(req);

      let analysis = null;
      let selectedStrategy = stratType;
      let targetSymbol = symbol || currentSymbol || 'SYMBOL';

      if (auto || !stratType) {
        const data = lastData || await fetchMarketData();
        if (data && !data.error) {
          analysis = analyzeMarketConditions(data);
          const context = buildSelectionContext(data, analysis);
          const selection = autoSelectStrategy(analysis, context);
          selectedStrategy = selection.strategy;
          targetSymbol = data.symbol || targetSymbol;
        }
      }

      const code = generatePineScript(selectedStrategy, targetSymbol, analysis);
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Unknown strategy type: ${selectedStrategy}` }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        strategy: selectedStrategy,
        symbol: targetSymbol,
        code,
        analysis: analysis ? { regime: analysis.regime, compositeScore: analysis.compositeScore, signals: analysis.signals.length } : null,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Deploy Pine Script to TradingView
  if (pathname === '/api/pine/deploy' && req.method === 'POST') {
    try {
      const { code } = await parseBody(req);
      if (!code || typeof code !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Pine Script code required' }));
        return;
      }

      // Save to scripts/current.pine (backup)
      const pineDir = path.join(__dirname, 'scripts');
      if (!fs.existsSync(pineDir)) fs.mkdirSync(pineDir, { recursive: true });
      fs.writeFileSync(path.join(pineDir, 'current.pine'), code);

      // ── Auto-fix: strip incompatible calls from strategies ──
      let cleanCode = code;
      const isStrategy = /strategy\s*\(/.test(code);
      if (isStrategy) {
        // alertcondition() has no effect inside strategies — remove those lines
        cleanCode = cleanCode.replace(/^.*alertcondition\s*\(.*\).*$/gm, '// [auto-removed] alertcondition not allowed in strategies');

        // Enforce full-capital backtest assumptions in TradingView Strategy Tester.
        // Replace existing values
        cleanCode = cleanCode.replace(/default_qty_type\s*=\s*[^,\)\n]+/g, 'default_qty_type=strategy.percent_of_equity');
        cleanCode = cleanCode.replace(/default_qty_value\s*=\s*[\d.]+/g, 'default_qty_value=100');
        cleanCode = cleanCode.replace(/initial_capital\s*=\s*[\d.]+/g, 'initial_capital=100000');

        // Insert missing params BEFORE the closing ) of strategy() — not at the start (avoids positional arg conflict)
        if (!/default_qty_type\s*=/.test(cleanCode)) {
          cleanCode = cleanCode.replace(/(strategy\s*\([^)]+)\)/, '$1, default_qty_type=strategy.percent_of_equity)');
        }
        if (!/default_qty_value\s*=/.test(cleanCode)) {
          cleanCode = cleanCode.replace(/(strategy\s*\([^)]+)\)/, '$1, default_qty_value=100)');
        }
        if (!/initial_capital\s*=/.test(cleanCode)) {
          cleanCode = cleanCode.replace(/(strategy\s*\([^)]+)\)/, '$1, initial_capital=100000)');
        }
        if (!/currency\s*=\s*currency\.INR/.test(cleanCode)) {
          cleanCode = cleanCode.replace(/(strategy\s*\([^)]+)\)/, '$1, currency=currency.INR)');
        }
      }
      // Upgrade Pine v5 to v6 (v5 is deprecated)
      cleanCode = cleanCode.replace(/\/\/@version=5/, '//@version=6');

      // ── Full automated pipeline via CDP ──
      const steps = [];

      // Step 1: Open Pine Editor
      try {
        await ensurePineEditorOpen();
        steps.push('✓ Pine Editor opened');
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Cannot open Pine Editor — is TradingView running with CDP?', steps }));
        return;
      }

      // Step 2: Set source code
      try {
        await pineSetSource({ source: cleanCode });
        steps.push('✓ Source code injected' + (cleanCode !== code ? ' (auto-fixed)' : ''));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Set source failed: ${e.message}`, steps }));
        return;
      }

      // Step 3: Compile (Add to chart / Update on chart)
      let compileResult;
      try {
        compileResult = await pineSmartCompile();
        steps.push(`✓ Compiled: ${compileResult.button_clicked}`);

        // If only "Pine Save" was clicked, the script isn't on the chart yet.
        // Wait and retry — look for "Add to chart" / "Update on chart" by both text and title attr.
        if (compileResult.button_clicked === 'Pine Save' || compileResult.button_clicked === 'keyboard_shortcut') {
          await new Promise(r => setTimeout(r, 1500));
          const addResult = await evaluate(`
            (function() {
              // First try: icon buttons with title attribute (TradingView split-view mode)
              var container = document.querySelector('.tv-script-widget');
              if (container) {
                var btns = container.querySelectorAll('button');
                for (var i = 0; i < btns.length; i++) {
                  var title = btns[i].getAttribute('title') || '';
                  if (/add to chart|update on chart|save and add/i.test(title)) {
                    btns[i].click();
                    return title;
                  }
                }
              }
              // Second try: text content buttons (bottom panel mode)
              var allBtns = document.querySelectorAll('button');
              for (var j = 0; j < allBtns.length; j++) {
                var text = allBtns[j].textContent.trim();
                if (/^add to chart$/i.test(text) || /^update on chart$/i.test(text) || /^save and add to chart$/i.test(text)) {
                  allBtns[j].click();
                  return text;
                }
              }
              return null;
            })()
          `);
          if (addResult) {
            steps.push(`✓ Added to chart: ${addResult}`);
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Compile failed: ${e.message}`, steps }));
        return;
      }

      // Step 4: Check for errors
      let errors = compileResult.errors || [];
      if (errors.length === 0) {
        try {
          const errResult = await pineGetErrors();
          errors = errResult.errors || [];
        } catch (e) { /* ignore */ }
      }

      if (errors.length > 0) {
        steps.push(`✗ ${errors.length} compile error(s)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: `Compilation errors: ${errors.map(e => `Line ${e.line}: ${e.message}`).join('; ')}`,
          steps,
          errors,
        }));
        return;
      }

      steps.push('✓ No compilation errors');

      // Step 5: Verify strategy is on chart — if not, force "Add to chart"
      if (isStrategy) {
        await new Promise(r => setTimeout(r, 1500));
        const stratOnChart = await evaluate(`
          (function() {
            try {
              var chart = window.TradingViewApi._activeChartWidgetWV.value();
              var studies = chart.getAllStudies();
              for (var i = 0; i < studies.length; i++) {
                var s = studies[i];
                if (s.type === 'strategy' || (s.name && /strategy/i.test(s.type))) return true;
              }
            } catch(e) {}
            return false;
          })()
        `);
        if (!stratOnChart) {
          // Strategy not on chart — try Add to chart button
          const forceAdd = await evaluate(`
            (function() {
              var container = document.querySelector('.tv-script-widget');
              if (container) {
                var btns = container.querySelectorAll('button');
                for (var i = 0; i < btns.length; i++) {
                  var title = btns[i].getAttribute('title') || '';
                  if (/add to chart/i.test(title)) { btns[i].click(); return title; }
                }
              }
              var allBtns = document.querySelectorAll('button');
              for (var j = 0; j < allBtns.length; j++) {
                var text = allBtns[j].textContent.trim();
                if (/^add to chart$/i.test(text)) { allBtns[j].click(); return text; }
              }
              return null;
            })()
          `);
          if (forceAdd) {
            steps.push(`✓ Force-added to chart: ${forceAdd}`);
            await new Promise(r => setTimeout(r, 2500));
          } else {
            steps.push('⚠ Strategy may not be on chart — click "Add to chart" in Pine Editor manually');
          }
        } else {
          steps.push('✓ Strategy detected on chart');
        }
      }

      // Step 6: Open Strategy Tester if it's a strategy
      if (isStrategy) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          await openPanel({ panel: 'strategy-tester', action: 'open' });
          await new Promise(r => setTimeout(r, 1000));
          await openPanel({ panel: 'strategy-tester', action: 'open' });
          steps.push('✓ Strategy Tester opened');
        } catch (e) {
          steps.push('⚠ Strategy Tester: could not auto-open');
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `Deployed to TradingView${isStrategy ? ' — Strategy Tester active' : ' — added to chart'}`,
        steps,
        isStrategy,
        studyAdded: compileResult.study_added,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // List available strategy templates (all scripts — unified, no categories)
  if (pathname === '/api/pine/templates' && req.method === 'GET') {
    const templates = Object.entries(SCRIPT_DNA).map(([id, dna]) => ({
      id,
      name: dna.name,
      description: dna.winConditions?.join(', ') || '',
      type: dna.style === 'overlay' ? 'indicator' : 'strategy',
      style: dna.style,
      riskLevel: dna.riskLevel,
      backtestable: !!BACKTEST_LOGIC[id],
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, templates }));
    return;
  }

  // Selection log + stats — feedback loop infrastructure
  if (pathname === '/api/pine/selection-log' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, log: selectionLog.slice(0, 50), stats: selectionStats() }));
    return;
  }

  // ── Backtest endpoint — runs strategy on historical chart data ──
  if (pathname === '/api/pine/backtest' && req.method === 'POST') {
    try {
      const { strategy: stratId, params, timeframe: tfOverride } = await parseBody(req);
      const data = tfOverride ? await fetchMarketDataAtTimeframe(tfOverride) : (lastData || await fetchMarketData());
      if (!data || data.error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Cannot read chart data' }));
        return;
      }

      // If strategy has JS backtest logic, run it
      if (BACKTEST_LOGIC[stratId]) {
        const analysis = analyzeMarketConditions(data);
        const result = runBacktest(stratId, { ...data, analysis }, params || {});
        if (!result) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Insufficient data for backtest (need 50+ bars)' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, backtest: result, method: 'js_simulation' }));
      } else {
        // No JS backtest engine — deploy to TradingView Strategy Tester
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          backtest: null,
          method: 'requires_deploy',
          message: `"${stratId}" has no JS backtest engine yet — deploy to TradingView and use Strategy Tester for results.`,
          hint: 'Use the Deploy button, then check TradingView Strategy Tester tab.',
        }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Scripts library — serves ALL pine scripts from all pdf/ subfolders (unified)
  if (pathname === '/api/pine/community' && req.method === 'GET') {
    const pdfDir = path.join(__dirname, 'pdf');
    const scripts = [];
    try {
      if (fs.existsSync(pdfDir)) {
        const subfolders = fs.readdirSync(pdfDir).filter(f => fs.statSync(path.join(pdfDir, f)).isDirectory());
        for (const folder of subfolders) {
          const folderPath = path.join(pdfDir, folder);
          const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.pine'));
          for (const file of files) {
            const id = file.replace('.pine', '');
            const dna = SCRIPT_DNA[id];
            scripts.push({
              id,
              file,
              name: dna?.name || id.replace(/_/g, ' '),
              description: dna?.winConditions?.join(', ') || '',
              type: dna?.style === 'overlay' ? 'indicator' : 'strategy',
              style: dna?.style || 'unknown',
              backtestable: !!BACKTEST_LOGIC[id],
            });
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, scripts }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Get script source code (searches all pdf/ subfolders)
  if (pathname.startsWith('/api/pine/community/') && req.method === 'GET') {
    const id = pathname.split('/').pop();
    const safeName = id.replace(/[^a-z0-9_-]/gi, '');
    const pdfDir = path.join(__dirname, 'pdf');
    let source = null;
    try {
      if (fs.existsSync(pdfDir)) {
        const subfolders = fs.readdirSync(pdfDir).filter(f => fs.statSync(path.join(pdfDir, f)).isDirectory());
        for (const folder of subfolders) {
          const filePath = path.join(pdfDir, folder, safeName + '.pine');
          if (fs.existsSync(filePath)) {
            source = fs.readFileSync(filePath, 'utf-8');
            break;
          }
        }
      }
      if (!source) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Script not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id: safeName, source }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Launch TradingView Desktop with CDP debugging
  if (pathname === '/api/actions/launch-tv' && req.method === 'POST') {
    try {
      const { launch } = await import('./src/core/health.js');
      const result = await launch({ port: 9222, kill_existing: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Health check
  if (pathname === '/api/actions/health-check' && req.method === 'GET') {
    try {
      const { healthCheck } = await import('./src/core/health.js');
      const result = await healthCheck();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Switch symbol on chart
  if (pathname === '/api/actions/switch-symbol' && req.method === 'POST') {
    try {
      const { symbol } = await parseBody(req);
      if (!symbol || typeof symbol !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Symbol required' }));
        return;
      }
      const cleanSymbol = symbol.trim().toUpperCase().slice(0, 30);
      await switchSymbol(cleanSymbol);
      currentSymbol = cleanSymbol;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, symbol: cleanSymbol }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Set timeframe
  if (pathname === '/api/actions/set-timeframe' && req.method === 'POST') {
    try {
      const { timeframe } = await parseBody(req);
      if (!timeframe || typeof timeframe !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Timeframe required' }));
        return;
      }
      const validTF = /^(1|3|5|15|30|45|60|120|180|240|D|W|M)$/;
      if (!validTF.test(timeframe)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid timeframe' }));
        return;
      }
      await execFileAsync('node', ['src/cli/index.js', 'timeframe', timeframe], { cwd: process.cwd() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, timeframe }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Screenshot
  if (pathname === '/api/actions/screenshot' && req.method === 'POST') {
    try {
      await execFileAsync('node', ['src/cli/index.js', 'screenshot'], { cwd: process.cwd() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Screenshot saved to screenshots/' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Toggle fullscreen
  if (pathname === '/api/actions/fullscreen' && req.method === 'POST') {
    try {
      await evaluate(`
        (function() {
          var btn = document.querySelector('[data-name="fullscreen"]') || document.querySelector('[aria-label="Fullscreen"]');
          if (btn) btn.click();
        })()
      `);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Open panel (pine-editor, strategy-tester, alerts, watchlist)
  if (pathname === '/api/actions/open-panel' && req.method === 'POST') {
    try {
      const { panel } = await parseBody(req);
      const panelMap = {
        'pine-editor': 'pine-editor',
        'strategy-tester': 'backtesting',
        'alerts': 'alerts',
        'watchlist': 'watchlist',
        'trading': 'trading',
      };
      const dataName = panelMap[panel];
      if (!dataName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid panel name' }));
        return;
      }
      await evaluate(`
        (function() {
          var btn = document.querySelector('[data-name="${dataName}"]') ||
                   document.querySelector('[aria-label="${dataName}"]') ||
                   document.querySelector('button[id*="${dataName}"]');
          if (btn) btn.click();
          else {
            var btns = document.querySelectorAll('button');
            for (var i = 0; i < btns.length; i++) {
              var t = btns[i].textContent || btns[i].getAttribute('aria-label') || '';
              if (t.toLowerCase().indexOf('${dataName}') !== -1) { btns[i].click(); break; }
            }
          }
        })()
      `);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, panel }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // ── Serve static files (React build) ──
  if (serveStaticFile(req, res)) return;

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  const uiExists = fs.existsSync(path.join(UI_DIST, 'index.html'));
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   TRADING DASHBOARD — React UI + API Server                 ║');
  console.log(`║   http://localhost:${PORT}                                      ║`);
  console.log('║                                                              ║');
  if (uiExists) {
    console.log('║   ✓ React UI built and ready                                ║');
  } else {
    console.log('║   ⚠ React UI not built. Run: cd ui && npm run build         ║');
    console.log('║   Or for dev mode: cd ui && npm run dev                     ║');
  }
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Strategies: RSI(2), IBS, Fibonacci');
  console.log('Features: Live alerts, Buy/Sell signals, Price alerts, Watchlist, Trade history');
  console.log('NEW: Persistent storage, Desktop notifications, Multi-symbol scanner');
  console.log(`Data: ${DATA_DIR}`);
  console.log('');

  // Auto-start the background scheduler (Phase 7.5/8.7) — soft-fails without DATABASE_URL.
  try {
    const out = schedulerMaybeAutoStart();
    if (out?.ok) console.log('[scheduler] auto-started');
    else if (out?.reason) console.log(`[scheduler] not started: ${out.reason}`);
  } catch (err) {
    console.warn('[scheduler] failed to auto-start:', err.message);
  }

  // DB keepalive — prevent Supabase from pausing due to inactivity (ping every 3 hours)
  try {
    import('./src/db/client.js').then(({ isDbConfigured, query: dbQuery }) => {
      if (isDbConfigured()) {
        setInterval(() => { dbQuery('SELECT 1').catch(() => {}); }, 3 * 60 * 60 * 1000);
        console.log('[db] keepalive enabled (3h interval)');
      }
    }).catch(() => {});
  } catch {}

  try {
    startTipsSourceScheduler();
    if (settings?.tipsSource?.enabled) {
      console.log('[tips-source] MunafaSutra sync scheduler enabled');
    }
  } catch (err) {
    console.warn('[tips-source] failed to start:', err.message);
  }

  // ── Telegram Bot + Morning Scheduler ──
  (async () => {
    try {
      const telegramCfg = settings.telegram || {};
      const ok = await initTelegram(telegramCfg);
      if (ok) {
        const tg = getTelegram();
        console.log('[telegram] Bot ready');

        // Register interactive command callbacks
        tg.onScanCommand(async () => {
          const symbols = tipsSourceState.mergedSymbols?.length > 0
            ? tipsSourceState.mergedSymbols
            : watchlist.map(w => w.symbol);
          if (symbols.length === 0) { await tg.sendMessage('_No symbols in watchlist_'); return; }
          const now = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
          await tg.sendMessage(`⏳ Scanning ${symbols.length} symbols…`);
          const { INTRADAY_STRATEGIES } = await import('./src/engine/morning-scheduler.js');
          const results = await runMorningMatrixScan(symbols, INTRADAY_STRATEGIES);
          await tg.sendScanSummary(results, now);
        });

        tg.onFetchDigest(async () => {
          const result = await fetchMunafaTipsSymbols();
          return { symbols: result?.symbols || [] };
        });

        tg.onStatusRequest(async () => ({
          scanning: scannerEnabled || matrixScannerEnabled,
          watchlistCount: watchlist.length,
          tipsSource: { enabled: settings.tipsSource?.enabled, ...tipsSourceState },
        }));

        // Start morning scheduler
        startMorningScheduler({
          fetchMunafa: async () => {
            const result = await fetchMunafaTipsSymbols();
            return { symbols: result?.symbols || [] };
          },
          runMatrixScan: runMorningMatrixScan,
          telegram: tg,
          getSettings: () => settings,
        });
      }
    } catch (err) {
      console.warn('[telegram] startup error:', err.message);
    }
  })();
});

// Graceful shutdown — stop the scheduler so timers don't keep the process alive.
process.on('SIGINT', () => {
  try { stopScheduler(); } catch { /* ignore */ }
  try { stopTipsSourceScheduler(); } catch { /* ignore */ }
  try { stopMatrixScanner(); } catch { /* ignore */ }
  try { stopMorningScheduler(); } catch { /* ignore */ }
  try { getTelegram().stop(); } catch { /* ignore */ }
  process.exit(0);
});
process.on('SIGTERM', () => {
  try { stopScheduler(); } catch { /* ignore */ }
  try { stopTipsSourceScheduler(); } catch { /* ignore */ }
  try { stopMatrixScanner(); } catch { /* ignore */ }
  try { stopMorningScheduler(); } catch { /* ignore */ }
  try { getTelegram().stop(); } catch { /* ignore */ }
  process.exit(0);
});
