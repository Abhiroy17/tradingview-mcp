#!/usr/bin/env node
/**
 * Download Upstox's complete instrument list and build a symbol → instrument-key map.
 *
 * Source: https://assets.upstox.com/market-quote/instruments/exchange/complete.csv.gz
 * (free public asset, no auth needed)
 *
 * Output: .data/upstox-instruments.json — map keyed by "NSE:TICKER" / "BSE:TICKER".
 *
 * Run once at setup, then re-run weekly (or on listing changes).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const URL = 'https://assets.upstox.com/market-quote/instruments/exchange/complete.csv.gz';
const TMP_GZ = path.resolve(process.cwd(), '.data', '.upstox-complete.csv.gz');
const TMP_CSV = path.resolve(process.cwd(), '.data', '.upstox-complete.csv');
const OUT = path.resolve(process.cwd(), '.data', 'upstox-instruments.json');

async function download() {
  console.log('Downloading', URL);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await fs.mkdir(path.dirname(TMP_GZ), { recursive: true });
  const ws = createWriteStream(TMP_GZ);
  await pipeline(Readable.fromWeb(res.body), ws);
  console.log('  saved', TMP_GZ);
}

async function gunzip() {
  console.log('Decompressing...');
  await pipeline(
    (await fs.open(TMP_GZ)).createReadStream(),
    zlib.createGunzip(),
    createWriteStream(TMP_CSV),
  );
}

async function parse() {
  console.log('Parsing CSV...');
  const csv = await fs.readFile(TMP_CSV, 'utf8');
  const lines = csv.split(/\r?\n/);
  // Header may be quoted: "instrument_key","exchange_token",...  or unquoted: instrument_key,exchange_token,...
  const header = parseCsvLine(lines[0]);

  // Column indices — schema as of June 2026 changed: `segment` removed; the
  // `exchange` column now holds segment-like values (e.g. NSE_EQ, BSE_EQ, NSE_FO).
  const idx = {
    instrumentKey: header.indexOf('instrument_key'),
    exchange: header.indexOf('exchange'),
    tradingSymbol: header.indexOf('tradingsymbol'),
    name: header.indexOf('name'),
    instrumentType: header.indexOf('instrument_type'),
    lotSize: header.indexOf('lot_size'),
    tickSize: header.indexOf('tick_size'),
    expiry: header.indexOf('expiry'),
    strike: header.indexOf('strike'),
  };

  if (idx.instrumentKey < 0 || idx.tradingSymbol < 0 || idx.exchange < 0) {
    throw new Error('Unexpected CSV format from Upstox. Header was: ' + header.join(','));
  }

  const map = {};
  let kept = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = parseCsvLine(line);
    const exchangeRaw = cols[idx.exchange];
    const instrumentType = (cols[idx.instrumentType] || '').toUpperCase();
    const expiry = cols[idx.expiry] || '';
    const strike = cols[idx.strike] || '';

    // Keep only NSE/BSE equity rows. Skip futures/options (have non-empty expiry or strike).
    if (expiry || (strike && Number(strike) > 0)) continue;
    // Skip non-equity instrument types (warrants, indices, ETFs handled separately if needed)
    if (instrumentType && !['EQ', 'EQUITY', ''].includes(instrumentType)) continue;

    let canonicalExchange = null;
    if (exchangeRaw === 'NSE_EQ' || exchangeRaw === 'NSE') canonicalExchange = 'NSE';
    else if (exchangeRaw === 'BSE_EQ' || exchangeRaw === 'BSE') canonicalExchange = 'BSE';
    if (!canonicalExchange) continue;

    const ticker = cols[idx.tradingSymbol]?.toUpperCase();
    if (!ticker) continue;

    const key = `${canonicalExchange}:${ticker}`;
    if (map[key]) continue; // first-wins

    map[key] = {
      instrumentKey: cols[idx.instrumentKey],
      name: cols[idx.name] || ticker,
      type: 'equity',
      lotSize: Number(cols[idx.lotSize]) || 1,
      tickSize: Number(cols[idx.tickSize]) || 0.05,
    };
    kept++;
  }

  console.log(`Mapped ${kept} NSE/BSE equity symbols.`);
  if (kept === 0) {
    throw new Error('No equity rows mapped — check CSV format. Header: ' + header.join(','));
  }
  await fs.writeFile(OUT, JSON.stringify(map, null, 0), 'utf8');
  console.log('  wrote', OUT);
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

async function cleanup() {
  for (const f of [TMP_GZ, TMP_CSV]) {
    try { await fs.unlink(f); } catch { /* ignore */ }
  }
}

(async () => {
  try {
    await download();
    await gunzip();
    await parse();
    await cleanup();
    console.log('\nDone.');
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exit(1);
  }
})();
