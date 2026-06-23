/**
 * Morning Scheduler
 *
 * Runs two cron jobs every Mon–Fri in IST:
 *   8:00 AM — Fetch Munafasutra symbols → send Telegram morning digest
 *   8:30 AM — Run full intraday matrix scan → send Telegram scan summary
 *
 * Usage (called by dashboard.js after Telegram is initialized):
 *   import { startMorningScheduler, stopMorningScheduler } from './morning-scheduler.js';
 *   startMorningScheduler({ fetchMunafa, runMatrixScan, telegram });
 */

import cron from 'node-cron';

const INTRADAY_STRATEGIES = [
  'master_intraday',
  'ema_rsi_intraday',
  'supertrend_intraday',
  'ibs_india_intraday',
];

let _jobs = [];
let _started = false;

/**
 * Start the morning scheduler.
 *
 * @param {object} opts
 * @param {Function} opts.fetchMunafa          - async () => { symbols: string[] } — calls existing Munafa fetch
 * @param {Function} opts.runMatrixScan        - async (symbols, strategies) => results[]
 * @param {object}   opts.telegram             - TelegramService instance (getTelegram())
 * @param {Function} [opts.getSettings]        - () => settings object — used to check if Telegram enabled
 */
export function startMorningScheduler({ fetchMunafa, runMatrixScan, telegram, getSettings }) {
  if (_started) stopMorningScheduler();

  // ── 8:00 AM IST Mon–Fri — Morning Digest ──────────────────────────────────
  const digestJob = cron.schedule('0 8 * * 1-5', async () => {
    console.log('[morning-scheduler] 8:00 AM — fetching Munafasutra digest');
    try {
      const cfg = getSettings?.() || {};
      if (!cfg.telegram?.enabled || !cfg.telegram?.morningDigest) {
        console.log('[morning-scheduler] Telegram digest disabled in settings — skipping');
        return;
      }

      const result = await fetchMunafa();
      const symbols = result?.symbols || [];
      const date = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

      if (symbols.length === 0) {
        console.log('[morning-scheduler] No symbols fetched for digest');
        await telegram.sendMessage(
          `🌅 *Morning Digest — ${date}*\n\n_No symbols available from Munafasutra today._`
        );
        return;
      }

      await telegram.sendMorningDigest(symbols, date);
      console.log(`[morning-scheduler] Digest sent — ${symbols.length} symbols`);
    } catch (err) {
      console.error('[morning-scheduler] Digest job error:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  // ── 8:30 AM IST Mon–Fri — Live Scan + Summary ────────────────────────────
  const scanJob = cron.schedule('30 8 * * 1-5', async () => {
    console.log('[morning-scheduler] 8:30 AM — running intraday matrix scan');
    try {
      const cfg = getSettings?.() || {};
      if (!cfg.telegram?.enabled || !cfg.telegram?.scanAlerts) {
        console.log('[morning-scheduler] Telegram scan alerts disabled — skipping');
        return;
      }

      // Get the symbol list from Telegram service (populated by digest job or last Munafa fetch)
      const symbols = telegram.lastDigestSymbols?.length > 0
        ? telegram.lastDigestSymbols
        : (await fetchMunafa())?.symbols || [];

      if (symbols.length === 0) {
        console.log('[morning-scheduler] No symbols to scan');
        await telegram.sendMessage('⚠️ *8:30 AM Scan*\n\n_No symbols available to scan._');
        return;
      }

      await telegram.sendMessage(`⏳ *Starting 8:30 AM scan...*\n${symbols.length} symbols × ${INTRADAY_STRATEGIES.length} strategies`);

      const timestamp = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
      const results = await runMatrixScan(symbols, INTRADAY_STRATEGIES);

      await telegram.sendScanSummary(results, timestamp);
      console.log(`[morning-scheduler] Scan summary sent — ${results.length} results`);
    } catch (err) {
      console.error('[morning-scheduler] Scan job error:', err.message);
      try {
        await telegram.sendMessage(`❌ *8:30 AM scan failed*\n\`${err.message}\``);
      } catch { /* ignore secondary failure */ }
    }
  }, { timezone: 'Asia/Kolkata' });

  _jobs = [digestJob, scanJob];
  _started = true;
  console.log('[morning-scheduler] Started — digest at 8:00 AM, scan at 8:30 AM IST (Mon–Fri)');
}

export function stopMorningScheduler() {
  for (const job of _jobs) {
    try { job.stop(); } catch { /* ignore */ }
  }
  _jobs = [];
  _started = false;
  console.log('[morning-scheduler] Stopped');
}

export function isMorningSchedulerRunning() {
  return _started;
}

/** List of intraday strategies used by the 8:30 AM scan */
export { INTRADAY_STRATEGIES };
