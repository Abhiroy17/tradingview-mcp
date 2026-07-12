/**
 * Data-gap auditor — reports which report fields are present vs missing, the
 * source each comes from, and why a gap exists (e.g. "Yahoo doesn't supply this
 * for banks" vs "source unreachable"). Answers: "where are the current gaps?"
 */

/**
 * @param {object} snap — fundamentals snapshot
 * @param {object} ownership — ownership block (from getOwnership)
 * @param {object} news — { stock:[], sector:[] }
 * @returns {object} audit summary
 */
export function auditDataGaps(snap, ownership, news) {
  const checks = [];
  const add = (field, present, source, note) =>
    checks.push({ field, present: Boolean(present), source, note: note || null });

  // Fundamentals (Yahoo)
  add('Quarterly results', snap?.quarterlySeries?.length > 0, 'yahoo');
  add('Annual P&L', snap?.annualSeries?.length > 0, 'yahoo');
  add('Revenue growth', snap?.revenueGrowth != null, 'yahoo');
  add('EPS / earnings growth', snap?.earningsGrowth != null, 'yahoo');
  add('EBITDA margin', snap?.ebitdaMargin != null, 'yahoo');
  add('ROE', snap?.roe != null, 'yahoo');
  add('ROCE', snap?.roce != null, 'yahoo', snap?.roce == null ? 'Often null for banks/NBFCs' : null);
  add('P/E', snap?.pe != null, 'yahoo');
  add('P/B', snap?.pb != null, 'yahoo');
  add('Debt/Equity', snap?.debtToEquity != null, 'yahoo', snap?.debtToEquity == null ? 'Not meaningful for banks' : null);
  add('Free cash flow', snap?.freeCashflow != null, 'yahoo');
  add('Dividend yield', snap?.dividendYield != null, 'yahoo', snap?.dividendYield == null ? 'Not fetched / non-dividend payer' : null);
  add('Analyst estimates', snap?.estimates?.length > 0, 'yahoo');

  // Ownership (NSE / Yahoo / AMFI / Trendlyne)
  const owSrc = ownership?.source || 'nse';
  add('Promoter holding', ownership?.promoterHolding != null, owSrc, ownership?.promoterHolding == null ? 'NSE unavailable — Yahoo majorHolders also checked' : null);
  add('FII holding', ownership?.fiiHolding != null, owSrc);
  add('DII holding', ownership?.diiHolding != null, owSrc, ownership?.diiHolding == null && owSrc === 'yahoo' ? 'Yahoo groups all institutions together — no FII/DII split' : null);
  add('Mutual fund holding %', ownership?.mutualFundHolding != null, owSrc);
  add('MF scheme-level holdings', ownership?.mutualFundHoldings?.count > 0, 'amfi', ownership?.mutualFundHoldings ? null : 'Requires AMFI monthly portfolio ingestion');
  add('HNI holding', ownership?.hniHolding != null, ownership?.superstars?.length ? 'trendlyne' : owSrc,
    ownership?.hniHolding == null ? 'Enable SHAREHOLDING_SCRAPE for Trendlyne HNI/superstar data' : null);
  add('Marquee (superstar) investors', ownership?.superstars?.length > 0, 'trendlyne', ownership?.superstars?.length ? null : 'Opt-in via SHAREHOLDING_SCRAPE=1');
  add('Promoter pledge %', ownership?.pledgedPct != null, owSrc, ownership?.pledgedPct == null ? 'Not available from current source' : null);
  add('Ownership QoQ trend', ownership?.institutionalTrend != null, 'derived', ownership?.institutionalTrend == null && owSrc === 'yahoo' ? 'Yahoo provides single snapshot, no quarterly history' : null);

  // News (Google News RSS)
  add('Stock news', news?.stock?.length > 0, 'google_news');
  add('Sector news', news?.sector?.length > 0, 'google_news');

  // Known-not-covered (explicit, so the report is honest about scope)
  const notCovered = [
    { field: 'Corporate governance / RPT flags', note: 'Manual — auditor notes & filings' },
    { field: 'Bank asset quality (GNPA/NNPA)', note: 'Not fetched — bank-specific source needed' },
    { field: 'Options / order-flow data', note: 'Out of scope' },
    { field: 'Concall guidance vs delivery', note: 'Manual — read transcripts' },
  ];

  const present = checks.filter((c) => c.present).length;
  const total = checks.length;
  const missing = checks.filter((c) => !c.present);

  return {
    completenessPct: Math.round((present / total) * 100),
    present,
    total,
    missing: missing.map((m) => ({ field: m.field, source: m.source, note: m.note })),
    checks,
    notCovered,
  };
}
