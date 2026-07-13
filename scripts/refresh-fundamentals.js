#!/usr/bin/env node
/**
 * Refresh fundamentals data in the symbols table.
 *
 * Fetches Yahoo fundamentals for all NSE symbols and stores key screening
 * fields (market_cap, price, sector, industry, PE, ROE, ROCE, D/E, growth, etc.)
 * directly in the DB. This enables the screener to do fast DB-level pre-filtering
 * without calling Yahoo for each stock.
 *
 * Modes:
 *   --full       Refresh ALL symbols (default on first run, ~2400 symbols)
 *   --stale      Only refresh symbols older than --age hours (default: 24)
 *   --batch N    Process N symbols per run (default: all)
 *   --age H      Stale threshold in hours (default: 24)
 *   --concurrency N  Parallel Yahoo requests (default: 3)
 *
 * Usage:
 *   node scripts/refresh-fundamentals.js              # full refresh
 *   node scripts/refresh-fundamentals.js --stale      # only stale entries
 *   node scripts/refresh-fundamentals.js --batch 200  # first 200 stale
 *
 * Intended to be run:
 *   - Once for initial seeding (takes ~20-40 min for 2400 symbols)
 *   - Periodically via cron or the dashboard scheduler (stale mode)
 */

import { query, isDbConfigured, shutdown } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadNSEUniverse } from '../src/data/fundamentals/universe-filter.js';
import { getFundamentals } from '../src/data/fundamentals/index.js';

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isStale = args.includes('--stale');
const batchIdx = args.indexOf('--batch');
const batchSize = batchIdx >= 0 ? parseInt(args[batchIdx + 1]) || 500 : null;
const ageIdx = args.indexOf('--age');
const staleHours = ageIdx >= 0 ? parseInt(args[ageIdx + 1]) || 24 : 24;
const concIdx = args.indexOf('--concurrency');
const concurrency = concIdx >= 0 ? parseInt(args[concIdx + 1]) || 3 : 3;

async function main() {
  if (!isDbConfigured()) {
    console.error('DATABASE_URL not set. Cannot refresh.');
    process.exit(1);
  }

  console.log('Running migrations...');
  await runMigrations();

  // ── Determine which symbols to refresh ──────────────────────────────
  let symbolsToRefresh;

  if (isStale) {
    // Only symbols whose data_refreshed_at is older than threshold (or null)
    const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
    const result = await query(`
      SELECT canonical FROM symbols
      WHERE exchange = 'NSE' AND active = TRUE
        AND (data_refreshed_at IS NULL OR data_refreshed_at < $1)
      ORDER BY data_refreshed_at ASC NULLS FIRST
      ${batchSize ? `LIMIT ${batchSize}` : ''}
    `, [cutoff]);
    symbolsToRefresh = result.rows.map(r => r.canonical);
    console.log(`Stale mode: ${symbolsToRefresh.length} symbols older than ${staleHours}h`);
  } else {
    // Full mode: get all symbols from DB, or seed from universe if DB is empty
    const existing = await query(`SELECT COUNT(*) as c FROM symbols WHERE exchange = 'NSE'`);
    if (parseInt(existing.rows[0].c) < 10) {
      // DB is nearly empty — seed symbols first
      console.log('DB has few symbols. Loading NSE universe to seed...');
      const universe = loadNSEUniverse();
      await seedMinimalSymbols(universe);
    }

    const result = await query(`
      SELECT canonical FROM symbols
      WHERE exchange = 'NSE' AND active = TRUE
      ORDER BY data_refreshed_at ASC NULLS FIRST
      ${batchSize ? `LIMIT ${batchSize}` : ''}
    `);
    symbolsToRefresh = result.rows.map(r => r.canonical);
    console.log(`Full mode: ${symbolsToRefresh.length} symbols to refresh`);
  }

  if (symbolsToRefresh.length === 0) {
    console.log('Nothing to refresh. All symbols are up-to-date.');
    await shutdown();
    return;
  }

  // ── Fetch and persist in batches ────────────────────────────────────
  let success = 0, failed = 0, skipped = 0;
  const startTime = Date.now();
  const UPSERT_BATCH = 50; // DB writes in chunks

  const queue = [...symbolsToRefresh];
  const results = [];
  let backoffMs = 300;
  const maxBackoff = 8000;

  // Worker pool
  async function worker() {
    while (queue.length > 0) {
      const sym = queue.shift();
      if (!sym) break;

      try {
        await sleep(backoffMs);
        const snap = await getFundamentals(sym, { forceRefresh: false }); // use cache if fresh

        if (!snap || (!snap.price && !snap.name)) {
          skipped++;
          continue;
        }

        results.push({ symbol: sym, snap });
        success++;
        backoffMs = Math.max(200, backoffMs * 0.92);
      } catch (e) {
        failed++;
        const msg = e.message || '';
        if (msg.includes('429') || msg.includes('Too Many') || msg.includes('rate')) {
          backoffMs = Math.min(maxBackoff, backoffMs * 2.5);
          queue.push(sym); // retry
          failed--;
        }
      }

      // Progress
      const done = success + failed + skipped;
      if (done % 50 === 0 || done === symbolsToRefresh.length) {
        const pct = Math.round(done / symbolsToRefresh.length * 100);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        process.stdout.write(`\r  [${pct}%] ${done}/${symbolsToRefresh.length} — ${success} ok, ${failed} err, ${skipped} skip (${elapsed}s, backoff=${Math.round(backoffMs)}ms)`);
      }

      // Batch-write to DB periodically
      if (results.length >= UPSERT_BATCH) {
        await upsertBatch(results.splice(0, UPSERT_BATCH));
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
  await Promise.all(workers);

  // Final flush
  if (results.length > 0) {
    await upsertBatch(results);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n\n✓ Refresh complete in ${elapsed}s: ${success} updated, ${failed} failed, ${skipped} skipped`);

  // Print coverage stats
  const coverage = await query(`
    SELECT
      COUNT(*) FILTER (WHERE data_refreshed_at IS NOT NULL) as refreshed,
      COUNT(*) FILTER (WHERE market_cap IS NOT NULL) as has_mcap,
      COUNT(*) FILTER (WHERE sector IS NOT NULL) as has_sector,
      COUNT(*) FILTER (WHERE roe IS NOT NULL) as has_roe,
      COUNT(*) as total
    FROM symbols WHERE exchange = 'NSE' AND active = TRUE
  `);
  const s = coverage.rows[0];
  console.log(`\nDB coverage: ${s.refreshed}/${s.total} refreshed, ${s.has_mcap} with mcap, ${s.has_sector} with sector, ${s.has_roe} with ROE`);

  await shutdown();
}

/**
 * Batch upsert fundamentals into symbols table.
 */
async function upsertBatch(items) {
  if (items.length === 0) return;

  const values = [];
  const params = [];
  let idx = 1;

  for (const { symbol, snap } of items) {
    values.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6}, $${idx+7}, $${idx+8}, $${idx+9}, $${idx+10}, $${idx+11}, $${idx+12}, $${idx+13}, $${idx+14}, $${idx+15}, $${idx+16}, $${idx+17}, $${idx+18}, $${idx+19}, $${idx+20}, $${idx+21}, $${idx+22}, NOW())`);
    params.push(
      symbol,                                          // $1: canonical
      snap.sector || null,                             // $2: sector
      snap.industry || null,                           // $3: industry
      snap.name || null,                               // $4: name
      snap.marketCap || null,                          // $5: market_cap
      snap.price || null,                              // $6: price
      snap.pe || null,                                 // $7: pe
      snap.pb || null,                                 // $8: pb
      snap.peg || null,                                // $9: peg
      snap.evToEbitda || null,                         // $10: ev_to_ebitda
      snap.roe || null,                                // $11: roe
      snap.roce || null,                               // $12: roce
      snap.operatingMargin || null,                    // $13: operating_margin
      snap.netMargin || null,                          // $14: net_margin
      snap.revenueCAGR3y || null,                      // $15: revenue_cagr_3y
      snap.epsCAGR3y || null,                          // $16: eps_cagr_3y
      snap.revenueQoQ || null,                         // $17: revenue_growth_qoq
      snap.epsQtrYoY || null,                          // $18: eps_growth_yoy
      snap.debtToEquity || null,                       // $19: debt_to_equity
      snap.currentRatio || null,                       // $20: current_ratio
      snap.interestCoverage || null,                   // $21: interest_coverage
      snap.fiftyTwoWeekHigh || null,                   // $22: fifty_two_week_high
    );
    idx += 22;
  }

  const sql = `
    INSERT INTO symbols (
      canonical, sector, industry, name, market_cap, price,
      pe, pb, peg, ev_to_ebitda,
      roe, roce, operating_margin, net_margin,
      revenue_cagr_3y, eps_cagr_3y, revenue_growth_qoq, eps_growth_yoy,
      debt_to_equity, current_ratio, interest_coverage,
      fifty_two_week_high,
      data_refreshed_at
    ) VALUES ${values.join(', ')}
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
      data_refreshed_at = NOW(),
      updated_at = NOW()
  `;

  try {
    await query(sql, params);
  } catch (e) {
    console.error(`\n[db] upsert batch failed: ${e.message}`);
  }
}

/**
 * Seed minimal symbol rows (canonical + ticker + exchange) for universe
 * so they can be targeted by the refresh.
 */
async function seedMinimalSymbols(symbols) {
  const BATCH = 500;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let idx = 1;

    for (const sym of batch) {
      const ticker = sym.slice(4);
      values.push(`($${idx}, 'NSE', $${idx+1}, 'equity')`);
      params.push(sym, ticker);
      idx += 2;
    }

    await query(`
      INSERT INTO symbols (canonical, exchange, ticker, asset_class)
      VALUES ${values.join(', ')}
      ON CONFLICT (canonical) DO NOTHING
    `, params);
  }
  console.log(`  Seeded ${symbols.length} minimal symbol rows`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
