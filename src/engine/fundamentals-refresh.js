/**
 * Fundamentals Refresh Scheduler — keeps the symbols table fresh.
 *
 * Runs periodically to fetch Yahoo fundamentals for stale symbols and store
 * key screening metrics (mcap, price, PE, ROE, etc.) in the DB. This enables
 * the multibagger screener to do instant DB-level pre-filtering.
 *
 * Configuration (env vars):
 *   FUNDAMENTALS_REFRESH_ENABLED=true      Enable/disable (default: true if DB configured)
 *   FUNDAMENTALS_REFRESH_INTERVAL_MIN=60   Minutes between refresh cycles (default: 60)
 *   FUNDAMENTALS_REFRESH_BATCH=100         Symbols per cycle (default: 100)
 *   FUNDAMENTALS_REFRESH_STALE_HOURS=24    Stale threshold (default: 24)
 *   FUNDAMENTALS_REFRESH_CONCURRENCY=2     Parallel Yahoo requests (default: 2)
 */

import { isDbConfigured, query } from '../db/client.js';
import { getFundamentals } from '../data/fundamentals/index.js';
import { loadNSEUniverse } from '../data/fundamentals/universe-filter.js';

// ── State ────────────────────────────────────────────────────────────────

const state = {
  enabled: false,
  running: false,
  timer: null,
  lastCycleAt: null,
  lastCycleResult: null,
  totalRefreshed: 0,
  totalFailed: 0,
  totalCycles: 0,
};

// ── Configuration ────────────────────────────────────────────────────────

function getConfig() {
  return {
    enabled: process.env.FUNDAMENTALS_REFRESH_ENABLED !== 'false',
    intervalMin: parseInt(process.env.FUNDAMENTALS_REFRESH_INTERVAL_MIN) || 60,
    batch: parseInt(process.env.FUNDAMENTALS_REFRESH_BATCH) || 100,
    staleHours: parseInt(process.env.FUNDAMENTALS_REFRESH_STALE_HOURS) || 24,
    concurrency: parseInt(process.env.FUNDAMENTALS_REFRESH_CONCURRENCY) || 2,
  };
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Start the fundamentals refresh scheduler. Idempotent.
 */
export function startFundamentalsRefresh() {
  if (state.enabled) return { ok: true, alreadyRunning: true };
  if (!isDbConfigured()) return { ok: false, reason: 'no DATABASE_URL' };

  const cfg = getConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled via env' };

  state.enabled = true;

  // Warm-up delay: 2 minutes after boot
  setTimeout(async () => {
    await ensureSymbolsSeeded();
    await runCycle();
    // Then repeat every intervalMin
    state.timer = setInterval(() => runCycle(), cfg.intervalMin * 60 * 1000);
  }, 2 * 60 * 1000);

  return { ok: true, intervalMin: cfg.intervalMin, batch: cfg.batch };
}

/**
 * Stop the scheduler.
 */
export function stopFundamentalsRefresh() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.enabled = false;
}

/**
 * Trigger a cycle manually.
 */
export async function runFundamentalsRefreshNow(opts = {}) {
  return runCycle(opts);
}

/**
 * Get current status.
 */
export function getFundamentalsRefreshStatus() {
  const cfg = getConfig();
  return {
    ...state,
    timer: !!state.timer,
    config: cfg,
    dbConfigured: isDbConfigured(),
  };
}

// ── Internal ─────────────────────────────────────────────────────────────

async function runCycle(opts = {}) {
  if (state.running) return { ok: false, reason: 'already running' };
  state.running = true;
  const startTime = Date.now();

  const cfg = getConfig();
  const batch = opts.batch || cfg.batch;
  const staleHours = opts.staleHours || cfg.staleHours;
  const concurrency = opts.concurrency || cfg.concurrency;

  try {
    // Find stale symbols
    const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
    const result = await query(`
      SELECT canonical FROM symbols
      WHERE exchange = 'NSE' AND active = TRUE
        AND (data_refreshed_at IS NULL OR data_refreshed_at < $1)
      ORDER BY data_refreshed_at ASC NULLS FIRST
      LIMIT $2
    `, [cutoff, batch]);

    const symbols = result.rows.map(r => r.canonical);
    if (symbols.length === 0) {
      state.running = false;
      state.lastCycleAt = new Date().toISOString();
      state.lastCycleResult = { refreshed: 0, failed: 0, ms: Date.now() - startTime, message: 'all fresh' };
      state.totalCycles++;
      return state.lastCycleResult;
    }

    // Fetch and persist
    let refreshed = 0, failed = 0;
    const queue = [...symbols];
    let backoffMs = 300;

    async function worker() {
      while (queue.length > 0) {
        const sym = queue.shift();
        if (!sym) break;

        try {
          await sleep(backoffMs);
          const snap = await getFundamentals(sym, { forceRefresh: false });
          if (snap && (snap.price || snap.name)) {
            await upsertSymbolFundamentals(sym, snap);
            refreshed++;
            backoffMs = Math.max(200, backoffMs * 0.92);
          } else {
            failed++;
          }
        } catch (e) {
          const msg = e.message || '';
          if (msg.includes('429') || msg.includes('Too Many') || msg.includes('rate')) {
            backoffMs = Math.min(8000, backoffMs * 2.5);
            queue.push(sym);
          } else {
            failed++;
          }
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
    await Promise.all(workers);

    const ms = Date.now() - startTime;
    state.lastCycleAt = new Date().toISOString();
    state.lastCycleResult = { refreshed, failed, ms, batch: symbols.length };
    state.totalRefreshed += refreshed;
    state.totalFailed += failed;
    state.totalCycles++;

    console.log(`[fundamentals-refresh] cycle #${state.totalCycles}: ${refreshed} refreshed, ${failed} failed (${Math.round(ms/1000)}s)`);
    return state.lastCycleResult;
  } catch (err) {
    console.error('[fundamentals-refresh] cycle error:', err.message);
    state.lastCycleResult = { error: err.message };
    return state.lastCycleResult;
  } finally {
    state.running = false;
  }
}

/**
 * Ensure the symbols table has rows for all NSE universe symbols.
 * Seeds minimal rows (canonical + ticker) for symbols not yet in DB.
 */
async function ensureSymbolsSeeded() {
  try {
    const countResult = await query(`SELECT COUNT(*) as c FROM symbols WHERE exchange = 'NSE' AND active = TRUE`);
    const count = parseInt(countResult.rows[0].c);

    if (count < 100) {
      console.log('[fundamentals-refresh] seeding NSE universe into DB...');
      const universe = loadNSEUniverse();
      const BATCH = 500;
      for (let i = 0; i < universe.length; i += BATCH) {
        const batch = universe.slice(i, i + BATCH);
        const values = [];
        const params = [];
        let idx = 1;
        for (const sym of batch) {
          values.push(`($${idx}, 'NSE', $${idx+1}, 'equity')`);
          params.push(sym, sym.slice(4));
          idx += 2;
        }
        await query(`
          INSERT INTO symbols (canonical, exchange, ticker, asset_class)
          VALUES ${values.join(', ')}
          ON CONFLICT (canonical) DO NOTHING
        `, params);
      }
      console.log(`[fundamentals-refresh] seeded ${universe.length} symbols`);
    }
  } catch (err) {
    console.warn('[fundamentals-refresh] seed check failed:', err.message);
  }
}

/**
 * Upsert a single symbol's fundamentals into DB.
 */
async function upsertSymbolFundamentals(symbol, snap) {
  const sql = `
    INSERT INTO symbols (canonical, exchange, ticker, asset_class, sector, industry, name, market_cap, price,
      pe, pb, peg, ev_to_ebitda, roe, roce, operating_margin, net_margin,
      revenue_cagr_3y, eps_cagr_3y, revenue_growth_qoq, eps_growth_yoy,
      debt_to_equity, current_ratio, interest_coverage,
      fifty_two_week_high, fifty_two_week_low, free_cashflow,
      data_refreshed_at, updated_at)
    VALUES ($1, 'NSE', $2, 'equity', $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19,
      $20, $21, $22,
      $23, $24, $25,
      NOW(), NOW())
    ON CONFLICT (canonical) DO UPDATE SET
      sector = COALESCE(EXCLUDED.sector, symbols.sector),
      industry = COALESCE(EXCLUDED.industry, symbols.industry),
      name = COALESCE(EXCLUDED.name, symbols.name),
      market_cap = COALESCE(EXCLUDED.market_cap, symbols.market_cap),
      price = COALESCE(EXCLUDED.price, symbols.price),
      pe = EXCLUDED.pe,
      pb = EXCLUDED.pb,
      peg = EXCLUDED.peg,
      ev_to_ebitda = EXCLUDED.ev_to_ebitda,
      roe = EXCLUDED.roe,
      roce = EXCLUDED.roce,
      operating_margin = EXCLUDED.operating_margin,
      net_margin = EXCLUDED.net_margin,
      revenue_cagr_3y = EXCLUDED.revenue_cagr_3y,
      eps_cagr_3y = EXCLUDED.eps_cagr_3y,
      revenue_growth_qoq = EXCLUDED.revenue_growth_qoq,
      eps_growth_yoy = EXCLUDED.eps_growth_yoy,
      debt_to_equity = EXCLUDED.debt_to_equity,
      current_ratio = EXCLUDED.current_ratio,
      interest_coverage = EXCLUDED.interest_coverage,
      fifty_two_week_high = EXCLUDED.fifty_two_week_high,
      fifty_two_week_low = EXCLUDED.fifty_two_week_low,
      free_cashflow = EXCLUDED.free_cashflow,
      data_refreshed_at = NOW(),
      updated_at = NOW()
  `;

  const ticker = symbol.startsWith('NSE:') ? symbol.slice(4) : symbol;
  await query(sql, [
    symbol, ticker,
    snap.sector || null, snap.industry || null, snap.name || null,
    snap.marketCap || null, snap.price || null,
    snap.pe || null, snap.pb || null, snap.peg || null, snap.evToEbitda || null,
    snap.roe || null, snap.roce || null, snap.operatingMargin || null, snap.netMargin || null,
    snap.revenueCAGR3y || null, snap.epsCAGR3y || null, snap.revenueQoQ || null, snap.epsQtrYoY || null,
    snap.debtToEquity || null, snap.currentRatio || null, snap.interestCoverage || null,
    snap.fiftyTwoWeekHigh || null, snap.fiftyTwoWeekLow || null, snap.freeCashflow || null,
  ]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
