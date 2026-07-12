#!/usr/bin/env node
/**
 * Ingest AMFI / AMC monthly portfolio disclosures into `mf_portfolio_holdings`.
 *
 * Usage:
 *   node scripts/ingest-amfi.js <dir> [--period=YYYY-MM-DD]
 *
 * <dir> should contain `.csv` portfolio exports (convert XLSX → CSV first).
 * Requires DATABASE_URL and a prior `node scripts/build-isin-map.js` so ISINs
 * resolve to canonical NSE symbols.
 */

import { ingestAmfiDirectory } from '../src/data/ownership/amfi.js';
import { isDbConfigured, shutdown } from '../src/db/client.js';

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const periodArg = args.find((a) => a.startsWith('--period='));
  const period = periodArg ? periodArg.split('=')[1] : undefined;

  if (!dir) {
    console.error('Usage: node scripts/ingest-amfi.js <dir> [--period=YYYY-MM-DD]');
    process.exitCode = 1;
    return;
  }
  if (!isDbConfigured()) {
    console.error('DATABASE_URL not set.');
    process.exitCode = 1;
    return;
  }

  console.log(`Ingesting AMFI portfolios from ${dir}${period ? ` (period ${period})` : ''} ...`);
  const result = await ingestAmfiDirectory(dir, { period });
  console.log(`OK — parsed ${result.files} file(s), upserted ${result.rows} holding row(s).`);
}

main()
  .catch((e) => { console.error('Failed:', e.message); process.exitCode = 1; })
  .finally(() => shutdown());
