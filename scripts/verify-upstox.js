/**
 * Phase 0 verification: Upstox token + instrument map + sample fetch.
 * Run via:  node scripts/verify-upstox.js
 */
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs/promises';

async function main() {
  console.log('=== Upstox Verification ===\n');

  // 1. Token check
  const tokRaw = process.env.UPSTOX_ACCESS_TOKEN || '';
  const tok = tokRaw.trim();
  if (!tok) {
    console.log('❌ UPSTOX_ACCESS_TOKEN missing in .env');
    process.exit(1);
  }
  if (tokRaw !== tok) {
    console.log('⚠️  Token has leading/trailing whitespace — needs .trim() in reader');
  }

  let payload;
  try {
    const parts = tok.split('.');
    if (parts.length !== 3) throw new Error('Not a JWT');
    payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  } catch (err) {
    console.log('❌ Token is not a valid JWT:', err.message);
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const expISO = new Date(payload.exp * 1000).toISOString();
  console.log(`✅ Token loaded — sub=${payload.sub}, exp=${expISO}`);
  if (payload.exp <= now) {
    console.log('❌ Token expired');
    process.exit(1);
  }

  // 2. Instrument map
  const mapPath = path.resolve(process.cwd(), '.data', 'upstox-instruments.json');
  let map = {};
  try {
    const raw = await fs.readFile(mapPath, 'utf8');
    map = JSON.parse(raw);
    const count = Object.keys(map).length;
    console.log(`✅ Instrument map: ${count} entries at .data/upstox-instruments.json`);
    if (count === 0) {
      console.log('⚠️  Map is empty — run `npm run upstox:instruments` to populate');
    }
  } catch (err) {
    console.log('❌ Instrument map missing or unreadable:', err.message);
    console.log('   → Run `npm run upstox:instruments` to generate');
    process.exit(1);
  }

  // 3. Sample fetch — NSE:RELIANCE 5m × 14d
  console.log('\n--- Sample fetch: NSE:RELIANCE 5m × last 14 days ---');
  const upstox = await import('../src/data/providers/upstox.js');
  try {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - 14 * 86400;
    const t0 = Date.now();
    const result = await upstox.getHistorical({
      symbol: 'NSE:RELIANCE',
      timeframe: '5m',
      from: fromSec,
      to: toSec,
    });
    const elapsed = Date.now() - t0;
    console.log(`✅ Fetched ${result.bars.length} bars in ${elapsed}ms`);
    if (result.bars.length > 0) {
      const first = new Date(result.bars[0].time * 1000).toISOString();
      const last = new Date(result.bars[result.bars.length - 1].time * 1000).toISOString();
      console.log(`   range: ${first} → ${last}`);
      console.log(`   first bar: ${JSON.stringify(result.bars[0])}`);
    }
  } catch (err) {
    console.log('❌ Sample fetch failed:', err.message);
    process.exit(1);
  }

  // 4. Sample fetch — 5m × 6M (the maximum we'll use)
  console.log('\n--- Sample fetch: NSE:RELIANCE 5m × 6M (183d) ---');
  try {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - 183 * 86400;
    const t0 = Date.now();
    const result = await upstox.getHistorical({
      symbol: 'NSE:RELIANCE',
      timeframe: '5m',
      from: fromSec,
      to: toSec,
    });
    const elapsed = Date.now() - t0;
    console.log(`✅ Fetched ${result.bars.length} bars in ${elapsed}ms`);
  } catch (err) {
    console.log('❌ 6M fetch failed:', err.message);
  }

  // 5. Sample fetch — 4h × 6M (Upstox aggregates from 1h)
  console.log('\n--- Sample fetch: NSE:RELIANCE 4h × 6M (183d) ---');
  try {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - 183 * 86400;
    const result = await upstox.getHistorical({
      symbol: 'NSE:RELIANCE',
      timeframe: '4h',
      from: fromSec,
      to: toSec,
    });
    console.log(`✅ Fetched ${result.bars.length} 4h bars`);
  } catch (err) {
    console.log('❌ 4h fetch failed:', err.message);
  }

  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
