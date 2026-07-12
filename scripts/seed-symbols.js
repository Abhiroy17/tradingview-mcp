#!/usr/bin/env node
/**
 * Seed the `symbols` table from the fundamentals cache + NSE instrument universe.
 *
 * Populates: canonical, exchange, ticker, sector, industry, name, market_cap, price, asset_class.
 * Uses UPSERT (ON CONFLICT) so it's safe to run multiple times.
 *
 * Usage:
 *   node scripts/seed-symbols.js
 *   npm run db:seed-symbols
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, isDbConfigured, shutdown } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', '.data');
const CACHE_FILE = path.join(DATA_DIR, 'fundamentals-cache.json');
const INSTRUMENTS_FILE = path.join(DATA_DIR, 'upstox-instruments.json');

async function seedSymbols() {
  if (!isDbConfigured()) {
    console.error('DATABASE_URL not set. Cannot seed.');
    process.exit(1);
  }

  // Ensure schema is up to date
  console.log('Running migrations...');
  await runMigrations();

  // Load fundamentals cache (has sector, industry, name, market_cap, price)
  let cache = {};
  if (fs.existsSync(CACHE_FILE)) {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    console.log(`Loaded fundamentals cache: ${Object.keys(cache).length} entries`);
  } else {
    console.warn('No fundamentals cache found. Will seed from instruments only.');
  }

  // Load instrument universe (all NSE symbols)
  let instruments = {};
  if (fs.existsSync(INSTRUMENTS_FILE)) {
    instruments = JSON.parse(fs.readFileSync(INSTRUMENTS_FILE, 'utf-8'));
    console.log(`Loaded instruments: ${Object.keys(instruments).length} entries`);
  }

  // Merge: all NSE symbols from instruments + any extras in cache
  const allSymbols = new Set([
    ...Object.keys(instruments).filter(s => s.startsWith('NSE:')),
    ...Object.keys(cache).filter(s => s.startsWith('NSE:')),
  ]);

  console.log(`Total unique NSE symbols: ${allSymbols.size}`);

  // Batch upsert in chunks of 200
  const BATCH_SIZE = 200;
  const symbols = [...allSymbols];
  let inserted = 0;
  let updated = 0;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const sym of batch) {
      const cached = cache[sym] || {};
      const inst = instruments[sym] || {};
      const ticker = sym.slice(4); // Remove 'NSE:'
      const exchange = 'NSE';
      const sector = cached.sector || null;
      const industry = cached.industry || null;
      const name = cached.name || inst.name || null;
      const marketCap = cached.marketCap || null;
      const price = cached.price || null;
      const assetClass = 'equity';

      values.push(
        `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8})`
      );
      params.push(sym, exchange, ticker, assetClass, sector, industry, name, marketCap, price);
      paramIdx += 9;
    }

    const sql = `
      INSERT INTO symbols (canonical, exchange, ticker, asset_class, sector, industry, name, market_cap, price)
      VALUES ${values.join(', ')}
      ON CONFLICT (canonical) DO UPDATE SET
        sector = COALESCE(EXCLUDED.sector, symbols.sector),
        industry = COALESCE(EXCLUDED.industry, symbols.industry),
        name = COALESCE(EXCLUDED.name, symbols.name),
        market_cap = COALESCE(EXCLUDED.market_cap, symbols.market_cap),
        price = COALESCE(EXCLUDED.price, symbols.price),
        updated_at = NOW()
    `;

    const result = await query(sql, params);
    inserted += result.rowCount;

    process.stdout.write(`\r  Seeded ${Math.min(i + BATCH_SIZE, symbols.length)}/${symbols.length} symbols...`);
  }

  console.log(`\n✓ Seeded ${symbols.length} symbols into database.`);

  // Print sector breakdown
  const sectorResult = await query(`
    SELECT sector, COUNT(*) as count
    FROM symbols
    WHERE exchange = 'NSE' AND active = TRUE AND sector IS NOT NULL
    GROUP BY sector
    ORDER BY count DESC
  `);

  console.log('\nSector breakdown (NSE, active, with sector data):');
  for (const row of sectorResult.rows) {
    console.log(`  ${row.sector}: ${row.count}`);
  }

  const totalWithSector = sectorResult.rows.reduce((s, r) => s + Number(r.count), 0);
  const totalAll = await query(`SELECT COUNT(*) as count FROM symbols WHERE exchange = 'NSE' AND active = TRUE`);
  console.log(`\n  Total with sector: ${totalWithSector}`);
  console.log(`  Total active NSE: ${totalAll.rows[0].count}`);
}

(async () => {
  try {
    await seedSymbols();
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
})();
