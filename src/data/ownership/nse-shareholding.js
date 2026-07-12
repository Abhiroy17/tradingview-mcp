/**
 * NSE shareholding-pattern provider (official source).
 *
 * NSE gates its JSON APIs behind session cookies + browser-like headers. We
 * prime a session by hitting the homepage, then query the corporate
 * shareholding-pattern endpoint. Output is normalized to holding-percentage
 * buckets per quarter.
 *
 * This is best-effort: NSE occasionally changes payload shapes / blocks
 * automated access. On any failure we return null and let callers fall back to
 * cache / Trendlyne / manual.
 */

const NSE_BASE = 'https://www.nseindia.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let _cookieJar = null;
let _cookieAt = 0;
const COOKIE_TTL_MS = 10 * 60 * 1000; // re-prime every 10 min

/** Convert canonical 'NSE:TICKER' → 'TICKER'. Returns null if not NSE. */
function toNseTicker(symbol) {
  if (!symbol) return null;
  const m = /^NSE:(.+)$/i.exec(symbol.trim());
  return m ? m[1].toUpperCase() : null;
}

/** Prime (and cache) an NSE session cookie string. */
async function primeCookies(force = false) {
  if (!force && _cookieJar && Date.now() - _cookieAt < COOKIE_TTL_MS) {
    return _cookieJar;
  }
  const res = await fetch(NSE_BASE + '/', {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const raw = res.headers.getSetCookie?.() || [];
  const jar = raw.map((c) => c.split(';')[0]).join('; ');
  _cookieJar = jar || _cookieJar;
  _cookieAt = Date.now();
  return _cookieJar;
}

async function nseGet(pathAndQuery) {
  const cookie = await primeCookies();
  const url = NSE_BASE + pathAndQuery;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: NSE_BASE + '/get-quotes/equity',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    // Session expired — re-prime once and retry.
    await primeCookies(true);
    const cookie2 = await primeCookies();
    const retry = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: NSE_BASE + '/get-quotes/equity',
        ...(cookie2 ? { Cookie: cookie2 } : {}),
      },
    });
    if (!retry.ok) throw new Error(`NSE ${retry.status}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`NSE ${res.status}`);
  return res.json();
}

/**
 * Map an NSE shareholding category label to our normalized bucket key.
 */
function classifyCategory(label = '') {
  const s = label.toLowerCase();
  if (s.includes('promoter')) return 'promoter';
  if (s.includes('mutual fund') || s.includes('mutual funds')) return 'mutualFund';
  if (s.includes('foreign portfolio') || s.includes('fpi') || s.includes('foreign institutional') || s.includes('fii')) return 'fii';
  if (s.includes('insurance')) return 'insurance';
  if (s.includes('financial institution') || s.includes('bank') || s.includes('venture capital') || s.includes('alternate investment') || s.includes('domestic institutional') || s.includes('dii')) return 'dii';
  if (s.includes('individual') && (s.includes('nominal') || s.includes('excess') || s.includes('2 lakh') || s.includes('high net'))) return 'hni';
  if (s.includes('individual') || s.includes('public') || s.includes('retail')) return 'retail';
  if (s.includes('government') || s.includes('central') || s.includes('state gov') || s.includes('president of india')) return 'govt';
  if (s.includes('foreign') && s.includes('individual')) return 'foreignIndividual';
  return 'others';
}

/**
 * Parse an NSE shareholding-pattern payload into { quarter, buckets }.
 * NSE payloads vary; we defensively handle the common `data[]` rows shape where
 * each row has a category label + percentage of total shareholding.
 */
function parseShareholdingPayload(payload) {
  const rows = payload?.data || payload?.shareholdingPatterns || payload || [];
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // Group rows by period (quarter). Each row: { period/date, category, percentage }.
  const byPeriod = new Map();
  for (const r of rows) {
    const period = r.date || r.period || r.asOnDate || r.quarter;
    const label = r.category || r.name || r.shareholderCategory || '';
    const pct = pctOf(r);
    if (!period || pct == null) continue;
    const bucket = classifyCategory(label);
    if (!byPeriod.has(period)) byPeriod.set(period, {});
    const acc = byPeriod.get(period);
    acc[bucket] = round((acc[bucket] || 0) + pct, 4);
  }
  if (byPeriod.size === 0) return null;

  // Convert to chronological array (oldest → newest).
  const out = [...byPeriod.entries()]
    .map(([period, buckets]) => ({ quarter: normalizeDate(period), ...buckets }))
    .filter((q) => q.quarter)
    .sort((a, b) => a.quarter.localeCompare(b.quarter));
  return out;
}

function pctOf(row) {
  const cands = [row.percentage, row.percent, row.totalShareholdingPct, row.pct, row.shareholding];
  for (const c of cands) {
    const n = typeof c === 'string' ? parseFloat(c.replace(/[%,]/g, '')) : c;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeDate(d) {
  if (!d) return null;
  // Accept 'DD-MMM-YYYY', 'YYYY-MM-DD', 'MMM YYYY'
  const t = Date.parse(d);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  const m = /(\d{2})-(\w{3})-(\d{4})/.exec(d);
  if (m) {
    const t2 = Date.parse(`${m[2]} ${m[1]}, ${m[3]}`);
    if (!Number.isNaN(t2)) return new Date(t2).toISOString().slice(0, 10);
  }
  return null;
}

function round(n, dp = 4) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Fetch normalized shareholding history for a canonical NSE symbol.
 * @returns {Promise<Array<object>|null>} chronological quarters or null.
 */
export async function fetchNseShareholding(symbol) {
  const ticker = toNseTicker(symbol);
  if (!ticker) return null;
  try {
    const payload = await nseGet(
      `/api/corp-info?symbol=${encodeURIComponent(ticker)}&corpType=shareholdings_patterns&market=equities`,
    );
    const parsed = parseShareholdingPayload(payload);
    if (parsed && parsed.length) {
      return parsed.map((q) => ({ ...q, source: 'nse' }));
    }
    return null;
  } catch (e) {
    if (process.env.OWNERSHIP_DEBUG) console.error(`[nse-shareholding] ${symbol}: ${e.message}`);
    return null;
  }
}
