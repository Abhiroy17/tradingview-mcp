/**
 * Trendlyne enrichment provider — HNI / "Superstar" (marquee investor) holdings.
 *
 * OPT-IN ONLY. Disabled unless env `SHAREHOLDING_SCRAPE=1` (or `=trendlyne`).
 * Trendlyne data is behind scraping (fragile, ToS-sensitive), so it is used
 * strictly to *supplement* the official NSE numbers — never as the primary
 * source. All failures degrade to null.
 *
 * Returns, when available:
 *   - hni            : HNI / non-institutional big holders %
 *   - superstars     : [{ name, pct, changePct }] marquee individual investors
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Whether Trendlyne enrichment is enabled via env flag. */
export function trendlyneEnabled() {
  const v = (process.env.SHAREHOLDING_SCRAPE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'trendlyne' || v === 'all';
}

function toTicker(symbol) {
  const m = /^NSE:(.+)$/i.exec((symbol || '').trim());
  return m ? m[1].toUpperCase() : null;
}

/**
 * Best-effort fetch of Trendlyne shareholding/superstar enrichment.
 * @returns {Promise<{hni:number|null, superstars:Array}|null>}
 */
export async function fetchTrendlyneOwnership(symbol) {
  if (!trendlyneEnabled()) return null;
  const ticker = toTicker(symbol);
  if (!ticker) return null;

  try {
    // Trendlyne exposes a public search → id resolution. We attempt the
    // lightweight public shareholding widget JSON. Selectors/endpoints may
    // change; on any deviation we return null (never throw to callers).
    const searchUrl = `https://trendlyne.com/equity/api/stock/search/?q=${encodeURIComponent(ticker)}`;
    const sres = await fetch(searchUrl, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!sres.ok) return null;
    const sjson = await sres.json().catch(() => null);
    const stockId = extractStockId(sjson, ticker);
    if (!stockId) return null;

    const shUrl = `https://trendlyne.com/equity/api/${stockId}/shareholding/summary/`;
    const shres = await fetch(shUrl, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!shres.ok) return null;
    const shjson = await shres.json().catch(() => null);
    return normalizeTrendlyne(shjson);
  } catch (e) {
    if (process.env.OWNERSHIP_DEBUG) console.error(`[trendlyne] ${symbol}: ${e.message}`);
    return null;
  }
}

function extractStockId(json, ticker) {
  const list = json?.results || json?.data || json?.body || [];
  if (!Array.isArray(list)) return null;
  const hit =
    list.find((r) => (r.nsecode || r.nse_code || r.ticker || '').toUpperCase() === ticker) ||
    list[0];
  return hit?.stock_id || hit?.id || hit?.pk || null;
}

function normalizeTrendlyne(json) {
  if (!json) return null;
  const body = json.body || json.data || json;
  const hni = pickPct(body, ['hni', 'nonInstitutional', 'non_institutional', 'individualLarge']);
  const superstarsRaw = body?.superstars || body?.marqueeInvestors || body?.superstar_investors || [];
  const superstars = Array.isArray(superstarsRaw)
    ? superstarsRaw
        .map((s) => ({
          name: s.name || s.investor || s.investorName || null,
          pct: toNum(s.holding || s.pct || s.percentage),
          changePct: toNum(s.change || s.changePct || s.qoqChange),
        }))
        .filter((s) => s.name)
        .slice(0, 15)
    : [];
  if (hni == null && superstars.length === 0) return null;
  return { hni, superstars, source: 'trendlyne' };
}

function pickPct(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    const n = typeof v === 'string' ? parseFloat(v.replace(/[%,]/g, '')) : v;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}

function toNum(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace(/[%,]/g, '')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
