#!/usr/bin/env node
/**
 * Build ISIN → canonical-symbol map for AMFI portfolio mapping.
 *
 * Downloads Upstox's public instrument CSV (same source as upstox-instruments)
 * and extracts { ISIN: 'NSE:TICKER' } plus a __byName reverse index for name
 * fallback. Output: .data/isin-map.json (consumed by src/data/ownership/amfi.js).
 *
 * Run: node scripts/build-isin-map.js   (re-run monthly with AMFI ingestion)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const URL = 'https://assets.upstox.com/market-quote/instruments/exchange/complete.csv.gz';
const DATA = path.resolve(process.cwd(), '.data');
const TMP_GZ = path.join(DATA, '.isin-complete.csv.gz');
const TMP_CSV = path.join(DATA, '.isin-complete.csv');
const OUT = path.join(DATA, 'isin-map.json');

function parseCsvLine(line) {
  const out = [];
  let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(f); f = ''; }
    else f += c;
  }
  out.push(f);
  return out.map((s) => s.trim());
}

async function main() {
  await fs.mkdir(DATA, { recursive: true });
  console.log('Downloading instrument CSV...');
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(TMP_GZ));
  await pipeline((await fs.open(TMP_GZ)).createReadStream(), zlib.createGunzip(), createWriteStream(TMP_CSV));

  const csv = await fs.readFile(TMP_CSV, 'utf8');
  const lines = csv.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const idx = {
    isin: header.indexOf('isin'),
    exchange: header.indexOf('exchange'),
    tradingSymbol: header.indexOf('tradingsymbol'),
    name: header.indexOf('name'),
    expiry: header.indexOf('expiry'),
    strike: header.indexOf('strike'),
  };
  if (idx.isin < 0) throw new Error('No `isin` column in Upstox CSV. Header: ' + header.join(','));

  const map = { __byName: {} };
  let kept = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = parseCsvLine(lines[i]);
    if (c[idx.expiry] || (c[idx.strike] && Number(c[idx.strike]) > 0)) continue;
    const ex = c[idx.exchange];
    let exch = null;
    if (ex === 'NSE_EQ' || ex === 'NSE') exch = 'NSE';
    else if (ex === 'BSE_EQ' || ex === 'BSE') exch = 'BSE';
    if (exch !== 'NSE') continue; // prefer NSE canonical for ownership
    const isin = (c[idx.isin] || '').toUpperCase();
    const ticker = (c[idx.tradingSymbol] || '').toUpperCase();
    const name = (c[idx.name] || '').toUpperCase();
    if (!isin || !ticker) continue;
    const canonical = `NSE:${ticker}`;
    map[isin] = canonical;
    if (name) map.__byName[name] = canonical;
    kept++;
  }

  await fs.writeFile(OUT, JSON.stringify(map));
  await fs.rm(TMP_GZ, { force: true });
  await fs.rm(TMP_CSV, { force: true });
  console.log(`OK — ${kept} ISINs mapped → ${OUT}`);
}

main().catch((e) => { console.error('Failed:', e.message); process.exitCode = 1; });
