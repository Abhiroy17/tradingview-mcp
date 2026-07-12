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

// ── Dynamic Sector Universes (Yahoo GICS → all NSE stocks in that sector) ──

/**
 * Maps UI sector keys → Yahoo Finance GICS sector labels.
 * When selected as a universe, the screener loads the full NSE universe and
 * keeps only stocks whose fundamentals snapshot.sector matches.
 */
export const SECTOR_UNIVERSES = Object.freeze({
  // Yahoo GICS broad sectors (match on snapshot.sector)
  sec_technology:       { label: 'Technology',              yahooSector: 'Technology' },
  sec_financials:       { label: 'Financial Services',      yahooSector: 'Financial Services' },
  sec_healthcare:       { label: 'Healthcare & Pharma',     yahooSector: 'Healthcare' },
  sec_consumer_cyclical:{ label: 'Consumer Cyclical',       yahooSector: 'Consumer Cyclical' },
  sec_consumer_defensive:{ label: 'Consumer Defensive',     yahooSector: 'Consumer Defensive' },
  sec_energy:           { label: 'Energy',                  yahooSector: 'Energy' },
  sec_basic_materials:  { label: 'Basic Materials',         yahooSector: 'Basic Materials' },
  sec_industrials:      { label: 'Industrials',             yahooSector: 'Industrials' },
  sec_communication:    { label: 'Communication Services',  yahooSector: 'Communication Services' },
  sec_utilities:        { label: 'Utilities',               yahooSector: 'Utilities' },
  sec_real_estate:      { label: 'Real Estate',             yahooSector: 'Real Estate' },
  // India-specific (Zerodha) — match on snapshot.industry keywords
  sec_agriculture:      { label: 'Agriculture',             industryMatch: ['Farm Products', 'Agricultural'] },
  sec_auto_ancillary:   { label: 'Auto Ancillary',          industryMatch: ['Auto Parts'] },
  sec_automobile:       { label: 'Automobile',              industryMatch: ['Auto Manufacturers', 'Auto - '] },
  sec_aviation:         { label: 'Aviation',                industryMatch: ['Airlines'] },
  sec_building_materials: { label: 'Building Materials',    industryMatch: ['Building Materials', 'Building Products'] },
  sec_chemicals:        { label: 'Chemicals',               industryMatch: ['Chemicals', 'Specialty Chemicals'] },
  sec_consumer_durables: { label: 'Consumer Durables',      industryMatch: ['Consumer Electronics', 'Furnishings', 'Appliances'] },
  sec_dairy:            { label: 'Dairy Products',          industryMatch: ['Dairy', 'Packaged Foods'] },
  sec_defence:          { label: 'Defence',                 industryMatch: ['Aerospace & Defense'] },
  sec_diversified:      { label: 'Diversified',             industryMatch: ['Conglomerates', 'Diversified'] },
  sec_education:        { label: 'Education & Training',    industryMatch: ['Education'] },
  sec_fertilizers:      { label: 'Fertilizers',             industryMatch: ['Agricultural Inputs', 'Fertilizers'] },
  sec_fmcg:             { label: 'FMCG',                    industryMatch: ['Household Products', 'Personal Products', 'Packaged Foods', 'Beverages'] },
  sec_footwear:         { label: 'Footwear',                industryMatch: ['Footwear', 'Apparel'] },
  sec_infra:            { label: 'Infrastructure',          industryMatch: ['Infrastructure', 'Engineering & Construction'] },
  sec_insurance:        { label: 'Insurance',               industryMatch: ['Insurance'] },
  sec_it:               { label: 'IT - Software',           industryMatch: ['Software', 'Information Technology'] },
  sec_logistics:        { label: 'Logistics',               industryMatch: ['Integrated Freight', 'Marine Shipping', 'Trucking'] },
  sec_media:            { label: 'Media & Entertainment',   industryMatch: ['Entertainment', 'Broadcasting', 'Publishing', 'Advertising'] },
  sec_mining:           { label: 'Mining & Minerals',       industryMatch: ['Mining', 'Industrial Metals'] },
  sec_packaging:        { label: 'Packaging',               industryMatch: ['Packaging'] },
  sec_paper:            { label: 'Paper',                   industryMatch: ['Paper', 'Forest Products'] },
  sec_plastics:         { label: 'Plastics',                industryMatch: ['Rubber & Plastics'] },
  sec_power:            { label: 'Power',                   industryMatch: ['Utilities - Regulated Electric', 'Independent Power', 'Utilities -'] },
  sec_realty:           { label: 'Realty',                  industryMatch: ['Real Estate', 'REIT'] },
  sec_renewables:       { label: 'Renewable Energy',        industryMatch: ['Solar', 'Renewable', 'Wind'] },
  sec_retail:           { label: 'Retail',                  industryMatch: ['Retail', 'Department Stores', 'Grocery'] },
  sec_steel:            { label: 'Steel',                   industryMatch: ['Steel'] },
  sec_sugar:            { label: 'Sugar',                   industryMatch: ['Sugar', 'Food Processing'] },
  sec_telecom:          { label: 'Telecom',                 industryMatch: ['Telecom'] },
  sec_textiles:         { label: 'Textiles',                industryMatch: ['Textile', 'Apparel Manufacturing'] },
  sec_tourism:          { label: 'Tourism & Hospitality',   industryMatch: ['Lodging', 'Resorts', 'Travel', 'Hotels'] },
});

/** Legacy UI keys → SECTOR_UNIVERSES key (backward compat for UI dropdowns). */
export const LEGACY_SECTOR_MAP = Object.freeze({
  bank:   'sec_financials',
  it:     'sec_technology',
  pharma: 'sec_healthcare',
  auto:   'sec_consumer_cyclical',
  fmcg:   'sec_consumer_defensive',
  metal:  'sec_basic_materials',
  energy: 'sec_energy',
});

/** Check if a universe key is a dynamic sector universe (or legacy alias). */
export function isSectorUniverse(key) {
  return !!(SECTOR_UNIVERSES[key] || LEGACY_SECTOR_MAP[key]);
}

/** Get Yahoo sector label for a universe key. Returns null if not a sector key. */
export function getSectorLabel(key) {
  if (SECTOR_UNIVERSES[key]) return SECTOR_UNIVERSES[key].yahooSector || null;
  const mapped = LEGACY_SECTOR_MAP[key];
  if (mapped && SECTOR_UNIVERSES[mapped]) return SECTOR_UNIVERSES[mapped].yahooSector || null;
  return null;
}

/** Get industry match patterns for a universe key. Returns null if sector-level only. */
export function getIndustryMatch(key) {
  if (SECTOR_UNIVERSES[key]) return SECTOR_UNIVERSES[key].industryMatch || null;
  const mapped = LEGACY_SECTOR_MAP[key];
  if (mapped && SECTOR_UNIVERSES[mapped]) return SECTOR_UNIVERSES[mapped].industryMatch || null;
  return null;
}

// ── Registry (curated baskets for backtesting) ─────────────────────────────

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
