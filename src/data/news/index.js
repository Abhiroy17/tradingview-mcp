/**
 * News provider — Google News RSS (free, no API key).
 *
 * Fetches stock-specific and sector news, parses the RSS XML with a small
 * dependency-free parser, dedupes, and caches (in-memory + optional Postgres
 * `news_cache`). Returns the most recent items with basic recency labels.
 */

import crypto from 'node:crypto';
import { query, isDbConfigured } from '../../db/client.js';

const GN_BASE = 'https://news.google.com/rss/search';
const UA = 'Mozilla/5.0 (compatible; tvmcp-news/1.0)';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

const _mem = new Map(); // key → { at, items }

function buildUrl(queryStr) {
  const q = encodeURIComponent(queryStr);
  return `${GN_BASE}?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
}

/** Minimal RSS <item> extractor (dependency-free). */
export function parseRss(xml) {
  const items = [];
  const blocks = xml.split(/<item>/i).slice(1);
  for (const b of blocks) {
    const chunk = b.split(/<\/item>/i)[0];
    const title = decode(tag(chunk, 'title'));
    const link = decode(tag(chunk, 'link'));
    const pubDate = tag(chunk, 'pubDate');
    const source = decode(tag(chunk, 'source')) || sourceFromTitle(title);
    if (!title || !link) continue;
    items.push({
      title: stripSourceSuffix(title),
      link,
      source,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
    });
  }
  return items;
}

function tag(s, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(s);
  if (!m) return null;
  return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}
function decode(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function sourceFromTitle(t) {
  const m = / - ([^-]+)$/.exec(t || '');
  return m ? m[1].trim() : null;
}
function stripSourceSuffix(t) {
  return (t || '').replace(/ - [^-]+$/, '').trim();
}

async function fetchFeed(queryStr) {
  const res = await fetch(buildUrl(queryStr), { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Google News ${res.status}`);
  const xml = await res.text();
  // Detect non-RSS HTML responses (captcha/consent pages)
  if (!xml.includes('<item>') && !xml.includes('<item ') && xml.includes('<!DOCTYPE')) {
    throw new Error('Google News returned HTML instead of RSS (likely captcha)');
  }
  return parseRss(xml).slice(0, 25);
}

async function cachedFeed(cacheKey, queryStr, meta = {}) {
  const hit = _mem.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items;
  let items = [];
  try {
    items = await fetchFeed(queryStr);
  } catch (e) {
    if (process.env.OWNERSHIP_DEBUG) console.error(`[news] ${cacheKey}: ${e.message}`);
    if (hit) return hit.items; // serve stale on failure
    return [];
  }
  _mem.set(cacheKey, { at: Date.now(), items });
  if (isDbConfigured()) persistNews(items, meta).catch(() => {});
  return items;
}

async function persistNews(items, meta) {
  for (const it of items) {
    const guid = crypto.createHash('sha1').update(it.link).digest('hex');
    await query(
      `INSERT INTO news_cache (symbol, sector, scope, title, link, source_name, published_at, guid, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (guid) DO UPDATE SET fetched_at=NOW()`,
      [meta.symbol || null, meta.sector || null, meta.scope || 'stock',
        it.title, it.link, it.source, it.publishedAt, guid],
    ).catch(() => {});
  }
}

function withRecency(items) {
  const now = Date.now();
  return items.map((it) => {
    let recency = null;
    if (it.publishedAt) {
      const ageH = (now - new Date(it.publishedAt).getTime()) / 3.6e6;
      recency = ageH < 24 ? 'today' : ageH < 168 ? 'this_week' : ageH < 720 ? 'this_month' : 'older';
    }
    return { ...it, recency };
  }).sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
}

/**
 * Get combined stock + sector news for a symbol.
 * @param {string} symbol — canonical 'NSE:TICKER'
 * @param {object} [opts] { name, sector, limit }
 * @returns {Promise<{stock:Array, sector:Array}>}
 */
export async function getNews(symbol, opts = {}) {
  const name = opts.name || (symbol || '').replace(/^NSE:/i, '');
  const sector = opts.sector || null;
  const limit = opts.limit || 12;

  const stockQuery = `${name} stock NSE`;
  const jobs = [cachedFeed(`stock:${symbol}`, stockQuery, { symbol, scope: 'stock' })];
  if (sector) {
    const sectorQuery = `India ${sector} sector`;
    jobs.push(cachedFeed(`sector:${sector}`, sectorQuery, { sector, scope: 'sector' }));
  } else {
    jobs.push(Promise.resolve([]));
  }
  const [stock, sec] = await Promise.all(jobs);
  return {
    stock: withRecency(stock).slice(0, limit),
    sector: withRecency(sec).slice(0, limit),
  };
}
