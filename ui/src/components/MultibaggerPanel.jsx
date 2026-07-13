import { useState, useCallback, useMemo, useRef } from 'react';
import { QuarterlyTrendChart, AnnualGrowthChart, ScoringRadarChart, MarginTrendChart } from './MultibaggerCharts.jsx';
import { TrendUp, TrendDown, Info, WarningCircle, CheckCircle, Sparkle, ChartBar, Table as TableIcon, ArrowsDownUp } from 'phosphor-react';
import './MultibaggerPanel.css';

const DEFAULT_FILTERS = {
  minPrice: 50,
  minMarketCap: 1000, // in Crores
  maxDebtToEquity: '',
  minROE: '',
  minFScore: '',
  maxPE: '',
  turnaroundOnly: false,
};

const BASKETS = [
  // ── Market Cap ──
  { id: 'large_cap', label: 'Large Cap (Nifty 50)' },
  { id: 'mid_cap', label: 'Mid Cap' },
  { id: 'small_cap', label: 'Small Cap' },
  // ── Yahoo GICS Sectors (broad) ──
  { id: 'sec_healthcare', label: 'Healthcare & Pharma' },
  { id: 'sec_financials', label: 'Financial Services' },
  { id: 'sec_technology', label: 'Technology' },
  { id: 'sec_consumer_cyclical', label: 'Consumer Cyclical' },
  { id: 'sec_consumer_defensive', label: 'Consumer Defensive' },
  { id: 'sec_energy', label: 'Energy' },
  { id: 'sec_basic_materials', label: 'Basic Materials' },
  { id: 'sec_industrials', label: 'Industrials' },
  { id: 'sec_communication', label: 'Communication Services' },
  { id: 'sec_utilities', label: 'Utilities' },
  { id: 'sec_real_estate', label: 'Real Estate' },
  // ── Zerodha / India-specific sectors ──
  { id: 'sec_agriculture', label: 'Agriculture' },
  { id: 'sec_auto_ancillary', label: 'Auto Ancillary' },
  { id: 'sec_automobile', label: 'Automobile' },
  { id: 'sec_aviation', label: 'Aviation' },
  { id: 'sec_building_materials', label: 'Building Materials' },
  { id: 'sec_chemicals', label: 'Chemicals' },
  { id: 'sec_consumer_durables', label: 'Consumer Durables' },
  { id: 'sec_dairy', label: 'Dairy Products' },
  { id: 'sec_defence', label: 'Defence' },
  { id: 'sec_diversified', label: 'Diversified' },
  { id: 'sec_education', label: 'Education & Training' },
  { id: 'sec_fertilizers', label: 'Fertilizers' },
  { id: 'sec_fmcg', label: 'FMCG' },
  { id: 'sec_footwear', label: 'Footwear' },
  { id: 'sec_infra', label: 'Infrastructure' },
  { id: 'sec_insurance', label: 'Insurance' },
  { id: 'sec_it', label: 'IT - Software' },
  { id: 'sec_logistics', label: 'Logistics' },
  { id: 'sec_media', label: 'Media & Entertainment' },
  { id: 'sec_mining', label: 'Mining & Minerals' },
  { id: 'sec_packaging', label: 'Packaging' },
  { id: 'sec_paper', label: 'Paper' },
  { id: 'sec_plastics', label: 'Plastics' },
  { id: 'sec_power', label: 'Power' },
  { id: 'sec_realty', label: 'Realty' },
  { id: 'sec_renewables', label: 'Renewable Energy' },
  { id: 'sec_retail', label: 'Retail' },
  { id: 'sec_steel', label: 'Steel' },
  { id: 'sec_sugar', label: 'Sugar' },
  { id: 'sec_telecom', label: 'Telecom' },
  { id: 'sec_textiles', label: 'Textiles' },
  { id: 'sec_tourism', label: 'Tourism & Hospitality' },
  // ── Full Universe ──
  { id: 'all', label: 'Full NSE Universe (~2000)' },
];

const TIER_COLORS = {
  strong: '#22c55e',
  good: '#84cc16',
  neutral: '#eab308',
  weak: '#f97316',
  avoid: '#ef4444',
};

export default function MultibaggerPanel() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [universe, setUniverse] = useState('large_cap');
  const [preset, setPreset] = useState('');
  const [results, setResults] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [selectedSymbol, setSelectedSymbol] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [error, setError] = useState(null);
  const [visibleRows, setVisibleRows] = useState(50);

  const displayResults = useMemo(() => results.slice(0, visibleRows), [results, visibleRows]);

  const runScreen = useCallback(async () => {
    setScanning(true);
    setError(null);
    setVisibleRows(50);
    setProgress({ message: 'Starting screen...' });
    try {
      const body = {
        universe,
        filters: {
          minPrice: Number(filters.minPrice) || 50,
          minMarketCap: (Number(filters.minMarketCap) || 500) * 1e7, // Cr to raw
          maxDebtToEquity: filters.maxDebtToEquity ? Number(filters.maxDebtToEquity) : null,
          minROE: filters.minROE ? Number(filters.minROE) : null,
          minFScore: filters.minFScore ? Number(filters.minFScore) : null,
          maxPE: filters.maxPE ? Number(filters.maxPE) : null,
          turnaroundOnly: filters.turnaroundOnly,
        },
        topN: 0, // return ALL results
        preset: preset || null,
      };
      const res = await fetch('/api/v2/multibagger/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok && res.headers.get('content-type')?.includes('text/html')) {
        throw new Error(`Server error ${res.status} (likely restarting, try again)`);
      }
      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw new Error(`Invalid response from server (${res.status}). Please retry.`);
      }
      if (data.success) {
        setResults(Array.isArray(data.results) ? data.results : []);
        setProgress({ message: `Done: ${data.results?.length || 0} results from ${data.meta?.scored || 0} scored`, phase: 'complete' });
      } else {
        setError(data.error || 'Screen failed — server returned an error');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setScanning(false);
    }
  }, [universe, filters, preset]);

  const loadAnalysis = useCallback(async (symbol) => {
    setSelectedSymbol(symbol);
    setAnalysisLoading(true);
    setAnalysis(null);
    try {
      const res = await fetch(`/api/v2/multibagger/analysis?symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok && res.headers.get('content-type')?.includes('text/html')) {
        throw new Error(`Server error ${res.status}`);
      }
      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw new Error(`Invalid response from server. Please retry.`);
      }
      if (data.success) setAnalysis(data.analysis);
      else setError(data.error || 'Analysis failed');
    } catch (e) {
      setError(e.message);
    } finally {
      setAnalysisLoading(false);
    }
  }, []);

  return (
    <div className="multibagger-panel">
      <div className="mb-header">
        <h2>🚀 Multibagger Screener</h2>
        <p className="mb-subtitle">Fundamental-driven stock screening for NSE — 7-axis scoring with Piotroski F-Score</p>
      </div>

      {/* Filters */}
      <div className="mb-filters">
        <div className="mb-filter-row">
          <label>Universe:
            <select value={universe} onChange={e => setUniverse(e.target.value)}>
              {BASKETS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </label>
          <label>Preset (soft boost):
            <select value={preset} onChange={e => setPreset(e.target.value)}>
              <option value="">None</option>
              <option value="institutional">Institutional Multibagger</option>
              <option value="smallcap_hunter">Small-Cap Hunter</option>
              <option value="emerging_leader">Emerging Leader</option>
            </select>
          </label>
          <label>Min Price (₹):
            <input type="number" value={filters.minPrice} onChange={e => setFilters(f => ({ ...f, minPrice: e.target.value }))} />
          </label>
          <label>Min Market Cap (Cr):
            <input type="number" value={filters.minMarketCap} onChange={e => setFilters(f => ({ ...f, minMarketCap: e.target.value }))} />
          </label>
          <label>Max Debt/Equity:
            <input type="number" value={filters.maxDebtToEquity} placeholder="Any" onChange={e => setFilters(f => ({ ...f, maxDebtToEquity: e.target.value }))} />
          </label>
          <label>Min ROE (%):
            <input type="number" value={filters.minROE} placeholder="Any" onChange={e => setFilters(f => ({ ...f, minROE: e.target.value }))} />
          </label>
          <label>Min F-Score:
            <input type="number" min="0" max="9" value={filters.minFScore} placeholder="Any" onChange={e => setFilters(f => ({ ...f, minFScore: e.target.value }))} />
          </label>
          <label>Max P/E:
            <input type="number" min="0" value={filters.maxPE} placeholder="Any" onChange={e => setFilters(f => ({ ...f, maxPE: e.target.value }))} />
          </label>
          <label className="mb-checkbox">
            <input type="checkbox" checked={filters.turnaroundOnly} onChange={e => setFilters(f => ({ ...f, turnaroundOnly: e.target.checked }))} />
            Turnaround Only
          </label>
        </div>
        <button className="mb-scan-btn" onClick={runScreen} disabled={scanning}>
          {scanning ? '⏳ Screening...' : '🔍 Run Screen'}
        </button>
      </div>

      {/* Progress / Error */}
      {progress && !error && <div className="mb-progress">{progress.message}</div>}
      {error && (
        <div className="mb-error">
          ⚠️ {error}
          <button className="mb-retry-btn" onClick={() => { setError(null); runScreen(); }} style={{ marginLeft: 12, padding: '4px 12px', cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      )}

      {/* Results Grid */}
      {results.length > 0 && !selectedSymbol && (
        <div className="mb-results">
          <h3>Top Picks ({results.length})</h3>
          <div className="mb-table-wrap">
            <table className="mb-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Symbol</th>
                  <th>Sector</th>
                  <th>Score</th>
                  <th>Tier</th>
                  <th>Quality</th>
                  <th>Momentum</th>
                  <th>P/E</th>
                  <th>Sect P/E</th>
                  <th>P/E vs Sect</th>
                  <th>ROE%</th>
                  <th>ROCE%</th>
                  <th>PEG</th>
                  <th>NP YoY%</th>
                  <th>NP QoQ%</th>
                  <th>F-Score</th>
                  <th>Margin</th>
                  {preset && <th>Fit%</th>}
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {displayResults.map((r, i) => (
                  <tr key={r.symbol} className={`mb-row tier-${r.tier}`} onClick={() => loadAnalysis(r.symbol)}>
                    <td>{i + 1}</td>
                    <td className="mb-symbol">{r.symbol.replace('NSE:', '')}</td>
                    <td>{r.sector || '-'}</td>
                    <td className="mb-score">{r.multibaggerScore}</td>
                    <td><span className="mb-tier" style={{ background: TIER_COLORS[r.tier] }}>{r.tier}</span></td>
                    <td>{r.qualityScore}</td>
                    <td>{r.momentumScore}</td>
                    <td>{r.pe ? r.pe.toFixed(1) : '-'}</td>
                    <td>{r.sectorMedianPe ? r.sectorMedianPe.toFixed(1) : '-'}</td>
                    <td className={r.peVsSector && r.peVsSector < 1 ? 'positive' : r.peVsSector > 1.3 ? 'negative' : ''}>{r.peVsSector ? r.peVsSector.toFixed(2) + 'x' : '-'}</td>
                    <td>{r.roe ? r.roe.toFixed(1) : '-'}</td>
                    <td className={r.roce >= 20 ? 'positive' : ''}>{r.roce != null ? r.roce.toFixed(1) : '-'}</td>
                    <td className={r.peg != null && r.peg > 0 && r.peg < 1 ? 'positive' : ''}>{r.peg != null && r.peg > 0 ? r.peg.toFixed(2) : '-'}</td>
                    <td className={r.netProfitYoY > 0 ? 'positive' : 'negative'}>{r.netProfitYoY ? r.netProfitYoY.toFixed(0) : '-'}</td>
                    <td className={r.netProfitQoQ > 0 ? 'positive' : 'negative'}>{r.netProfitQoQ ? r.netProfitQoQ.toFixed(0) : '-'}</td>
                    <td>{r.fScore}/9</td>
                    <td>{r.marginTrend === 'up' ? '📈' : r.marginTrend === 'down' ? '📉' : '➡️'}</td>
                    {preset && <td className={r.presetFit && r.presetFit.fitPct >= 70 ? 'positive' : ''}>{r.presetFit ? r.presetFit.fitPct + '%' : '-'}</td>}
                    <td>
                      {r.greenFlags?.length > 0 && <span className="flag-green">🟢{r.greenFlags.length}</span>}
                      {r.redFlags?.length > 0 && <span className="flag-red">🔴{r.redFlags.length}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {results.length > visibleRows && (
            <button className="mb-scan-btn" style={{ marginTop: '0.5rem', width: '100%' }}
              onClick={() => setVisibleRows(v => v + 50)}>
              Show More ({results.length - visibleRows} remaining)
            </button>
          )}
        </div>
      )}

      {/* Detail / Analysis View */}
      {selectedSymbol && (
        <div className="mb-detail">
          <button className="mb-back-btn" onClick={() => { setSelectedSymbol(null); setAnalysis(null); }}>
            ← Back to Results
          </button>
          {analysisLoading && <div className="mb-progress">Loading analysis for {selectedSymbol}...</div>}
          {analysis && <AnalysisView analysis={analysis} />}
        </div>
      )}
    </div>
  );
}

function AnalysisView({ analysis }) {
  const { header, financials, profitability, valuation, health, earningsQuality, risk, drivers, narrative, dueDiligence, exitSignals, ownership, news, dataGaps } = analysis;

  return (
    <div className="mb-analysis">
      {/* Header Scorecard */}
      <div className="mb-analysis-header">
        <div className="mb-ah-left">
          <h2>{header.name} ({header.symbol})</h2>
          <p>{header.sector} • {header.industry}</p>
          <p>₹{header.price} • Market Cap ₹{header.marketCapCr?.toLocaleString()} Cr</p>
          <p>52W: ₹{header.fiftyTwoWeekLow} – ₹{header.fiftyTwoWeekHigh} ({header.priceVs52wHigh?.toFixed(0)}% of high)</p>
        </div>
        <div className="mb-ah-right">
          <div className="mb-score-card">
            <div className="mb-big-score" style={{ color: TIER_COLORS[header.tier] }}>{header.multibaggerScore}</div>
            <div className="mb-tier-badge" style={{ background: TIER_COLORS[header.tier] }}>{header.tier.toUpperCase()}</div>
          </div>
          <div className="mb-sub-scores">
            <span>Quality: {header.qualityScore}</span>
            <span>Momentum: {header.momentumScore}</span>
          </div>
        </div>
      </div>

      {/* Narrative */}
      <div className="mb-narrative">
        <h3>📝 Analysis</h3>
        <div className="mb-narrative-text">{narrative.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}</div>
      </div>

      {/* Drivers / Flags */}
      <div className="mb-section">
        <SectionHeader icon="🎯" title="Scoring Breakdown" tooltip="Composite score breakdown across 7 fundamental axes. Each axis is scored 0-100. The weighted average produces the final multibagger score. ResultsMomentum (net profit growth) carries the highest weight." />
        <div className="mb-axes-grid">
          {Object.entries(drivers.axes).map(([axis, score]) => (
            <div key={axis} className="mb-axis-bar">
              <span className="mb-axis-name">{axis} <InfoTip text={AXIS_TOOLTIPS[axis]} /></span>
              <div className="mb-bar-track"><div className="mb-bar-fill" style={{ width: `${score}%`, background: score >= 70 ? '#22c55e' : score >= 50 ? '#eab308' : '#ef4444' }}></div></div>
              <span className="mb-axis-score">{score}</span>
            </div>
          ))}
        </div>
        {drivers.greenFlags?.length > 0 && (
          <div className="mb-flags green"><h4>🟢 Positives</h4><ul>{drivers.greenFlags.map((f, i) => <li key={i}>{f}</li>)}</ul></div>
        )}
        {drivers.redFlags?.length > 0 && (
          <div className="mb-flags red"><h4>🔴 Concerns</h4><ul>{drivers.redFlags.map((f, i) => <li key={i}>{f}</li>)}</ul></div>
        )}
      </div>

      {/* Financials */}
      <div className="mb-section">
        <SectionHeader icon="📊" title="Quarterly Results (with QoQ & YoY Growth)" tooltip="Last 5-6 quarters of results with Indian fiscal year quarter labels (Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar). Includes EBITDA, PBT, PAT with sequential and year-on-year growth rates." />
        {financials.quarterlyComparison?.length > 0 ? (
          <div className="mb-table-wrap">
            <table className="mb-table compact">
              <thead>
                <tr>
                  <th>Quarter</th>
                  <th>Revenue <InfoTip text="Total revenue/sales for the quarter" /></th>
                  <th>Revenue QoQ% <InfoTip text="Revenue growth vs previous quarter (Quarter-on-Quarter)" /></th>
                  <th>Revenue YoY% <InfoTip text="Revenue growth vs same quarter last year (Year-on-Year)" /></th>
                  <th>EBITDA <InfoTip text="Earnings Before Interest, Taxes, Depreciation & Amortization" /></th>
                  <th>EBITDA% <InfoTip text="EBITDA Margin = EBITDA / Revenue" /></th>
                  <th>EBITDA Margin Δ <InfoTip text="EBITDA margin change vs previous quarter in percentage points" /></th>
                  <th>Profit Before Tax <InfoTip text="PBT — Pre-tax Income" /></th>
                  <th>Profit After Tax <InfoTip text="PAT — Net Income after all taxes" /></th>
                  <th>PAT QoQ% <InfoTip text="Profit After Tax growth vs previous quarter (Quarter-on-Quarter)" /></th>
                  <th>PAT YoY% <InfoTip text="Profit After Tax growth vs same quarter last year (Year-on-Year) — the most important growth signal" /></th>
                  <th>Other Income <InfoTip text="Non-operating income / expense" /></th>
                  <th>Operating Margin% <InfoTip text="OPM — Operating Profit Margin = Operating Income / Revenue" /></th>
                  <th>Net Margin% <InfoTip text="NPM — Net Profit Margin = Net Income / Revenue" /></th>
                </tr>
              </thead>
              <tbody>
                {financials.quarterlyComparison.map((q, i) => (
                  <tr key={i}>
                    <td className="mb-quarter-cell">
                      <span className="mb-quarter-label">{q.quarterLabel || ''}</span>
                      <span className="mb-quarter-date">{q.date || '-'}</span>
                    </td>
                    <td>{q.revenue ? (q.revenue / 1e7).toFixed(0) + ' Cr' : '-'}</td>
                    <td className={q.revenueQoQ > 0 ? 'positive' : q.revenueQoQ < 0 ? 'negative' : ''}>{q.revenueQoQ != null ? q.revenueQoQ + '%' : '-'}</td>
                    <td className={q.revenueYoY > 0 ? 'positive' : q.revenueYoY < 0 ? 'negative' : ''}>{q.revenueYoY != null ? q.revenueYoY + '%' : '-'}</td>
                    <td>{q.ebitda ? (q.ebitda / 1e7).toFixed(0) + ' Cr' : '-'}</td>
                    <td>{q.ebitdaMargin != null ? q.ebitdaMargin + '%' : '-'}</td>
                    <td className={q.ebitdaMarginChange > 0 ? 'positive' : q.ebitdaMarginChange < 0 ? 'negative' : ''}>{q.ebitdaMarginChange != null ? (q.ebitdaMarginChange > 0 ? '+' : '') + q.ebitdaMarginChange + 'pp' : '-'}</td>
                    <td className={q.pretaxIncome > 0 ? 'positive' : q.pretaxIncome < 0 ? 'negative' : ''}>{q.pretaxIncome ? (q.pretaxIncome / 1e7).toFixed(0) + ' Cr' : '-'}</td>
                    <td className={q.netIncome > 0 ? 'positive' : 'negative'}>{q.netIncome ? (q.netIncome / 1e7).toFixed(0) + ' Cr' : '-'}</td>
                    <td className={q.netIncomeQoQ > 0 ? 'positive' : q.netIncomeQoQ < 0 ? 'negative' : ''}>{q.netIncomeQoQ != null ? q.netIncomeQoQ + '%' : '-'}</td>
                    <td className={q.netIncomeYoY > 0 ? 'positive' : q.netIncomeYoY < 0 ? 'negative' : ''}>{q.netIncomeYoY != null ? q.netIncomeYoY + '%' : '-'}</td>
                    <td>{q.otherIncome ? (q.otherIncome / 1e7).toFixed(0) + ' Cr' : '-'}</td>
                    <td>{q.opm != null ? q.opm + '%' : '-'}</td>
                    <td>{q.npm != null ? q.npm + '%' : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : financials.quarterlyResults?.length > 0 ? (
          <div className="mb-table-wrap">
            <table className="mb-table compact">
              <thead>
                <tr><th>Quarter</th><th>Revenue</th><th>Net Profit</th><th>OPM%</th><th>NPM%</th></tr>
              </thead>
              <tbody>
                {financials.quarterlyResults.slice(-6).map((q, i) => (
                  <tr key={i}>
                    <td>{q.quarterLabel || q.date || '-'}</td>
                    <td>{q.revenue ? (q.revenue / 1e7).toFixed(0) + ' Cr' : '-'}</td>
                    <td className={q.netIncome > 0 ? 'positive' : 'negative'}>{q.netIncome ? (q.netIncome / 1e7).toFixed(0) + ' Cr' : '-'}</td>
                    <td>{q.opm != null ? q.opm + '%' : '-'}</td>
                    <td>{q.npm != null ? q.npm + '%' : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="mb-no-data">No quarterly data available</p>}

        <SectionHeader icon="📈" title="Annual P&L (Year-by-Year Growth)" tooltip="Annual profit & loss comparison. Tracks revenue, EBITDA, and net profit growth with margin evolution over years." />
        {financials.annualComparison?.length > 0 ? (
          <div className="mb-table-wrap">
            <table className="mb-table compact">
              <thead>
                <tr>
                  <th>Year</th>
                  <th>Revenue</th>
                  <th>Revenue Growth% <InfoTip text="Year-over-year revenue growth" /></th>
                  <th>EBITDA <InfoTip text="Earnings Before Interest, Taxes, Depreciation & Amortization" /></th>
                  <th>EBITDA Growth% <InfoTip text="Year-over-year EBITDA growth" /></th>
                  <th>Net Profit</th>
                  <th>Net Profit Growth% <InfoTip text="Year-over-year net profit growth" /></th>
                  <th>Operating Margin% <InfoTip text="OPM — Operating Income / Revenue" /></th>
                  <th>Net Margin% <InfoTip text="NPM — Net Income / Revenue" /></th>
                  <th>OPM Change <InfoTip text="Operating margin change vs previous year in percentage points" /></th>
                </tr>
              </thead>
              <tbody>
                {financials.annualComparison.map((a, i) => (
                  <tr key={i}>
                    <td>{a.date || '-'}</td>
                    <td>{a.revenue ? (a.revenue / 1e7).toFixed(0) + ' Cr' : '-'}</td>
                    <td className={a.revenueGrowth > 0 ? 'positive' : a.revenueGrowth < 0 ? 'negative' : ''}>{a.revenueGrowth != null ? a.revenueGrowth + '%' : '-'}</td>
                    <td>{a.ebitda ? (a.ebitda / 1e7).toFixed(0) + ' Cr' : '-'}</td>
                    <td className={a.ebitdaGrowth > 0 ? 'positive' : a.ebitdaGrowth < 0 ? 'negative' : ''}>{a.ebitdaGrowth != null ? a.ebitdaGrowth + '%' : '-'}</td>
                    <td className={a.netIncome > 0 ? 'positive' : 'negative'}>{a.netIncome ? (a.netIncome / 1e7).toFixed(0) + ' Cr' : '-'}</td>
                    <td className={a.netIncomeGrowth > 0 ? 'positive' : a.netIncomeGrowth < 0 ? 'negative' : ''}>{a.netIncomeGrowth != null ? a.netIncomeGrowth + '%' : '-'}</td>
                    <td>{a.opm != null ? a.opm + '%' : '-'}</td>
                    <td>{a.npm != null ? a.npm + '%' : '-'}</td>
                    <td className={a.opmChange > 0 ? 'positive' : a.opmChange < 0 ? 'negative' : ''}>{a.opmChange != null ? (a.opmChange > 0 ? '+' : '') + a.opmChange + 'pp' : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="mb-no-data">No annual data available</p>}

        <SectionHeader icon="" title="Growth Summary" tooltip="Key growth metrics: CAGR = Compound Annual Growth Rate. YoY/QoQ = latest period growth. These feed into the scorer's growth and resultsMomentum axes." />
        <div className="mb-kv-grid">
          <KV label="Revenue CAGR 3y" value={pct(financials.growth.revenueCAGR3y)} tooltip="3-year compound annual revenue growth rate" />
          <KV label="EPS CAGR 3y" value={pct(financials.growth.epsCAGR3y)} tooltip="3-year compound annual earnings per share growth rate" />
          <KV label="Revenue YoY" value={pct(financials.growth.revenueYoY)} tooltip="Latest year-over-year revenue growth" />
          <KV label="Net Profit YoY" value={pct(financials.growth.netProfitYoY)} tooltip="Latest year-over-year net profit growth — the most important metric for stock re-rating" />
          <KV label="Net Profit QoQ" value={pct(financials.growth.netProfitQoQ)} tooltip="Quarter-over-quarter net profit growth — shows sequential acceleration" />
          <KV label="EBITDA Margin" value={pct(financials.ebitdaMargin)} tooltip="Earnings Before Interest, Taxes, Depreciation & Amortization as % of revenue" />
          <KV label="Dividend Yield" value={financials.dividendYield != null ? financials.dividendYield.toFixed(2) + '%' : '-'} tooltip="Annual dividend per share / current share price. Indicates cash return to shareholders" />
        </div>
      </div>

      {/* Visual Trend Charts */}
      {financials.quarterlyComparison?.length > 1 && (
        <div className="mb-section">
          <SectionHeader icon={<ChartBar size={18} weight="duotone" />} title="Visual Trends" tooltip="Interactive charts showing revenue, profit, and margin trends over time. Bar charts show absolute values in ₹ Cr; line charts show margins as percentages." />
          <div className="mb-charts-grid">
            <QuarterlyTrendChart data={financials.quarterlyComparison} />
            <MarginTrendChart data={financials.quarterlyComparison} />
            <ScoringRadarChart axes={drivers.axes} />
            <AnnualGrowthChart data={financials.annualComparison} />
          </div>
        </div>
      )}

      {/* Manual due-diligence + exit signals */}
      {(dueDiligence || exitSignals) && (
        <div className="mb-section">
          <SectionHeader icon="🔎" title="Manual Due-Diligence" tooltip="Items that cannot be automated — requires manual verification from annual reports, concall transcripts, and regulatory filings." />
          {dueDiligence && (
            <>
              <p className={dueDiligence.industryTailwind ? 'positive' : ''}>{dueDiligence.industryTailwind ? '🌱 ' : ''}{dueDiligence.industryTailwindNote}</p>
              {dueDiligence.qualityCriteriaTotal > 0 && (
                <p>Quality composite: <strong>{dueDiligence.qualityComposite}</strong> ({dueDiligence.qualityCriteriaMet}/{dueDiligence.qualityCriteriaTotal} criteria met)</p>
              )}
              <ul className="mb-checklist">
                {dueDiligence.checklist.map((c, i) => {
                  const icon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : c.status === 'ok' ? '✔️' : '☐';
                  const cls = c.status === 'pass' ? 'positive' : c.status === 'warn' ? 'negative' : '';
                  return <li key={i} className={cls}>{icon} {c.item} <span className="mb-checklist-note">— {c.note}</span></li>;
                })}
              </ul>
            </>
          )}
          {exitSignals && exitSignals.count > 0 && (
            <div className="mb-flags red">
              <h4>🚪 Exit Signals ({exitSignals.count})</h4>
              <ul>{exitSignals.signals.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {/* Profitability */}
      <div className="mb-section">
        <SectionHeader icon="💰" title="Profitability" tooltip="Measures how efficiently the company converts revenue into profit and deployed capital into returns. ROCE > 15% is good. ROE > 15% is good. Margin expansion signals improving pricing power or cost control." />
        <div className="mb-kv-grid">
          <KV label="ROE" value={pct(profitability.roe)} tooltip="Return on Equity — net profit as % of shareholder equity. >15% is good, >25% is excellent" />
          <KV label="ROA" value={pct(profitability.roa)} tooltip="Return on Assets — net profit as % of total assets. Measures asset efficiency" />
          <KV label="ROCE" value={pct(profitability.roce)} tooltip="Return on Capital Employed — how efficiently capital (equity + debt) generates returns. >15% is good" />
          <KV label="ROCE 5y avg" value={pct(profitability.roce5yAvg)} tooltip="5-year average ROCE — shows consistency of capital efficiency. Negative means historical losses" />
          <KV label="Gross Margin" value={pct(profitability.grossMargin)} tooltip="Revenue minus cost of goods sold, as % of revenue. Higher = better pricing power" />
          <KV label="Operating Margin" value={pct(profitability.operatingMargin)} tooltip="Operating profit as % of revenue. Measures core business profitability" />
          <KV label="OPM 5y avg" value={pct(profitability.opm5yAvg)} tooltip="5-year average operating profit margin — current OPM vs this shows trend" />
          <KV label="Net Margin" value={pct(profitability.netMargin)} tooltip="Net profit as % of revenue, after all expenses including tax and interest" />
          <KV label="Margin Trend" value={profitability.marginTrend} tooltip="Direction of operating margins: up = expanding margins, down = compressing, flat = stable" />
        </div>
      </div>

      {/* Valuation */}
      <div className="mb-section">
        <SectionHeader icon="📐" title="Valuation" tooltip="How the market is pricing the stock relative to its earnings, book value, and growth. Lower P/E vs sector and PEG < 1 suggest undervaluation. P/E alone can be misleading for high-growth stocks." />
        <div className="mb-kv-grid">
          <KV label="P/E" value={valuation.pe?.toFixed(1)} tooltip="Price-to-Earnings ratio. Market price / EPS. Lower = cheaper. Compare with sector P/E" />
          <KV label="Forward P/E" value={valuation.forwardPe?.toFixed(1)} tooltip="P/E based on estimated future earnings. Lower than trailing P/E = growth expected" />
          <KV label="P/B" value={valuation.pb?.toFixed(1)} tooltip="Price-to-Book ratio. Market cap / Book value. < 1 may signal undervaluation (or distress)" />
          <KV label="PEG" value={valuation.peg?.toFixed(2)} tooltip="P/E divided by growth rate. PEG < 1 = growth at reasonable price (GARP). PEG > 2 = expensive" />
          <KV label="EV/EBITDA" value={valuation.evToEbitda?.toFixed(1)} tooltip="Enterprise Value / EBITDA. Debt-adjusted valuation metric. Lower = cheaper. < 10 is generally attractive" />
          <KV label="P/E vs Sector" value={valuation.peVsSector ? valuation.peVsSector.toFixed(2) + 'x' : '-'} tooltip="Stock's P/E relative to sector median. < 1x = cheaper than peers. > 1.3x = premium" />
        </div>
      </div>

      {/* Health */}
      <div className="mb-section">
        <SectionHeader icon="🏥" title="Financial Health" tooltip="Balance sheet strength and ability to weather downturns. Low debt, high coverage, and strong F-Score (7+/9) indicate financial resilience." />
        <div className="mb-kv-grid">
          <KV label="Debt/Equity" value={health.debtToEquity?.toFixed(0)} tooltip="Total debt / shareholder equity. < 20 = nearly debt-free. > 100 = highly leveraged" />
          <KV label="Current Ratio" value={health.currentRatio?.toFixed(2)} tooltip="Current assets / current liabilities. > 1.5 = healthy. < 1 = liquidity risk" />
          <KV label="Interest Coverage" value={health.interestCoverage?.toFixed(1)} tooltip="Operating profit / interest expense. > 5 = comfortable. < 2 = debt service risk" />
          <KV label="F-Score" value={`${health.fScore}/9`} tooltip="Piotroski F-Score: 9-point checklist across profitability (4), leverage (3), and efficiency (2). ≥7 = strong, ≤3 = weak" />
          <KV label="Debt Free" value={health.isDebtFree ? '✅ Yes' : '❌ No'} tooltip="Whether debt/equity < 10. Debt-free companies have more financial flexibility" />
        </div>
        {health.fScoreBreakdown?.length > 0 && (
          <details className="mb-fscore-detail">
            <summary>F-Score Breakdown</summary>
            <ul>{health.fScoreBreakdown.map((b, i) => <li key={i}>{b}</li>)}</ul>
          </details>
        )}
      </div>

      {/* Earnings Quality */}
      <div className="mb-section">
        <SectionHeader icon="🔍" title="Earnings Quality" tooltip="Validates whether reported profits are real and sustainable. CFO/Profit > 80% means profits are backed by actual cash. Low dilution and normal tax rates add confidence. Growth durability assesses if recent growth is one-off or sustainable." />
        <div className="mb-kv-grid">
          <KV label="CFO/Profit" value={pct(earningsQuality.cfoToProfit)} tooltip="Cash from Operations / Net Profit. >80% = profits backed by cash. <30% = potential accrual manipulation" />
          <KV label="Effective Tax Rate" value={pct(earningsQuality.effectiveTaxRate)} tooltip="Actual taxes paid / pre-tax profit. Normal: 20-30%. Very low = one-off benefit, may not repeat" />
          <KV label="Receivable Days" value={earningsQuality.receivableDays} tooltip="Average days to collect payment. High (>120) = slow collection, potential revenue recognition risk" />
          <KV label="Inventory Days" value={earningsQuality.inventoryDays} tooltip="Average days to sell inventory. High (>150) = slow-moving stock, potential write-down risk" />
          <KV label="Dilution" value={earningsQuality.dilutionPct != null ? earningsQuality.dilutionPct.toFixed(1) + '%' : '-'} tooltip="% change in shares outstanding. Positive = shares issued (dilution). Negative = buyback (accretive)" />
          <KV label="Growth Durability" value={earningsQuality.growthDurability} tooltip="Assessment of growth sustainability: 'sustainable' = 3+ quarters + consistent margins + multi-year growth, 'moderate' = 2+ quarters or multi-year, 'one-off' = insufficient track record" />
          <KV label="Consecutive Growth Qtrs" value={earningsQuality.consecutiveGrowthQuarters} tooltip="Number of back-to-back quarters with positive profit growth. 3+ suggests a genuine trend, not a one-off" />
        </div>
      </div>

      {/* Risk */}
      <div className="mb-section">
        <SectionHeader icon="⚠️" title="Risk Assessment" tooltip="Comprehensive risk analysis across valuation, leverage, earnings quality, growth sustainability, governance, liquidity, and capital efficiency. Risks are categorized by severity (high/medium/low) and type." />
        <div className="mb-risk-header">
          <div className={`mb-risk-badge risk-${risk.overallRisk}`}>Overall Risk: {risk.overallRisk.toUpperCase()}</div>
          <div className="mb-risk-summary">
            {risk.highCount > 0 && <span className="mb-risk-count risk-high-count">{risk.highCount} High</span>}
            {risk.medCount > 0 && <span className="mb-risk-count risk-med-count">{risk.medCount} Medium</span>}
            {(risk.totalRisks - (risk.highCount || 0) - (risk.medCount || 0)) > 0 && <span className="mb-risk-count risk-low-count">{risk.totalRisks - (risk.highCount || 0) - (risk.medCount || 0)} Low</span>}
          </div>
        </div>
        {risk.riskCategories && Object.keys(risk.riskCategories).length > 0 && (
          <div className="mb-risk-categories">
            {Object.entries(risk.riskCategories).map(([type, items]) => (
              <div key={type} className="mb-risk-category">
                <h4 className="mb-risk-type-header">{RISK_TYPE_LABELS[type] || type}</h4>
                <ul className="mb-risk-list">
                  {items.map((r, i) => (
                    <li key={i} className={`risk-${r.severity}`}>
                      <span className={`mb-risk-severity-dot severity-${r.severity}`}></span>
                      {r.detail}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {risk.mitigants?.length > 0 && (
          <div className="mb-mitigants">
            <h4>✅ Mitigating Factors</h4>
            <ul>{risk.mitigants.map((m, i) => <li key={i}>{m}</li>)}</ul>
          </div>
        )}
      </div>

      {/* Ownership / Shareholding */}
      {ownership && (ownership.available || ownership.promoterHolding != null) && (
        <OwnershipSection ownership={ownership} />
      )}

      {/* News */}
      {news && (news.stock?.length > 0 || news.sector?.length > 0) && (
        <NewsSection news={news} />
      )}

      {/* Data-gap audit */}
      {dataGaps && <DataGapsSection dataGaps={dataGaps} />}
    </div>
  );
}

function OwnershipSection({ ownership }) {
  const o = ownership;
  const arrow = (t) => t === 'increasing' || t === 'accumulating' ? '▲' : t === 'decreasing' || t === 'distributing' ? '▼' : '▬';
  const cls = (t) => t === 'increasing' || t === 'accumulating' ? 'positive' : t === 'decreasing' || t === 'distributing' ? 'negative' : '';
  const ch = o.changes || {};
  const chg = (v) => v == null ? '' : ` (${v > 0 ? '+' : ''}${Number(v).toFixed(2)}pp)`;
  const chgCls = (v) => v == null ? '' : v > 0 ? 'positive' : v < 0 ? 'negative' : '';
  const mf = o.mutualFundHoldings;
  return (
    <div className="mb-section">
      <SectionHeader icon="👥" title={`Shareholding Pattern ${o.quarter ? `(as of ${o.quarter})` : ''} ${o.stale ? '⚠️ stale' : ''}`} tooltip="Quarterly shareholding breakdown from NSE/BSE filings. Shows promoter, institutional (FII/DII), mutual fund, HNI, and retail holdings. QoQ change shows accumulation/distribution trends. Smart Money Score weighs FII + MF trends." />
      {o.source && <p className="mb-checklist-note">Source: {o.source}{o.updatedAt ? ` • updated ${new Date(o.updatedAt).toLocaleDateString()}` : ''}</p>}
      <div className="mb-table-wrap">
        <table className="mb-table compact">
          <thead><tr><th>Holder</th><th>Holding %</th><th>QoQ Change</th></tr></thead>
          <tbody>
            {[
              ['Promoter', o.promoterHolding, ch.promoterChange],
              ['FII / FPI', o.fiiHolding, ch.fiiChange],
              ['DII', o.diiHolding, ch.diiChange],
              ['Mutual Funds', o.mutualFundHolding, ch.mfChange],
              ['Insurance', o.insuranceHolding, ch.insuranceChange],
              ['HNI', o.hniHolding, ch.hniChange],
              ['Retail', o.retailHolding, ch.retailChange],
            ].filter(([, v]) => v != null).map(([name, val, delta], i) => (
              <tr key={i}>
                <td>{name}</td>
                <td>{Number(val).toFixed(2)}%</td>
                <td className={chgCls(delta)}>{delta != null ? `${delta > 0 ? '+' : ''}${Number(delta).toFixed(2)}pp` : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {o.pledgedPct != null && o.pledgedPct > 0 && (
        <p className="negative">⚠️ Promoter pledge: {Number(o.pledgedPct).toFixed(2)}%</p>
      )}
      <div className="mb-kv-grid">
        <KV label="Smart Money Score" value={o.smartMoneyScore != null ? o.smartMoneyScore + '/100' : '-'} />
        <KV label="Institutional Accum." value={o.institutionalAccumScore != null ? o.institutionalAccumScore + '/100' : '-'} />
        <KV label="Promoter Confidence" value={o.promoterConfidenceScore != null ? o.promoterConfidenceScore + '/100' : '-'} />
        <KV label="Inst. Trend" value={<span className={cls(o.institutionalTrend)}>{arrow(o.institutionalTrend)} {o.institutionalTrend || '-'}</span>} />
      </div>
      {o.superstars?.length > 0 && (
        <div className="mb-mitigants">
          <h4>⭐ Marquee Investors</h4>
          <ul>{o.superstars.map((s, i) => (
            <li key={i}>{s.name}{s.pct != null ? ` — ${Number(s.pct).toFixed(2)}%` : ''}<span className={chgCls(s.changePct)}>{chg(s.changePct)}</span></li>
          ))}</ul>
        </div>
      )}
      {mf && mf.count > 0 && (
        <details className="mb-fscore-detail">
          <summary>Mutual Funds Holding ({mf.count} scheme{mf.count === 1 ? '' : 's'}{mf.period ? `, ${mf.period}` : ''})</summary>
          <ul>{mf.schemes.slice(0, 12).map((s, i) => (
            <li key={i}>{s.scheme}{s.pctOfPortfolio != null ? ` — ${Number(s.pctOfPortfolio).toFixed(2)}% of AUM` : ''}{s.valueCr != null ? ` (₹${Number(s.valueCr).toFixed(1)} Cr)` : ''}</li>
          ))}</ul>
          {mf.entered?.length > 0 && <p className="positive">Entered: {mf.entered.slice(0, 8).join(', ')}</p>}
          {mf.exited?.length > 0 && <p className="negative">Exited: {mf.exited.slice(0, 8).join(', ')}</p>}
        </details>
      )}
      {o.fiiDiiFlows && (o.fiiDiiFlows.fii || o.fiiDiiFlows.dii) && (
        <p className="mb-checklist-note">
          Market flows{o.fiiDiiFlows.date ? ` (${o.fiiDiiFlows.date})` : ''}:
          {o.fiiDiiFlows.fii ? ` FII net ₹${Number(o.fiiDiiFlows.fii.net).toFixed(0)} Cr` : ''}
          {o.fiiDiiFlows.dii ? ` • DII net ₹${Number(o.fiiDiiFlows.dii.net).toFixed(0)} Cr` : ''}
        </p>
      )}
    </div>
  );
}

function NewsSection({ news }) {
  const RECENCY_COLORS = { today: '#22c55e', this_week: '#3b82f6', this_month: '#a855f7', older: '#6b7280' };
  const RECENCY_LABELS = { today: 'Today', this_week: 'This Week', this_month: 'This Month', older: 'Older' };
  const Card = ({ n }) => {
    const recency = n.recency?.replace('_', ' ') || 'older';
    const recencyKey = n.recency || 'older';
    return (
      <a href={n.link} target="_blank" rel="noreferrer" className="mb-news-card">
        <div className="mb-news-card-header">
          <span className="mb-news-recency" style={{ background: RECENCY_COLORS[recencyKey] + '22', color: RECENCY_COLORS[recencyKey], borderColor: RECENCY_COLORS[recencyKey] }}>
            {RECENCY_LABELS[recencyKey] || recency}
          </span>
          <span className="mb-news-source">{n.source || 'news'}</span>
        </div>
        <p className="mb-news-title">{n.title}</p>
      </a>
    );
  };
  return (
    <div className="mb-section">
      <SectionHeader icon="📰" title="News" tooltip="Latest news from Google News RSS feed. Includes stock-specific and sector-level news. Recency is estimated from publication date." />
      {news.stock?.length > 0 && (
        <>
          <h4>Stock News</h4>
          <div className="mb-news-grid">{news.stock.map((n, i) => <Card key={i} n={n} />)}</div>
        </>
      )}
      {news.sector?.length > 0 && (
        <>
          <h4>Sector News</h4>
          <div className="mb-news-grid">{news.sector.map((n, i) => <Card key={i} n={n} />)}</div>
        </>
      )}
    </div>
  );
}

function DataGapsSection({ dataGaps }) {
  return (
    <div className="mb-section">
      <SectionHeader icon="🧩" title={`Data Coverage (${dataGaps.completenessPct}% — ${dataGaps.present}/${dataGaps.total} fields)`} tooltip="Completeness of fundamental data from Yahoo Finance and other sources. Missing fields may reduce scoring accuracy. Some data is only available through manual checks." />
      <div className="mb-bar-track"><div className="mb-bar-fill" style={{ width: `${dataGaps.completenessPct}%`, background: dataGaps.completenessPct >= 70 ? '#22c55e' : dataGaps.completenessPct >= 50 ? '#eab308' : '#ef4444' }}></div></div>
      {dataGaps.missing?.length > 0 && (
        <details className="mb-fscore-detail" open>
          <summary>Missing / Gaps ({dataGaps.missing.length})</summary>
          <ul>{dataGaps.missing.map((m, i) => (
            <li key={i}>❌ {m.field} <span className="mb-checklist-note">[{m.source}]{m.note ? ` — ${m.note}` : ''}</span></li>
          ))}</ul>
        </details>
      )}
      {dataGaps.notCovered?.length > 0 && (
        <details className="mb-fscore-detail">
          <summary>Out of scope (verify manually)</summary>
          <ul>{dataGaps.notCovered.map((m, i) => (
            <li key={i}>{m.field} <span className="mb-checklist-note">— {m.note}</span></li>
          ))}</ul>
        </details>
      )}
    </div>
  );
}

// ── Reusable Components ─────────────────────────────────────────────────

function InfoTip({ text }) {
  if (!text) return null;
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  const show = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const iconCenter = rect.left + rect.width / 2;
    const margin = 8;
    const tipWidth = 240; // matches max-width in CSS
    const half = tipWidth / 2;
    // Clamp so the tooltip never overflows the viewport horizontally
    let x = iconCenter;
    if (x - half < margin) x = half + margin;
    if (x + half > window.innerWidth - margin) x = window.innerWidth - margin - half;
    // Arrow should still point at the icon
    const arrowOffset = iconCenter - x; // px offset from tooltip center
    setPos({ x, y: rect.top, arrowOffset });
  }, []);
  const hide = useCallback(() => setPos(null), []);

  return (
    <span className="mb-infotip" ref={ref} onMouseEnter={show} onMouseLeave={hide} onClick={show}>
      <span className="mb-infotip-icon">i</span>
      {pos && (
        <span className="mb-infotip-content" style={{
          position: 'fixed',
          left: `${pos.x}px`,
          top: `${pos.y}px`,
          transform: 'translate(-50%, -100%) translateY(-8px)',
        }}>{text}<span className="mb-infotip-arrow" style={{ left: `calc(50% + ${pos.arrowOffset}px)` }} /></span>
      )}
    </span>
  );
}

function SectionHeader({ icon, title, tooltip }) {
  return (
    <h3 className="mb-section-header">
      {icon && <span>{icon} </span>}{title}
      {tooltip && <InfoTip text={tooltip} />}
    </h3>
  );
}

function KV({ label, value, tooltip }) {
  return (
    <div className="mb-kv">
      <span className="mb-kv-label">{label} {tooltip && <InfoTip text={tooltip} />}</span>
      <span className="mb-kv-value">{value ?? '-'}</span>
    </div>
  );
}

function pct(v) {
  if (v == null) return '-';
  return v.toFixed(1) + '%';
}

// ── Tooltip content constants ───────────────────────────────────────────

const AXIS_TOOLTIPS = {
  growth: 'Revenue & EPS compound growth rates (3y/5y CAGR). Secular growth trend assessment.',
  profitability: 'Return on equity/capital, operating margins, margin trend. Higher = better quality business.',
  health: 'Balance sheet strength: debt levels, interest coverage, Piotroski F-Score, current ratio.',
  valuation: 'P/E, PEG, P/B relative to sector. Lower = more margin of safety. Adjusted for high-growth stocks.',
  resultsMomentum: 'Net profit YoY & QoQ growth, margin trend, consecutive growth quarters. HIGHEST weight (38%) — explosive profit growth is the #1 stock price driver.',
  catalyst: 'Near-term re-rating triggers: earnings inflection, turnaround, analyst upgrades, estimate revisions.',
  earningsQuality: 'Cash backing of profits (CFO/NP), receivable/inventory days, dilution, tax rate normality.',
};

const RISK_TYPE_LABELS = {
  valuation: '📊 Valuation Risk',
  leverage: '🏦 Leverage & Debt Risk',
  liquidity_ratio: '💧 Liquidity Ratio Risk',
  earnings_quality: '🔍 Earnings Quality Risk',
  dilution: '📉 Dilution Risk',
  growth: '📈 Growth Sustainability Risk',
  profitability: '💰 Profitability Risk',
  governance: '🏛️ Governance & Promoter Risk',
  liquidity: '💱 Market Liquidity Risk',
  momentum: '📉 Price Momentum Risk',
  fundamental: '📋 Fundamental Risk',
  data: '🗄️ Data Quality Risk',
  concentration: '🎯 Concentration Risk',
};
