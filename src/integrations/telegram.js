/**
 * Telegram Bot Integration
 *
 * Provides:
 *   - Morning digest (8:00 AM IST) — Munafasutra symbol list
 *   - Scan summary (8:30 AM IST) — BUY/SELL signals from intraday matrix
 *   - Live scan alerts — BUY/SELL as scanner produces them
 *   - Price alerts — when a price level is triggered
 *   - Interactive commands: /scan, /status, /report, /help
 *
 * Usage:
 *   import { initTelegram, getTelegram } from './telegram.js';
 *   await initTelegram({ token, chatId });
 *   getTelegram().sendScanAlert(signal);
 */

import { Telegraf } from 'telegraf';

class TelegramService {
  constructor() {
    this.bot = null;
    this.chatId = null;
    this.ready = false;
    this.lastScanResults = [];
    this.lastScanTime = null;
    this.lastDigestSymbols = [];

    // Callbacks registered by dashboard.js for interactive commands
    this._onScanCommand = null;
    this._onStatusRequest = null;
  }

  /**
   * Initialize the bot. Safe to call multiple times (re-initializes).
   * @param {object} opts
   * @param {string} opts.token  - Telegram bot token from BotFather
   * @param {string|number} opts.chatId - Target chat / group ID
   */
  async initialize({ token, chatId }) {
    if (!token || !chatId) {
      console.warn('[telegram] Missing token or chatId — Telegram disabled');
      this.ready = false;
      return false;
    }

    // Stop previous instance if re-initializing
    if (this.bot) {
      try { await this.bot.stop(); } catch { /* ignore */ }
    }

    this.chatId = String(chatId);
    this.bot = new Telegraf(token);
    this._registerCommands();

    // Launch in polling mode — works everywhere including headless cloud
    try {
      // launch() returns a Promise that resolves only when the bot stops — do not await
      this.bot.launch().catch(err => {
        console.error('[telegram] Polling error:', err.message);
        this.ready = false;
      });
      await new Promise(r => setTimeout(r, 1500));
      this.ready = true;
      console.log('[telegram] Bot launched and polling');
      return true;
    } catch (err) {
      console.error('[telegram] Failed to launch bot:', err.message);
      this.ready = false;
      return false;
    }
  }

  stop() {
    if (this.bot) {
      try { this.bot.stop('SIGTERM'); } catch { /* ignore */ }
    }
    this.ready = false;
  }

  // ── Command Handlers ────────────────────────────────────────────────────────

  _registerCommands() {
    const bot = this.bot;

    bot.command('start', ctx => ctx.reply(this._helpText()));
    bot.command('help', ctx => ctx.reply(this._helpText()));

    bot.command('status', async ctx => {
      if (!this._isTrustedChat(ctx)) return;
      let text = '📊 *Scanner Status*\n';
      if (this._onStatusRequest) {
        const s = await this._onStatusRequest();
        text += `\nScanning: ${s.scanning ? '✅ Active' : '⏸ Stopped'}`;
        text += `\nWatchlist: ${s.watchlistCount} symbols`;
        text += `\nTips Source: ${s.tipsSource?.enabled ? '✅ Enabled' : '⏸ Disabled'}`;
        text += `\nLast Scan: ${this.lastScanTime || 'Never'}`;
        text += `\nLast Digest: ${this.lastDigestSymbols.length} symbols`;
      } else {
        text += '\n_Status endpoint not yet connected_';
      }
      ctx.replyWithMarkdown(text);
    });

    bot.command('report', ctx => {
      if (!this._isTrustedChat(ctx)) return;
      if (this.lastScanResults.length === 0) {
        ctx.reply('No scan results yet. Results appear after the 8:30 AM scan or a /scan command.');
        return;
      }
      ctx.replyWithMarkdown(this._formatScanSummary(this.lastScanResults, this.lastScanTime));
    });

    bot.command('scan', async ctx => {
      if (!this._isTrustedChat(ctx)) return;
      ctx.reply('⏳ Triggering on-demand scan… results incoming shortly.');
      if (this._onScanCommand) {
        try {
          await this._onScanCommand();
        } catch (err) {
          ctx.reply(`❌ Scan failed: ${err.message}`);
        }
      } else {
        ctx.reply('⚠️ Scan callback not yet registered. Start the dashboard first.');
      }
    });

    bot.command('digest', ctx => {
      if (!this._isTrustedChat(ctx)) return;
      if (this.lastDigestSymbols.length === 0) {
        ctx.reply('No morning digest available yet.');
        return;
      }
      ctx.replyWithMarkdown(this._formatDigest(this.lastDigestSymbols, new Date().toLocaleDateString('en-IN')));
    });

    // Ignore all other messages silently
    bot.on('message', ctx => {
      if (!this._isTrustedChat(ctx)) return;
    });
  }

  _isTrustedChat(ctx) {
    return String(ctx.chat?.id) === this.chatId;
  }

  _helpText() {
    return [
      '🤖 *MunafaSutra Alert Bot*',
      '',
      'Commands:',
      '/scan — Trigger on-demand scan now',
      '/status — Scanner status & last run info',
      '/report — Show last scan results',
      '/digest — Show today\'s morning symbol list',
      '/help — This message',
      '',
      'Automatic messages:',
      '• 8:00 AM — Morning digest (Munafasutra symbols)',
      '• 8:30 AM — Live scan results (BUY/SELL signals)',
      '• Live — Real-time alerts as signals fire',
      '• Live — Price level alerts',
    ].join('\n');
  }

  // ── Message Senders ─────────────────────────────────────────────────────────

  async sendMessage(text, options = {}) {
    if (!this.ready || !this.chatId) return;
    try {
      await this.bot.telegram.sendMessage(this.chatId, text, {
        parse_mode: 'Markdown',
        ...options,
      });
    } catch (err) {
      // Token/chatId errors should not crash the app
      console.error('[telegram] sendMessage failed:', err.message);
    }
  }

  /**
   * Send 8:00 AM morning digest — list of Munafasutra symbols for the day.
   */
  async sendMorningDigest(symbols, date) {
    if (!this.ready) return;
    this.lastDigestSymbols = symbols;
    const text = this._formatDigest(symbols, date);
    await this.sendMessage(text);
  }

  /**
   * Send 8:30 AM scan summary — table of BUY/SELL signals.
   * @param {Array} results - Array of { symbol, strategy, signalType, price, detail }
   * @param {string} timestamp
   */
  async sendScanSummary(results, timestamp) {
    if (!this.ready) return;
    this.lastScanResults = results;
    this.lastScanTime = timestamp;
    const text = this._formatScanSummary(results, timestamp);
    await this.sendMessage(text);
  }

  /**
   * Send a live scan alert (individual BUY/SELL as scanner emits them).
   * @param {object} alert - { symbol, type, strategy, msg, price }
   */
  async sendScanAlert(alert) {
    if (!this.ready) return;
    const emoji = alert.type === 'BUY' ? '🟢' : alert.type === 'SELL' ? '🔴' : '🟡';
    const price = alert.price ? ` @ ₹${alert.price}` : '';
    const text = [
      `${emoji} *${alert.type}* — ${alert.symbol}${price}`,
      `Strategy: ${alert.strategyName || alert.strategy || 'Unknown'}`,
      alert.msg ? `_${this._escape(alert.msg)}_` : '',
      `🕐 ${alert.time || new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}`,
    ].filter(Boolean).join('\n');
    await this.sendMessage(text);
  }

  /**
   * Send a price level alert.
   * @param {object} alert - { symbol, condition, price, note, triggeredAt }
   */
  async sendPriceAlert(alert) {
    if (!this.ready) return;
    const symbol = alert.symbol || 'Unknown';
    const cond = alert.condition?.toUpperCase() || 'CROSSED';
    const text = [
      `🔔 *Price Alert: ${symbol}*`,
      `Condition: ${cond} ₹${alert.price}`,
      alert.note ? `Note: _${this._escape(alert.note)}_` : '',
      `🕐 ${alert.triggeredAt || new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}`,
    ].filter(Boolean).join('\n');
    await this.sendMessage(text);
  }

  /**
   * Send a test message — used by Settings UI to verify configuration.
   */
  async sendTestMessage() {
    if (!this.ready) {
      throw new Error('Bot not initialized — check token and chatId');
    }
    const text = [
      '✅ *MunafaSutra Bot Connected!*',
      '',
      `Dashboard is live and Telegram integration is working.`,
      `Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
      '',
      'Type /help to see available commands.',
    ].join('\n');
    await this.sendMessage(text);
  }

  // ── Formatters ──────────────────────────────────────────────────────────────

  _formatDigest(symbols, date) {
    const lines = [
      `🌅 *Morning Digest — ${date}*`,
      `_Munafasutra intraday watchlist (${symbols.length} symbols)_`,
      '',
      symbols.map((s, i) => `${i + 1}. \`${s}\``).join('\n'),
      '',
      `Scan starts at 8:30 AM IST. Stay alert! 🎯`,
    ];
    return lines.join('\n');
  }

  _formatScanSummary(results, timestamp) {
    const buys = results.filter(r => r.signalType === 'BUY');
    const sells = results.filter(r => r.signalType === 'SELL');
    const others = results.filter(r => !['BUY', 'SELL', 'HOLD', 'WAIT'].includes(r.signalType));

    const lines = [
      `📊 *8:30 AM Scan Results — ${timestamp || 'now'}*`,
    ];

    if (buys.length > 0) {
      lines.push(`\n🟢 *BUY Signals (${buys.length})*`);
      for (const r of buys.slice(0, 15)) {
        const price = r.price ? ` @ ₹${r.price}` : '';
        const wr = r.metrics?.winRate != null ? ` WR:${r.metrics.winRate.toFixed(0)}%` : '';
        lines.push(`• \`${r.symbol}\`${price} — ${r.name || r.code}${wr}`);
      }
    }

    if (sells.length > 0) {
      lines.push(`\n🔴 *SELL Signals (${sells.length})*`);
      for (const r of sells.slice(0, 15)) {
        const price = r.price ? ` @ ₹${r.price}` : '';
        lines.push(`• \`${r.symbol}\`${price} — ${r.name || r.code}`);
      }
    }

    if (others.length > 0) {
      lines.push(`\n🟡 *Other Signals (${others.length})*`);
      for (const r of others.slice(0, 10)) {
        lines.push(`• \`${r.symbol}\` [${r.signalType}] — ${r.name || r.code}`);
      }
    }

    if (buys.length === 0 && sells.length === 0 && others.length === 0) {
      lines.push('\n_No actionable signals today — market may be in consolidation._');
    }

    lines.push(`\nTotal scanned: ${results.length} symbol×strategy pairs`);
    return lines.join('\n');
  }

  _escape(text) {
    // Escape Markdown special chars for Telegram Markdown v1
    return String(text).replace(/[_*[\]()~`>#+=|{}.!-]/g, c => `\\${c}`);
  }

  // ── Callback Registration ───────────────────────────────────────────────────

  /**
   * Register callback for /scan command — dashboard.js provides the scan trigger.
   * @param {Function} fn - async () => void
   */
  onScanCommand(fn) {
    this._onScanCommand = fn;
  }

  /**
   * Register callback for /status command — dashboard.js provides status data.
   * @param {Function} fn - async () => statusObject
   */
  onStatusRequest(fn) {
    this._onStatusRequest = fn;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance = null;

export function getTelegram() {
  if (!_instance) _instance = new TelegramService();
  return _instance;
}

/**
 * Initialize Telegram from settings. Called by dashboard.js on startup or settings change.
 * @param {object} telegramSettings - settings.telegram from .data/settings.json
 */
export async function initTelegram(telegramSettings = {}) {
  const svc = getTelegram();
  if (!telegramSettings.enabled) {
    console.log('[telegram] Disabled in settings');
    svc.ready = false;
    return false;
  }
  return svc.initialize({
    token: telegramSettings.botToken || process.env.TELEGRAM_BOT_TOKEN,
    chatId: telegramSettings.chatId || process.env.TELEGRAM_CHAT_ID,
  });
}
