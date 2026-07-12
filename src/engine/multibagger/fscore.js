/**
 * Piotroski F-Score (0-9) — financial strength checklist.
 * Derived purely from Yahoo income/balance/cashflow history.
 *
 * Signals:
 *  Profitability (4):
 *   1. ROA > 0 (positive net income / total assets)
 *   2. Operating cash flow > 0
 *   3. ROA increasing YoY
 *   4. CFO > Net Income (accrual quality)
 *  Leverage & Liquidity (3):
 *   5. Long-term debt / assets decreasing
 *   6. Current ratio increasing
 *   7. No new shares issued (no dilution)
 *  Efficiency (2):
 *   8. Gross margin increasing
 *   9. Asset turnover (revenue/assets) increasing
 */

/**
 * Compute Piotroski F-Score from a FundamentalSnapshot.
 * @param {object} snap — FundamentalSnapshot
 * @returns {{score: number, signals: object, breakdown: string[]}}
 */
export function computeFScore(snap) {
  const signals = {};
  const breakdown = [];
  let score = 0;

  const annual = snap.annualSeries || [];
  const bs = snap.balanceSheetSeries || [];
  const cf = snap.cashFlowSeries || [];

  const latest = annual[annual.length - 1];
  const prev = annual.length >= 2 ? annual[annual.length - 2] : null;
  const latestBS = bs[bs.length - 1];
  const prevBS = bs.length >= 2 ? bs[bs.length - 2] : null;
  const latestCF = cf[cf.length - 1];

  // ── Profitability ──────────────────────────────────────────────────────

  // 1. ROA > 0
  const roa = (latest?.netIncome && latestBS?.totalAssets)
    ? latest.netIncome / latestBS.totalAssets : null;
  signals.roaPositive = roa != null && roa > 0;
  if (signals.roaPositive) { score++; breakdown.push('ROA > 0 ✓'); }
  else breakdown.push('ROA ≤ 0 ✗');

  // 2. Operating cash flow > 0
  signals.cfoPositive = latestCF?.operatingCashflow != null && latestCF.operatingCashflow > 0;
  if (signals.cfoPositive) { score++; breakdown.push('CFO > 0 ✓'); }
  else breakdown.push('CFO ≤ 0 ✗');

  // 3. ROA increasing
  const prevRoa = (prev?.netIncome && prevBS?.totalAssets)
    ? prev.netIncome / prevBS.totalAssets : null;
  signals.roaIncreasing = (roa != null && prevRoa != null) ? roa > prevRoa : null;
  if (signals.roaIncreasing === true) { score++; breakdown.push('ROA increasing ✓'); }
  else if (signals.roaIncreasing === false) breakdown.push('ROA decreasing ✗');
  else breakdown.push('ROA trend: insufficient data');

  // 4. CFO > Net Income (accrual quality)
  signals.accrualQuality = (latestCF?.operatingCashflow != null && latest?.netIncome != null)
    ? latestCF.operatingCashflow > latest.netIncome : null;
  if (signals.accrualQuality === true) { score++; breakdown.push('CFO > Net Income (quality) ✓'); }
  else if (signals.accrualQuality === false) breakdown.push('CFO < Net Income (accrual risk) ✗');
  else breakdown.push('Accrual quality: insufficient data');

  // ── Leverage & Liquidity ───────────────────────────────────────────────

  // 5. Long-term debt / assets decreasing
  const ltdRatio = (latestBS?.longTermDebt != null && latestBS?.totalAssets)
    ? latestBS.longTermDebt / latestBS.totalAssets : null;
  const prevLtdRatio = (prevBS?.longTermDebt != null && prevBS?.totalAssets)
    ? prevBS.longTermDebt / prevBS.totalAssets : null;
  signals.leverageDecreasing = (ltdRatio != null && prevLtdRatio != null)
    ? ltdRatio <= prevLtdRatio : null;
  if (signals.leverageDecreasing === true) { score++; breakdown.push('Leverage decreasing ✓'); }
  else if (signals.leverageDecreasing === false) breakdown.push('Leverage increasing ✗');
  else breakdown.push('Leverage trend: insufficient data');

  // 6. Current ratio increasing
  const cr = (latestBS?.currentAssets && latestBS?.currentLiabilities)
    ? latestBS.currentAssets / latestBS.currentLiabilities : null;
  const prevCr = (prevBS?.currentAssets && prevBS?.currentLiabilities)
    ? prevBS.currentAssets / prevBS.currentLiabilities : null;
  signals.currentRatioIncreasing = (cr != null && prevCr != null) ? cr >= prevCr : null;
  if (signals.currentRatioIncreasing === true) { score++; breakdown.push('Current ratio improving ✓'); }
  else if (signals.currentRatioIncreasing === false) breakdown.push('Current ratio declining ✗');
  else breakdown.push('Current ratio trend: insufficient data');

  // 7. No dilution (shares not increased)
  signals.noDilution = snap.dilutionPct != null ? snap.dilutionPct <= 0 : null;
  if (signals.noDilution === true) { score++; breakdown.push('No dilution ✓'); }
  else if (signals.noDilution === false) breakdown.push(`Dilution: +${snap.dilutionPct?.toFixed(1)}% ✗`);
  else breakdown.push('Dilution: insufficient data');

  // ── Efficiency ─────────────────────────────────────────────────────────

  // 8. Gross margin increasing
  const gm = (latest?.grossProfit && latest?.revenue) ? latest.grossProfit / latest.revenue : null;
  const prevGm = (prev?.grossProfit && prev?.revenue) ? prev.grossProfit / prev.revenue : null;
  signals.grossMarginIncreasing = (gm != null && prevGm != null) ? gm >= prevGm : null;
  if (signals.grossMarginIncreasing === true) { score++; breakdown.push('Gross margin expanding ✓'); }
  else if (signals.grossMarginIncreasing === false) breakdown.push('Gross margin contracting ✗');
  else breakdown.push('Gross margin trend: insufficient data');

  // 9. Asset turnover increasing
  const at = (latest?.revenue && latestBS?.totalAssets) ? latest.revenue / latestBS.totalAssets : null;
  const prevAt = (prev?.revenue && prevBS?.totalAssets) ? prev.revenue / prevBS.totalAssets : null;
  signals.assetTurnoverIncreasing = (at != null && prevAt != null) ? at >= prevAt : null;
  if (signals.assetTurnoverIncreasing === true) { score++; breakdown.push('Asset turnover improving ✓'); }
  else if (signals.assetTurnoverIncreasing === false) breakdown.push('Asset turnover declining ✗');
  else breakdown.push('Asset turnover trend: insufficient data');

  return { score, signals, breakdown };
}

export default { computeFScore };
