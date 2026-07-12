#!/usr/bin/env node
/**
 * Refresh ownership (shareholding) data into Postgres for one or many symbols.
 *
 * Usage:
 *   node scripts/refresh-ownership.js NSE:DMART NSE:RELIANCE
 *   node scripts/refresh-ownership.js --watchlist        (all watchlist symbols)
 *
 * Shareholding updates quarterly, so schedule this weekly (cron/CI). Fetches
 * NSE official pattern (+ optional Trendlyne if SHAREHOLDING_SCRAPE=1), computes
 * ownership scores, and upserts into `stock_shareholding`.
 */

import { refreshOwnership } from '../src/data/ownership/index.js';
import { isDbConfigured, query, shutdown } from '../src/db/client.js';

async function resolveSymbols(args) {
  if (args.includes('--watchlist')) {
    if (!isDbConfigured()) throw new Error('DATABASE_URL required for --watchlist');
    const r = await query(`SELECT symbol FROM watchlist ORDER BY symbol`);
    return r.rows.map((x) => x.symbol);
  }
  return args.filter((a) => !a.startsWith('--'));
}

async function main() {
  const args = process.argv.slice(2);
  const symbols = await resolveSymbols(args);
  if (!symbols.length) {
    console.error('Usage: node scripts/refresh-ownership.js NSE:TICKER [...] | --watchlist');
    process.exitCode = 1;
    return;
  }

  let ok = 0, fail = 0;
  for (const sym of symbols) {
    try {
      const res = await refreshOwnership(sym);
      if (res) {
        ok++;
        console.log(`✓ ${sym} — promoter ${fmt(res.promoterHolding)}%, FII ${fmt(res.fiiHolding)}%, DII ${fmt(res.diiHolding)}%, smartMoney ${fmt(res.smartMoneyScore)}`);
      } else {
        fail++;
        console.log(`· ${sym} — no shareholding data`);
      }
    } catch (e) {
      fail++;
      console.log(`✗ ${sym} — ${e.message}`);
    }
    await sleep(600); // be polite to NSE
  }
  console.log(`\nDone. ${ok} updated, ${fail} skipped/failed.`);
}

const fmt = (n) => (n == null ? 'n/a' : Number(n).toFixed(1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main()
  .catch((e) => { console.error('Failed:', e.message); process.exitCode = 1; })
  .finally(() => shutdown());
