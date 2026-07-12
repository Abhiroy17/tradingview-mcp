/**
 * Unit tests for the ownership / news / gap-audit subsystem (pure functions).
 * No network or DB required.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeChanges, smartMoneyScore, institutionalAccumScore,
  promoterConfidenceScore, deriveOwnershipScores,
} from '../src/data/ownership/scores.js';
import { parseRss } from '../src/data/news/index.js';
import { parseCsv } from '../src/data/ownership/amfi.js';
import { auditDataGaps } from '../src/engine/multibagger/data-gaps.js';

test('computeChanges: QoQ percentage-point deltas', () => {
  const curr = { promoter: 55, fii: 20, dii: 10, mutualFund: 8 };
  const prev = { promoter: 54, fii: 18, dii: 11, mutualFund: 6 };
  const ch = computeChanges(curr, prev);
  assert.equal(ch.promoterChange, 1);
  assert.equal(ch.fiiChange, 2);
  assert.equal(ch.diiChange, -1);
  assert.equal(ch.mfChange, 2);
  assert.equal(ch.hniChange, null); // missing on both → null
});

test('smartMoneyScore: rewards high institutional footprint + accumulation', () => {
  const high = smartMoneyScore(
    { fii: 25, dii: 10, mutualFund: 8, insurance: 2 },
    { fiiChange: 1, diiChange: 0.5, mfChange: 0.5 });
  const low = smartMoneyScore(
    { fii: 2, dii: 1, mutualFund: 0, insurance: 0 },
    { fiiChange: -1, diiChange: 0, mfChange: 0 });
  assert.ok(high > low);
  assert.ok(high >= 0 && high <= 100);
});

test('institutionalAccumScore: rising inst. holdings score above neutral', () => {
  const rising = institutionalAccumScore([
    { fii: 10, dii: 5, mutualFund: 3 },
    { fii: 12, dii: 6, mutualFund: 4 },
    { fii: 14, dii: 7, mutualFund: 5 },
  ]);
  const falling = institutionalAccumScore([
    { fii: 14, dii: 7, mutualFund: 5 },
    { fii: 12, dii: 6, mutualFund: 4 },
    { fii: 10, dii: 5, mutualFund: 3 },
  ]);
  assert.ok(rising > 50);
  assert.ok(falling < 50);
});

test('institutionalAccumScore: neutral 50 when insufficient history', () => {
  assert.equal(institutionalAccumScore([{ fii: 10 }]), 50);
  assert.equal(institutionalAccumScore([]), 50);
});

test('promoterConfidenceScore: pledge penalizes, high stake rewards', () => {
  const clean = promoterConfidenceScore({ promoter: 60, pledgedPct: 0 }, { promoterChange: 0 });
  const pledged = promoterConfidenceScore({ promoter: 60, pledgedPct: 25 }, { promoterChange: 0 });
  assert.ok(clean > pledged);
});

test('deriveOwnershipScores: end-to-end shape + trend label', () => {
  const history = [
    { promoter: 55, fii: 10, dii: 5, mutualFund: 3 },
    { promoter: 55, fii: 12, dii: 6, mutualFund: 4 },
    { promoter: 56, fii: 15, dii: 8, mutualFund: 6 },
  ];
  const out = deriveOwnershipScores(history[history.length - 1], history);
  assert.ok('smartMoneyScore' in out);
  assert.ok('institutionalAccumScore' in out);
  assert.ok('promoterConfidenceScore' in out);
  assert.equal(out.institutionalTrend, 'accumulating');
  assert.equal(out.changes.fiiChange, 3); // 15 - 12
});

test('parseRss: extracts items from Google News RSS', () => {
  const xml = `<rss><channel>
    <item><title><![CDATA[TAC Infosec Q1 results beat - Moneycontrol]]></title>
      <link>https://example.com/a</link>
      <pubDate>Sat, 11 Jul 2026 08:00:00 GMT</pubDate>
      <source url="x">Moneycontrol</source></item>
    <item><title>DMART revenue up 15% - Economic Times</title>
      <link>https://example.com/b</link>
      <pubDate>Fri, 10 Jul 2026 08:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'TAC Infosec Q1 results beat');
  assert.equal(items[0].source, 'Moneycontrol');
  assert.equal(items[1].source, 'Economic Times'); // derived from title suffix
  assert.ok(items[0].publishedAt.startsWith('2026-07-11'));
});

test('parseCsv: handles quoted fields with commas', () => {
  const rows = parseCsv('a,b,c\n"x,1","y",z\n');
  assert.deepEqual(rows[0], ['a', 'b', 'c']);
  assert.deepEqual(rows[1], ['x,1', 'y', 'z']);
});

test('auditDataGaps: computes completeness and lists missing fields', () => {
  const snap = {
    quarterlySeries: [{}], annualSeries: [{}], revenueGrowth: 20, earningsGrowth: 15,
    ebitdaMargin: 25, roe: 18, roce: 22, pe: 30, pb: 4, debtToEquity: 10,
    freeCashflow: 100, dividendYield: null, estimates: [{}],
  };
  const ownership = {
    promoterHolding: 55, fiiHolding: 20, diiHolding: 10, mutualFundHolding: 8,
    hniHolding: null, pledgedPct: 0, institutionalTrend: 'stable',
    mutualFundHoldings: { count: 12 }, superstars: [],
  };
  const news = { stock: [{}], sector: [{}] };
  const audit = auditDataGaps(snap, ownership, news);
  assert.ok(audit.completenessPct > 50);
  assert.equal(audit.total, audit.checks.length);
  assert.ok(Array.isArray(audit.missing));
  assert.ok(audit.notCovered.length > 0);
  // dividend yield is null → should appear in missing
  assert.ok(audit.missing.some((m) => m.field === 'Dividend yield'));
});
