/**
 * Background scheduler — Phase 7.5 / 8.7
 *
 * Periodically refreshes stale rows in the performance matrix so the rank
 * leaderboard stays current. Soft-fails when DATABASE_URL is not set or the
 * pool isn't reachable.
 *
 * Wake-up cycle:
 *   1. Query `staleRuns(maxAgeDays)` for the oldest rows.
 *   2. Take the next `batch` (groups by symbol×strategy×timeframe to avoid duplicate work).
 *   3. For each cell, re-run multi-window matrix via runMultiWindow.
 *   4. Persist results via persistMatrixCell (writes per-window rows).
 *   5. Wait `intervalMin` minutes, repeat.
 *
 * Environment:
 *   SCHEDULER_ENABLED         true | false  (default true)
 *   SCHEDULER_INTERVAL_MIN    minutes between wake-ups (default 30)
 *   SCHEDULER_MAX_AGE_DAYS    stale threshold (default 7)
 *   SCHEDULER_BATCH           cells per cycle (default 5)
 *
 * REST control:
 *   GET  /api/v2/scheduler/status
 *   POST /api/v2/scheduler/run-now   { maxAgeDays?, batch? }
 *   POST /api/v2/scheduler/seed      { cells, provider? }
 */

import { isDbConfigured } from '../db/client.js';
import { staleRuns } from '../db/matrix.js';
import { persistMatrixCell } from '../db/persist.js';
import { runMultiWindow, TIME_WINDOWS } from './matrix-runner.js';

// ── Singleton state ──────────────────────────────────────────────
const state = {
  running: false,                  // a cycle is currently executing
  enabled: false,                  // scheduler timer is registered
  intervalMin: 30,
  maxAgeDays: 7,
  batch: 5,
  lastCycleAt: null,               // ISO timestamp
  lastCycleResult: null,           // { processed, refreshed, failed, ms, errors }
  totalCycles: 0,
  totalRefreshed: 0,
  totalFailed: 0,
  startedAt: null,
  bootTimer: null,                 // setTimeout id for the warm-up delay
  timer: null,                     // setInterval id once warm-up completes
};

/* ── Public API ─────────────────────────────────────────────────── */

/**
 * Start the scheduler. Idempotent — calling twice has no extra effect.
 *
 * @param {Object} [opts]
 * @param {number} [opts.intervalMin]
 * @param {number} [opts.maxAgeDays]
 * @param {number} [opts.batch]
 */
export function startScheduler(opts = {}) {
  if (state.enabled) return { ok: true, alreadyRunning: true };

  // Use ?? cascade so callers passing 0 for maxAgeDays don't get clobbered by env/default.
  const pickNum = (...vals) => {
    for (const v of vals) {
      if (v == null || v === '') continue;
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  state.intervalMin = pickNum(opts.intervalMin, process.env.SCHEDULER_INTERVAL_MIN) ?? 30;
  state.maxAgeDays  = pickNum(opts.maxAgeDays,  process.env.SCHEDULER_MAX_AGE_DAYS) ?? 7;
  state.batch       = pickNum(opts.batch,       process.env.SCHEDULER_BATCH)        ?? 5;
  // Hard floors so a misconfigured env can't disable the scheduler silently.
  if (state.intervalMin < 1) state.intervalMin = 1;
  if (state.batch < 1) state.batch = 1;

  if (!isDbConfigured()) {
    return { ok: false, reason: 'DATABASE_URL not set — scheduler disabled' };
  }

  state.enabled = true;
  state.startedAt = new Date().toISOString();

  const intervalMs = state.intervalMin * 60_000;
  // First cycle after a short warm-up so the dashboard isn't blocked on boot.
  const firstDelayMs = 60_000; // 1 minute

  state.bootTimer = setTimeout(() => {
    state.bootTimer = null;
    if (!state.enabled) return;
    runSchedulerCycle().catch(err => console.warn('[scheduler] first cycle failed:', err.message));
    state.timer = setInterval(() => {
      runSchedulerCycle().catch(err => console.warn('[scheduler] cycle failed:', err.message));
    }, intervalMs);
  }, firstDelayMs);

  console.log(`[scheduler] started — interval ${state.intervalMin}min, maxAge ${state.maxAgeDays}d, batch ${state.batch}`);
  return { ok: true };
}

/** Stop the scheduler. Idempotent. */
export function stopScheduler() {
  if (state.bootTimer) {
    clearTimeout(state.bootTimer);
    state.bootTimer = null;
  }
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.enabled = false;
  console.log('[scheduler] stopped');
  return { ok: true };
}

/** Read current scheduler state (safe to call anytime). */
export function getSchedulerStatus() {
  return {
    enabled: state.enabled,
    running: state.running,
    intervalMin: state.intervalMin,
    maxAgeDays: state.maxAgeDays,
    batch: state.batch,
    startedAt: state.startedAt,
    lastCycleAt: state.lastCycleAt,
    lastCycleResult: state.lastCycleResult,
    totalCycles: state.totalCycles,
    totalRefreshed: state.totalRefreshed,
    totalFailed: state.totalFailed,
    dbConfigured: isDbConfigured(),
  };
}

/**
 * Run one refresh cycle immediately. Skips if a cycle is already running.
 *
 * @param {Object} [opts]
 * @param {number} [opts.maxAgeDays]
 * @param {number} [opts.batch]
 * @returns {Promise<{processed,refreshed,failed,ms,skipped?,errors}>}
 */
export async function runSchedulerCycle(opts = {}) {
  if (state.running) {
    return { skipped: true, reason: 'already running' };
  }
  if (!isDbConfigured()) {
    return { skipped: true, reason: 'no DATABASE_URL' };
  }

  state.running = true;
  const t0 = Date.now();
  // Use ?? not || so callers can pass maxAgeDays:0 to refresh everything.
  const maxAgeDays = opts.maxAgeDays != null ? Number(opts.maxAgeDays) : state.maxAgeDays;
  const batch      = opts.batch      != null ? Number(opts.batch)      : state.batch;
  const result = { processed: 0, refreshed: 0, failed: 0, ms: 0, errors: [] };

  try {
    const stale = await staleRuns(maxAgeDays, batch * 4);  // overfetch to dedupe
    const cellSet = dedupeCells(stale).slice(0, batch);
    result.processed = cellSet.length;

    for (const cell of cellSet) {
      try {
        const multi = await runMultiWindow({
          code: cell.strategy,
          symbol: cell.symbol,
          timeframe: cell.timeframe,
          provider: 'js',
        });
        // Shape into the matrix cell layout expected by persistMatrixCell.
        const cellOut = {
          code: cell.strategy,
          symbol: cell.symbol,
          timeframe: cell.timeframe,
          windows: multi.windows,
        };
        const persistResult = await persistMatrixCell({ cell: cellOut, provider: 'yahoo' });
        if (persistResult.ok) {
          result.refreshed++;
          state.totalRefreshed++;
        } else {
          result.failed++;
          state.totalFailed++;
          result.errors.push({ cell, error: persistResult.error || 'persist failed' });
        }
      } catch (err) {
        result.failed++;
        state.totalFailed++;
        result.errors.push({ cell, error: err.message });
      }
    }
  } catch (err) {
    result.errors.push({ stage: 'staleRuns', error: err.message });
  } finally {
    result.ms = Date.now() - t0;
    state.lastCycleAt = new Date().toISOString();
    state.lastCycleResult = result;
    state.totalCycles++;
    state.running = false;
    console.log(`[scheduler] cycle done in ${result.ms}ms — processed ${result.processed}, refreshed ${result.refreshed}, failed ${result.failed}`);
  }

  return result;
}

/* ── helpers ─────────────────────────────────────────────────────── */

/**
 * staleRuns returns one row per backtest run (one per window_label). We only
 * want to re-run the cell once and let runMultiWindow regenerate all windows.
 */
function dedupeCells(staleRows) {
  const seen = new Set();
  const out = [];
  for (const r of staleRows) {
    const key = `${r.symbol}::${r.strategy}::${r.timeframe}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol: r.symbol, strategy: r.strategy, timeframe: r.timeframe });
  }
  return out;
}

/** Convenience: dashboard auto-bootstrap based on env. */
export function maybeAutoStart() {
  const enabled = (process.env.SCHEDULER_ENABLED ?? 'true').toLowerCase() === 'true';
  if (!enabled) {
    console.log('[scheduler] disabled via SCHEDULER_ENABLED=false');
    return { ok: false, reason: 'disabled' };
  }
  return startScheduler();
}
