/**
 * NSE FII/DII daily aggregate cash-flow provider (official, market-wide).
 *
 * This is *market context*, not per-stock: NSE publishes daily net FII & DII
 * buy/sell in the cash segment. Useful to frame a stock's ownership changes
 * against the broader institutional tide. Best-effort; returns null on failure.
 */

const NSE_BASE = 'https://www.nseindia.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let _cookie = null;
let _cookieAt = 0;
const TTL = 10 * 60 * 1000;

async function prime(force = false) {
  if (!force && _cookie && Date.now() - _cookieAt < TTL) return _cookie;
  const res = await fetch(NSE_BASE + '/', {
    headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const raw = res.headers.getSetCookie?.() || [];
  _cookie = raw.map((c) => c.split(';')[0]).join('; ') || _cookie;
  _cookieAt = Date.now();
  return _cookie;
}

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1h — updated once daily by NSE

/**
 * @returns {Promise<{date, fii:{buy,sell,net}, dii:{buy,sell,net}}|null>}
 */
export async function fetchFiiDiiFlows() {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL) return _cache;
  try {
    const cookie = await prime();
    const res = await fetch(NSE_BASE + '/api/fiidiiTradeReact', {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Referer: NSE_BASE + '/reports/fii-dii',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (!res.ok) throw new Error(`NSE ${res.status}`);
    const text = await res.text();
    if (text.trimStart().startsWith('<')) throw new Error('NSE returned HTML (likely captcha/WAF)');
    let arr;
    try { arr = JSON.parse(text); } catch (e) { throw new Error(`NSE JSON parse: ${e.message}`); }
    const norm = normalize(arr);
    if (norm) { _cache = norm; _cacheAt = Date.now(); }
    return norm;
  } catch (e) {
    if (process.env.OWNERSHIP_DEBUG) console.error(`[fii-dii] ${e.message}`);
    return null;
  }
}

function normalize(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const out = { date: null, fii: null, dii: null };
  for (const r of arr) {
    const cat = (r.category || '').toUpperCase();
    const rec = {
      buy: toNum(r.buyValue),
      sell: toNum(r.sellValue),
      net: toNum(r.netValue),
    };
    out.date = r.date || out.date;
    if (cat.includes('FII') || cat.includes('FPI')) out.fii = rec;
    else if (cat.includes('DII')) out.dii = rec;
  }
  return out.fii || out.dii ? out : null;
}

function toNum(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace(/[₹,\s]/g, '')) : v;
  return Number.isFinite(n) ? n : null;
}
