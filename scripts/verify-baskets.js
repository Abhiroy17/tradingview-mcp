#!/usr/bin/env node
/**
 * verify-baskets.js — Resolve + liquidity-check every symbol in src/engine/baskets.js.
 *
 * Cross-symbol tuning is only as good as its baskets. Before a tuning batch,
 * run this to confirm each ticker:
 *   1. resolves through the data router (Upstox → Yahoo fallback),
 *   2. returns enough daily history,
 *   3. clears basic liquidity gates (price ≥ ₹100, avg turnover ≥ ₹2 Cr) so it
 *      won't be silently skipped by strategy filters.
 *
 * Symbols that fail are printed under "PRUNE" so they can be removed from the
 * basket definitions. Nothing is mutated — this is a read-only report.
 *
 * Usage:
 *   node scripts/verify-baskets.js [--basket <name>] [--years 1] [--min-bars 150]
 */
import { BASKETS, BASKET_META, getBasket, listBaskets } from '../src/engine/baskets.js';
import { getHistorical } from '../src/data/index.js';

const MIN_PRICE        = 100;        // ₹ — matches ibs_* minPrice filter
const MIN_TURNOVER_CR  = 2;          // ₹ Cr avg daily turnover
const TURNOVER_SAMPLE  = 60;         // last N bars for avg turnover

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { basket: null, years: 1, minBars: 150 };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].replace(/^--/, '');
    const key = flag === 'min-bars' ? 'minBars' : flag;
    if (key in opts) opts[key] = isNaN(Number(args[i + 1])) ? args[++i] : Number(args[++i]);
  }
  return opts;
}

async function checkSymbol(symbol, { from, to, minBars }) {
  try {
    const res = await getHistorical({ symbol, timeframe: '1D', from, to });
    const bars = res?.bars ?? [];
    if (!bars.length) return { symbol, ok: false, reason: 'no_bars' };

    const lastClose = bars[bars.length - 1].close;
    const sample = bars.slice(-TURNOVER_SAMPLE);
    const avgTurnoverCr =
      sample.reduce((s, b) => s + b.close * (b.volume ?? 0), 0) / sample.length / 1e7;

    const issues = [];
    if (bars.length < minBars)            issues.push(`history(${bars.length}b)`);
    if (lastClose < MIN_PRICE)            issues.push(`price(₹${lastClose.toFixed(0)})`);
    if (avgTurnoverCr < MIN_TURNOVER_CR)  issues.push(`turnover(₹${avgTurnoverCr.toFixed(1)}Cr)`);

    return {
      symbol,
      ok: issues.length === 0,
      bars: bars.length,
      lastClose,
      turnoverCr: avgTurnoverCr,
      reason: issues.join(', '),
    };
  } catch (e) {
    return { symbol, ok: false, reason: `error: ${e.message}` };
  }
}

async function main() {
  const { basket, years, minBars } = parseArgs();
  const to = Math.floor(Date.now() / 1000);
  const from = to - years * 365 * 86400;

  const targets = basket ? { [basket]: getBasket(basket) } : BASKETS;
  if (basket && !BASKETS[basket]) {
    console.error(`Unknown basket '${basket}'. Available: ${listBaskets().join(', ')}`);
    process.exit(1);
  }

  console.log(`\nVerifying baskets (timeframe=1D, years=${years}, minBars=${minBars})`);
  console.log(`Gates: price ≥ ₹${MIN_PRICE}, avg turnover ≥ ₹${MIN_TURNOVER_CR} Cr\n`);

  // Dedupe symbols across baskets so we fetch each only once.
  const allSyms = [...new Set(Object.values(targets).flat())];
  const cache = new Map();
  let done = 0;
  for (const sym of allSyms) {
    cache.set(sym, await checkSymbol(sym, { from, to, minBars }));
    process.stdout.write(`\r  checked ${++done}/${allSyms.length}`);
  }
  console.log('\n');

  const prune = [];
  for (const [name, syms] of Object.entries(targets)) {
    const meta = BASKET_META[name];
    console.log(`── ${name}${meta ? `  (${meta.label})` : ''} ──`);
    for (const sym of syms) {
      const r = cache.get(sym);
      const tag = r.ok ? 'OK  ' : 'FAIL';
      const detail = r.ok
        ? `${r.bars}b  ₹${r.lastClose.toFixed(0)}  ₹${r.turnoverCr.toFixed(0)}Cr`
        : r.reason;
      console.log(`  [${tag}] ${sym.padEnd(18)} ${detail}`);
      if (!r.ok) prune.push({ name, sym, reason: r.reason });
    }
    console.log();
  }

  if (prune.length) {
    console.log('── PRUNE (remove or replace these in baskets.js) ──');
    for (const p of prune) console.log(`  ${p.name.padEnd(12)} ${p.sym.padEnd(18)} ${p.reason}`);
    console.log(`\n${prune.length} symbol(s) flagged.`);
  } else {
    console.log('All basket symbols resolved and passed liquidity gates. ✓');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
