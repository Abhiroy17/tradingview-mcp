/**
 * Ownership data layer — orchestrator.
 *
 * Merges official NSE shareholding (primary) with optional Trendlyne HNI
 * enrichment (flag-gated), computes ownership scores, persists per-quarter rows
 * to Postgres (`stock_shareholding`), and serves a report-ready ownership
 * object. Reads prefer the DB (cheap) and only hit the network when data is
 * stale or missing — keeping the request path fast.
 */

import { query, isDbConfigured } from '../../db/client.js';
import { fetchNseShareholding } from './nse-shareholding.js';
import { fetchTrendlyneOwnership, trendlyneEnabled } from './trendlyne.js';
import { getMfHoldingsForSymbol } from './amfi.js';
import { deriveOwnershipScores } from './scores.js';

const FRESH_MS = 7 * 24 * 60 * 60 * 1000; // shareholding updates quarterly → 7d fresh

/**
 * Get report-ready ownership for a symbol.
 * @param {string} symbol — canonical 'NSE:TICKER'
 * @param {object} [opts] { forceRefresh }
 * @returns {Promise<object>} ownership block (never throws)
 */
export async function getOwnership(symbol, opts = {}) {
  const empty = emptyOwnership();
  if (!symbol) return empty;

  // 1) Serve fresh DB rows unless forced.
  if (!opts.forceRefresh && isDbConfigured()) {
    const cached = await readFromDb(symbol);
    if (cached && cached.updatedAt && Date.now() - new Date(cached.updatedAt).getTime() < FRESH_MS) {
      return await enrichWithMf(symbol, cached);
    }
  }

  // 2) Refresh from network (best-effort).
  try {
    const refreshed = await refreshOwnership(symbol);
    if (refreshed) return await enrichWithMf(symbol, refreshed);
  } catch (e) {
    if (process.env.OWNERSHIP_DEBUG) console.error(`[ownership] refresh ${symbol}: ${e.message}`);
  }

  // 3) Fall back to stale DB, else empty.
  if (isDbConfigured()) {
    const stale = await readFromDb(symbol);
    if (stale) return await enrichWithMf(symbol, { ...stale, stale: true });
  }
  return empty;
}

/**
 * Fetch from sources, compute scores, persist, and return report block.
 */
export async function refreshOwnership(symbol) {
  const history = await fetchNseShareholding(symbol); // chronological, oldest→newest
  if (!history || !history.length) return null;

  // Optional HNI enrichment on the latest quarter.
  let trendlyne = null;
  if (trendlyneEnabled()) trendlyne = await fetchTrendlyneOwnership(symbol);

  const latest = { ...history[history.length - 1] };
  if (trendlyne) {
    if (latest.hni == null && trendlyne.hni != null) latest.hni = trendlyne.hni;
    latest.superstars = trendlyne.superstars || [];
    latest.source = latest.source === 'nse' ? 'merged' : latest.source;
  }
  history[history.length - 1] = latest;

  const scored = deriveOwnershipScores(latest, history);

  const record = {
    symbol,
    quarter: latest.quarter,
    holdings: pickBuckets(latest),
    pledgedPct: latest.pledgedPct ?? null,
    changes: scored.changes,
    smartMoneyScore: scored.smartMoneyScore,
    institutionalAccumScore: scored.institutionalAccumScore,
    promoterConfidenceScore: scored.promoterConfidenceScore,
    institutionalTrend: scored.institutionalTrend,
    superstars: latest.superstars || [],
    source: latest.source || 'nse',
    history: history.map((h) => ({ quarter: h.quarter, ...pickBuckets(h) })),
    updatedAt: new Date().toISOString(),
  };

  if (isDbConfigured()) await persistOwnership(record).catch((e) => {
    if (process.env.OWNERSHIP_DEBUG) console.error(`[ownership] persist ${symbol}: ${e.message}`);
  });

  return toReportBlock(record);
}

// ── DB read/write ───────────────────────────────────────────────────────────

async function persistOwnership(rec) {
  const h = rec.holdings;
  const c = rec.changes || {};
  await query(
    `INSERT INTO stock_shareholding
       (symbol, quarter, promoter, fii, dii, mutual_fund, insurance, hni, retail, govt,
        foreign_individual, others, pledged_pct,
        promoter_change, fii_change, dii_change, mf_change, insurance_change, hni_change, retail_change,
        smart_money_score, institutional_accum_score, promoter_confidence_score,
        top_buyers, top_sellers, source, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,NOW())
     ON CONFLICT (symbol, quarter) DO UPDATE SET
       promoter=EXCLUDED.promoter, fii=EXCLUDED.fii, dii=EXCLUDED.dii,
       mutual_fund=EXCLUDED.mutual_fund, insurance=EXCLUDED.insurance, hni=EXCLUDED.hni,
       retail=EXCLUDED.retail, govt=EXCLUDED.govt, foreign_individual=EXCLUDED.foreign_individual,
       others=EXCLUDED.others, pledged_pct=EXCLUDED.pledged_pct,
       promoter_change=EXCLUDED.promoter_change, fii_change=EXCLUDED.fii_change,
       dii_change=EXCLUDED.dii_change, mf_change=EXCLUDED.mf_change,
       insurance_change=EXCLUDED.insurance_change, hni_change=EXCLUDED.hni_change,
       retail_change=EXCLUDED.retail_change,
       smart_money_score=EXCLUDED.smart_money_score,
       institutional_accum_score=EXCLUDED.institutional_accum_score,
       promoter_confidence_score=EXCLUDED.promoter_confidence_score,
       top_buyers=EXCLUDED.top_buyers, top_sellers=EXCLUDED.top_sellers,
       source=EXCLUDED.source, updated_at=NOW()`,
    [
      rec.symbol, rec.quarter, h.promoter, h.fii, h.dii, h.mutualFund, h.insurance, h.hni,
      h.retail, h.govt, h.foreignIndividual, h.others, rec.pledgedPct,
      c.promoterChange, c.fiiChange, c.diiChange, c.mfChange, c.insuranceChange, c.hniChange, c.retailChange,
      rec.smartMoneyScore, rec.institutionalAccumScore, rec.promoterConfidenceScore,
      JSON.stringify(rec.superstars || []), JSON.stringify([]), rec.source,
    ],
  );
}

async function readFromDb(symbol) {
  try {
    const r = await query(
      `SELECT * FROM stock_shareholding WHERE symbol=$1 ORDER BY quarter DESC LIMIT 8`,
      [symbol],
    );
    if (!r.rows.length) return null;
    const latest = r.rows[0];
    const history = [...r.rows].reverse().map(rowToBuckets);
    return toReportBlock({
      symbol,
      quarter: iso(latest.quarter),
      holdings: rowToBuckets(latest),
      pledgedPct: numOrNull(latest.pledged_pct),
      changes: {
        promoterChange: numOrNull(latest.promoter_change),
        fiiChange: numOrNull(latest.fii_change),
        diiChange: numOrNull(latest.dii_change),
        mfChange: numOrNull(latest.mf_change),
        insuranceChange: numOrNull(latest.insurance_change),
        hniChange: numOrNull(latest.hni_change),
        retailChange: numOrNull(latest.retail_change),
      },
      smartMoneyScore: numOrNull(latest.smart_money_score),
      institutionalAccumScore: numOrNull(latest.institutional_accum_score),
      promoterConfidenceScore: numOrNull(latest.promoter_confidence_score),
      institutionalTrend:
        numOrNull(latest.institutional_accum_score) >= 65 ? 'accumulating'
          : numOrNull(latest.institutional_accum_score) <= 35 ? 'distributing' : 'stable',
      superstars: safeJson(latest.top_buyers) || [],
      source: latest.source,
      history: history.map((b, i) => ({ quarter: iso(r.rows[r.rows.length - 1 - i]?.quarter), ...b })),
      updatedAt: iso(latest.updated_at, true),
    });
  } catch (e) {
    if (process.env.OWNERSHIP_DEBUG) console.error(`[ownership] read ${symbol}: ${e.message}`);
    return null;
  }
}

async function enrichWithMf(symbol, block) {
  const mf = await getMfHoldingsForSymbol(symbol).catch(() => null);
  return { ...block, mutualFundHoldings: mf };
}

// ── Shaping helpers ─────────────────────────────────────────────────────────

function toReportBlock(rec) {
  return {
    quarter: rec.quarter,
    promoterHolding: rec.holdings.promoter,
    fiiHolding: rec.holdings.fii,
    diiHolding: rec.holdings.dii,
    mutualFundHolding: rec.holdings.mutualFund,
    insuranceHolding: rec.holdings.insurance,
    hniHolding: rec.holdings.hni,
    retailHolding: rec.holdings.retail,
    govtHolding: rec.holdings.govt,
    pledgedPct: rec.pledgedPct ?? null,
    changes: rec.changes || {},
    promoterTrend: trendOf(rec.changes?.promoterChange),
    institutionalTrend: rec.institutionalTrend || null,
    smartMoneyScore: rec.smartMoneyScore ?? null,
    institutionalAccumScore: rec.institutionalAccumScore ?? null,
    promoterConfidenceScore: rec.promoterConfidenceScore ?? null,
    superstars: rec.superstars || [],
    history: rec.history || [],
    source: rec.source || null,
    stale: rec.stale || false,
    updatedAt: rec.updatedAt || null,
  };
}

function pickBuckets(q) {
  return {
    promoter: q.promoter ?? null, fii: q.fii ?? null, dii: q.dii ?? null,
    mutualFund: q.mutualFund ?? null, insurance: q.insurance ?? null, hni: q.hni ?? null,
    retail: q.retail ?? null, govt: q.govt ?? null,
    foreignIndividual: q.foreignIndividual ?? null, others: q.others ?? null,
  };
}

function rowToBuckets(row) {
  return {
    promoter: numOrNull(row.promoter), fii: numOrNull(row.fii), dii: numOrNull(row.dii),
    mutualFund: numOrNull(row.mutual_fund), insurance: numOrNull(row.insurance), hni: numOrNull(row.hni),
    retail: numOrNull(row.retail), govt: numOrNull(row.govt),
    foreignIndividual: numOrNull(row.foreign_individual), others: numOrNull(row.others),
  };
}

function trendOf(change) {
  if (change == null) return null;
  if (change > 0.1) return 'increasing';
  if (change < -0.1) return 'decreasing';
  return 'stable';
}

function emptyOwnership() {
  return {
    quarter: null, promoterHolding: null, promoterTrend: null,
    fiiHolding: null, diiHolding: null, mutualFundHolding: null,
    insuranceHolding: null, hniHolding: null, retailHolding: null, govtHolding: null,
    pledgedPct: null, changes: {}, institutionalTrend: null,
    smartMoneyScore: null, institutionalAccumScore: null, promoterConfidenceScore: null,
    superstars: [], history: [], mutualFundHoldings: null, source: null,
    stale: false, updatedAt: null, available: false,
  };
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function iso(d, withTime = false) {
  if (!d) return null;
  const s = d instanceof Date ? d.toISOString() : String(d);
  return withTime ? s : s.slice(0, 10);
}
function safeJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}
