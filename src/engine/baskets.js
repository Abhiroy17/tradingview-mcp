/**
 * baskets.js — Named NSE symbol baskets for cross-sectional strategy tuning.
 *
 * Cross-symbol tuning (scripts/tune-multi.js) needs representative baskets so
 * that locked params generalise instead of curve-fitting to one ticker. We
 * group liquid NSE names two ways:
 *
 *   1. Cap tier   — large_cap / mid_cap / small_cap (size + liquidity profile)
 *   2. Sector     — bank / it / pharma / auto / fmcg / metal / energy
 *
 * Conventions / gotchas:
 *   - Symbols are canonical "NSE:TICKER" (the form the data router + Upstox
 *     instrument map expect).
 *   - Strategies with price/liquidity filters (e.g. ibs_* use minPrice ₹100,
 *     minTurnover ₹2 Cr) will silently skip penny / illiquid names. The
 *     small_cap basket therefore deliberately uses liquid names trading > ₹100
 *     so it survives those gates. Run scripts/verify-baskets.js to prune any
 *     symbol that fails to resolve or lacks history before a tuning batch.
 *   - This module is the single source of truth for baskets so the tuner,
 *     dashboard scanner, and v2 API can all reuse the same definitions.
 */

// ── Cap-tier baskets ───────────────────────────────────────────────────────

/** Nifty-50 mega-caps — deepest liquidity, the universal sanity basket. */
const large_cap = [
  'NSE:RELIANCE', 'NSE:HDFCBANK', 'NSE:ICICIBANK', 'NSE:INFY',
  'NSE:TCS',      'NSE:ITC',      'NSE:LT',        'NSE:SBIN',
  'NSE:BHARTIARTL', 'NSE:KOTAKBANK',
];

/** Liquid mid-caps — higher beta, where mean-reversion edges often live. */
const mid_cap = [
  'NSE:COFORGE',    'NSE:PERSISTENT', 'NSE:FEDERALBNK', 'NSE:AUROPHARMA',
  'NSE:MPHASIS',    'NSE:CUMMINSIND', 'NSE:LUPIN',      'NSE:TVSMOTOR',
  'NSE:TATAPOWER',  'NSE:BANKBARODA',
];

/** Liquid small-caps trading > ₹100 (survive minPrice/turnover filters). */
const small_cap = [
  'NSE:RVNL',   'NSE:MAZDOCK',  'NSE:OIL',        'NSE:NATIONALUM',
  'NSE:BHEL',   'NSE:IRCTC',    'NSE:KPITTECH',   'NSE:IEX',
  'NSE:CDSL',   'NSE:MANAPPURAM',
];

// ── Sector baskets ─────────────────────────────────────────────────────────

const bank = [
  'NSE:HDFCBANK', 'NSE:ICICIBANK', 'NSE:AXISBANK', 'NSE:KOTAKBANK',
  'NSE:SBIN',     'NSE:BANKBARODA','NSE:FEDERALBNK','NSE:PNB',
  'NSE:AUBANK',   'NSE:INDUSINDBK',
];

const it = [
  'NSE:TCS',    'NSE:INFY',     'NSE:WIPRO',   'NSE:HCLTECH',
  'NSE:TECHM',  'NSE:OFSS',     'NSE:MPHASIS', 'NSE:COFORGE',
  'NSE:PERSISTENT', 'NSE:KPITTECH',
];

const pharma = [
  'NSE:SUNPHARMA', 'NSE:DRREDDY', 'NSE:CIPLA',  'NSE:DIVISLAB',
  'NSE:AUROPHARMA','NSE:LUPIN',   'NSE:TORNTPHARM','NSE:BIOCON',
  'NSE:IPCALAB',   'NSE:ALKEM',
];

const auto = [
  'NSE:MARUTI',   'NSE:BOSCHLTD',   'NSE:M&M',       'NSE:BAJAJ-AUTO',
  'NSE:EICHERMOT','NSE:HEROMOTOCO', 'NSE:TVSMOTOR',  'NSE:ASHOKLEY',
  'NSE:BHARATFORG','NSE:MOTHERSON',
];

const fmcg = [
  'NSE:HINDUNILVR', 'NSE:ITC',     'NSE:NESTLEIND', 'NSE:BRITANNIA',
  'NSE:DABUR',      'NSE:MARICO',  'NSE:GODREJCP',  'NSE:COLPAL',
  'NSE:TATACONSUM', 'NSE:VBL',
];

const metal = [
  'NSE:TATASTEEL', 'NSE:JSWSTEEL', 'NSE:HINDALCO', 'NSE:VEDL',
  'NSE:COALINDIA', 'NSE:JINDALSTEL','NSE:APLAPOLLO','NSE:SAIL',
  'NSE:NATIONALUM','NSE:HINDZINC',
];

const energy = [
  'NSE:RELIANCE', 'NSE:NTPC',   'NSE:POWERGRID', 'NSE:ONGC',
  'NSE:BPCL',     'NSE:IOC',    'NSE:GAIL',      'NSE:TATAPOWER',
  'NSE:COALINDIA','NSE:ADANIPOWER',
];

// ── Registry ───────────────────────────────────────────────────────────────

const CAP_BASKETS    = { large_cap, mid_cap, small_cap };
const SECTOR_BASKETS = { bank, it, pharma, auto, fmcg, metal, energy };

/** All baskets, keyed by name. */
export const BASKETS = Object.freeze({ ...CAP_BASKETS, ...SECTOR_BASKETS });

/** Group membership for `--basket all` iteration + reporting. */
export const BASKET_GROUPS = Object.freeze({
  cap:    Object.keys(CAP_BASKETS),
  sector: Object.keys(SECTOR_BASKETS),
});

/** Human labels for report headers. */
export const BASKET_META = Object.freeze({
  large_cap: { label: 'Large Cap (Nifty mega-caps)', group: 'cap' },
  mid_cap:   { label: 'Mid Cap (liquid mid-caps)',   group: 'cap' },
  small_cap: { label: 'Small Cap (liquid > ₹100)',   group: 'cap' },
  bank:      { label: 'Banking & Financials',         group: 'sector' },
  it:        { label: 'Information Technology',        group: 'sector' },
  pharma:    { label: 'Pharma & Healthcare',          group: 'sector' },
  auto:      { label: 'Automobile & Ancillaries',     group: 'sector' },
  fmcg:      { label: 'FMCG & Consumer',              group: 'sector' },
  metal:     { label: 'Metals & Mining',              group: 'sector' },
  energy:    { label: 'Energy & Power',               group: 'sector' },
});

/** List all basket names. */
export function listBaskets() {
  return Object.keys(BASKETS);
}

/** Resolve a basket name → array of "NSE:TICKER". Throws on unknown name. */
export function getBasket(name) {
  const b = BASKETS[name];
  if (!b) {
    throw new Error(`Unknown basket '${name}'. Available: ${listBaskets().join(', ')}`);
  }
  return [...b];
}

/** Deduplicated union of every basket symbol (for batch pre-fetch / warm cache). */
export function allBasketSymbols() {
  return [...new Set(Object.values(BASKETS).flat())];
}
