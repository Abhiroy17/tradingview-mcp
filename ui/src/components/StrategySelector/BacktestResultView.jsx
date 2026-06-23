import { useMemo } from 'react';
import './BacktestResultView.css';

/**
 * BacktestResultView — renders the response from POST /api/v2/analyze.
 *
 * Reads FLAT fields from the result (matching runBacktest output):
 *   totalTrades, winRate (0..100), wilsonWR (0..100), profitFactor, sharpe,
 *   sortino, calmar, maxDrawdown (0..100), totalPnl (0..100), avgWin/avgLoss,
 *   capital{...}, oos{trades,winRate,wilsonWR,totalPnl}, equity[], regimePerformance{},
 *   currentSignal{type,price,reason}, regime.
 *
 * Props:
 *   result: object from analyze response
 *   compact: boolean — short summary card vs full layout
 *   onClose: optional () => void — show close button if provided
 */
export default function BacktestResultView({ result, compact = false, onClose }) {
  const cur = result?.currentSignal;

  // Sparkline points for equity curve (works with both number arrays and {equity} objects)
  const equityPoints = useMemo(() => {
    const eq = result?.equityFull || result?.equity || [];
    if (!eq.length) return [];
    const vals = eq.map(p => typeof p === 'number' ? p : (p?.equity ?? p?.value ?? 0));
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const range = max - min || 1;
    const w = 200, h = 40;
    return vals.map((v, i) => ({
      x: (i / (vals.length - 1 || 1)) * w,
      y: h - ((v - min) / range) * h,
    }));
  }, [result]);

  if (!result) return <div className="bv-empty">No analysis yet.</div>;

  const isLive = result.mode === 'live';
  const trades = result.totalTrades ?? 0;

  return (
    <div className={`backtest-view ${compact ? 'bv-compact' : ''}`}>
      <div className="bv-head">
        <div className="bv-head-left">
          <span className="bv-strategy-name">{result.name || result.code}</span>
          <span className="bv-symbol">{result.symbol}</span>
          <span className="bv-timeframe">{result.timeframe}</span>
          {isLive && <span className="bv-mode-badge">LIVE</span>}
        </div>
        {onClose && (
          <button type="button" className="bv-close" onClick={onClose}>×</button>
        )}
      </div>

      {cur && (
        <div className={`bv-signal bv-signal-${(cur.type || '').toLowerCase()}`}>
          <span className="bv-signal-label">Current signal:</span>
          <span className="bv-signal-type">{cur.type || 'WAIT'}</span>
          {cur.price && <span className="bv-signal-price">@ {fmtPrice(cur.price)}</span>}
          {cur.reason && <span className="bv-signal-reason">{cur.reason}</span>}
        </div>
      )}

      {!isLive && (
        <>
          <div className="bv-stats">
            <Stat label="Trades" value={trades} />
            <Stat
              label="Win rate"
              value={result.winRate != null ? `${result.winRate}%` : '—'}
              sub={result.wilsonWR != null ? `Wilson ${result.wilsonWR}%` : null}
              highlight={result.winRate >= 55}
            />
            <Stat
              label="Profit factor"
              value={fmtNum(result.profitFactor, 2)}
              highlight={result.profitFactor >= 1.3}
              bad={result.profitFactor != null && result.profitFactor < 1 && result.profitFactor > 0}
            />
            <Stat
              label="Sharpe"
              value={fmtNum(result.sharpe, 2)}
              sub={result.sortino != null ? `Sortino ${result.sortino}` : null}
              highlight={result.sharpe >= 1}
            />
            <Stat
              label="Calmar"
              value={fmtNum(result.calmar, 2)}
              highlight={result.calmar >= 1}
            />
            <Stat
              label="Max DD"
              value={result.maxDrawdown != null ? `${result.maxDrawdown}%` : '—'}
              bad={result.maxDrawdown >= 20}
            />
            <Stat
              label="Total P&L"
              value={result.totalPnl != null ? `${result.totalPnl > 0 ? '+' : ''}${result.totalPnl}%` : '—'}
              sub={result.capital ? `₹${formatINR(result.capital.netProfit)}` : null}
              highlight={result.totalPnl > 0}
              bad={result.totalPnl < 0}
            />
            <Stat
              label="Avg win / loss"
              value={result.avgWin != null ? `+${result.avgWin}% / ${result.avgLoss}%` : '—'}
              sub={result.expectancy != null ? `Exp ${result.expectancy}%` : null}
            />
          </div>

          {equityPoints.length > 1 && (
            <div className="bv-equity">
              <div className="bv-equity-label">Equity curve · {trades} trades</div>
              <svg width="100%" height="40" viewBox="0 0 200 40" preserveAspectRatio="none">
                <polyline
                  points={equityPoints.map(p => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke={result.totalPnl >= 0 ? '#86efac' : '#fca5a5'}
                  strokeWidth="1.5"
                />
              </svg>
            </div>
          )}

          {result.regimePerformance && Object.keys(result.regimePerformance).length > 0 && (
            <div className="bv-regime-perf">
              <div className="bv-regime-perf-head">Performance by detected regime</div>
              <div className="bv-regime-perf-grid">
                {Object.entries(result.regimePerformance)
                  .filter(([, perf]) => (perf?.count ?? perf?.trades ?? 0) >= 1)
                  .sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0))
                  .map(([reg, perf]) => (
                    <div key={reg} className="bv-regime-perf-cell">
                      <span className={`bv-regime-tag bv-regime-${reg}`}>{reg}</span>
                      <span className="bv-rp-trades">{perf.count ?? perf.trades ?? 0}T</span>
                      <span className="bv-rp-wr">{perf.winRate != null ? `${perf.winRate}%` : '—'}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {result.oos && result.oos.trades > 0 && (
            <div className="bv-oos">
              <span className="bv-oos-label">OOS (70/30 split):</span>
              <span className="bv-oos-trades">{result.oos.trades} trades</span>
              <span className="bv-oos-wr">WR {result.oos.winRate}%</span>
              <span className="bv-oos-wr">Wilson {result.oos.wilsonWR}%</span>
              <span className={`bv-oos-pnl ${result.oos.totalPnl > 0 ? 'bv-good-text' : 'bv-bad-text'}`}>
                {result.oos.totalPnl > 0 ? '+' : ''}{result.oos.totalPnl}%
              </span>
            </div>
          )}
        </>
      )}

      {result.regime && (
        <div className="bv-regime">
          <span className="bv-regime-label">Detected regime:</span>
          <span className={`bv-regime-tag bv-regime-${result.regime}`}>{result.regime}</span>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, highlight = false, bad = false }) {
  return (
    <div className={`bv-stat ${highlight ? 'bv-good' : ''} ${bad ? 'bv-bad' : ''}`}>
      <div className="bv-stat-label">{label}</div>
      <div className="bv-stat-value">{value}</div>
      {sub && <div className="bv-stat-sub">{sub}</div>}
    </div>
  );
}

function fmtNum(v, places = 2) {
  if (v == null || !isFinite(v)) return '—';
  return v.toFixed(places);
}

function fmtPrice(p) {
  if (p == null) return '—';
  return p >= 1000 ? p.toFixed(0) : p.toFixed(2);
}

function formatINR(n) {
  if (n == null || !isFinite(n)) return '—';
  return n.toLocaleString('en-IN');
}
