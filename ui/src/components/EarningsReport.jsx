import { useState, useCallback } from 'react';
import './EarningsReport.css';

export default function EarningsReport() {
  const [symbol, setSymbol] = useState('');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');

  const searchSymbol = useCallback(async (q) => {
    setSearchQuery(q);
    if (q.length < 2) { setSearchResults([]); return; }
    try {
      const res = await fetch(`/api/symbol-search?q=${encodeURIComponent(q)}&exchange=NSE,BSE`);
      const data = await res.json();
      setSearchResults(data.results?.slice(0, 8) || []);
    } catch { setSearchResults([]); }
  }, []);

  const selectSymbol = useCallback((sym) => {
    const formatted = sym.includes(':') ? sym : `NSE:${sym}`;
    setSymbol(formatted);
    setSearchQuery(sym.replace('NSE:', '').replace('BSE:', ''));
    setSearchResults([]);
    loadReport(formatted);
  }, []);

  const loadReport = useCallback(async (sym) => {
    const target = sym || symbol;
    if (!target) return;
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const res = await fetch(`/api/v2/stock/earnings-report?symbol=${encodeURIComponent(target)}`);
      const data = await res.json();
      if (data.success) {
        setReport(data.report);
      } else {
        setError(data.error || 'Failed to load earnings report');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  const fmtGrowth = (val) => {
    if (val == null) return <span className="er-na">-</span>;
    const cls = val > 0 ? 'er-positive' : val < 0 ? 'er-negative' : '';
    return <span className={cls}>{val > 0 ? '+' : ''}{val}%</span>;
  };

  return (
    <div className="earnings-report-panel">
      <div className="er-header">
        <h2>📊 Quarterly Earnings Report</h2>
        <p className="er-subtitle">Formatted results for any stock — Revenue, EBITDA, PBT, PAT with YoY & QoQ growth</p>
      </div>

      <div className="er-search-bar">
        <div className="er-search-input-wrap">
          <input
            type="text"
            placeholder="Search stock (e.g., JUSTDIAL, RELIANCE, TCS)..."
            value={searchQuery}
            onChange={(e) => searchSymbol(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchQuery) selectSymbol(searchQuery);
            }}
            className="er-search-input"
          />
          {searchResults.length > 0 && (
            <div className="er-search-dropdown">
              {searchResults.map((r, i) => (
                <div key={i} className="er-search-item" onClick={() => selectSymbol(r.full_name || r.symbol)}>
                  <span className="er-search-symbol">{r.symbol || r.full_name}</span>
                  <span className="er-search-desc">{r.description}</span>
                  <span className="er-search-exchange">{r.exchange}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => loadReport()} disabled={loading || !symbol} className="er-btn">
          {loading ? 'Loading...' : 'Get Report'}
        </button>
      </div>

      {error && <div className="er-error">{error}</div>}

      {loading && <div className="er-loading">Fetching earnings data...</div>}

      {report && report.summary && (
        <div className="er-report">
          <div className="er-report-header">
            <h3>{report.summary.title}</h3>
            <div className="er-meta">
              {report.sector && <span className="er-tag">{report.sector}</span>}
              {report.industry && <span className="er-tag">{report.industry}</span>}
              {report.marketCap && <span className="er-tag">MCap: {report.marketCap}</span>}
            </div>
          </div>

          {/* Formatted Summary (like the user's example) */}
          <div className="er-summary-card">
            {report.summary.lines.map((line, i) => (
              <div key={i} className="er-summary-line">{line}</div>
            ))}
          </div>

          {/* Detailed Quarterly Table */}
          {report.quarters?.length > 0 && (
            <div className="er-table-section">
              <h4>Quarter-by-Quarter Breakdown</h4>
              <div className="er-table-wrap">
                <table className="er-table">
                  <thead>
                    <tr>
                      <th>Quarter</th>
                      <th>Revenue (Cr)</th>
                      <th>Rev YoY</th>
                      <th>Rev QoQ</th>
                      <th>EBITDA (Cr)</th>
                      <th>EBITDA %</th>
                      <th>PBT (Cr)</th>
                      <th>PBT YoY</th>
                      <th>PAT (Cr)</th>
                      <th>PAT YoY</th>
                      <th>PAT QoQ</th>
                      <th>Other Inc (Cr)</th>
                      <th>OPM %</th>
                      <th>NPM %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.quarters.slice(-8).map((q, i) => (
                      <tr key={i} className={i === report.quarters.slice(-8).length - 1 ? 'er-latest' : ''}>
                        <td className="er-quarter-cell">{q.quarter}</td>
                        <td>{q.revenue ?? '-'}</td>
                        <td>{fmtGrowth(q.revenueYoY)}</td>
                        <td>{fmtGrowth(q.revenueQoQ)}</td>
                        <td>{q.ebitda ?? '-'}</td>
                        <td>{q.ebitdaMargin != null ? q.ebitdaMargin + '%' : '-'}</td>
                        <td>{q.pbt ?? '-'}</td>
                        <td>{fmtGrowth(q.pbtYoY)}</td>
                        <td>{q.pat ?? '-'}</td>
                        <td>{fmtGrowth(q.patYoY)}</td>
                        <td>{fmtGrowth(q.patQoQ)}</td>
                        <td>{q.otherIncome ?? '-'}</td>
                        <td>{q.operatingMargin != null ? q.operatingMargin + '%' : '-'}</td>
                        <td>{q.netMargin != null ? q.netMargin + '%' : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {report && !report.summary && (
        <div className="er-no-data">
          <p>No quarterly earnings data available for {report.symbol || symbol}</p>
          {report.error && <p className="er-error-detail">{report.error}</p>}
        </div>
      )}
    </div>
  );
}
