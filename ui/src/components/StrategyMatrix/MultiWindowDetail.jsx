import { useMemo } from 'react';

/**
 * MultiWindowDetail — drilldown panel for a single (strategy, symbol) cell.
 *
 * Shows the per-window flat metrics (1Y/6M/3M/1M) side-by-side as a tabular grid,
 * plus the rankingV2 component breakdown.
 */
export default function MultiWindowDetail({ cell, onClose }) {
  const windows = cell?.windows || {};
  const r = cell?.rankingV2 || {};
  const wScores = r.windowScores || {};

  const orderedKeys = useMemo(() => {
    const preferred = ['1y', '6m', '3m', '1m'];
    return preferred.filter(k => windows[k]);
  }, [windows]);

  if (!cell) return null;

  return (
    <div className="sm-detail">
      <div className="sm-detail-head">
        <div className="sm-detail-title">
          <span className="sm-detail-strategy">{cell.name || cell.code}</span>
          <span className="sm-detail-sep">·</span>
          <span className="sm-detail-symbol">{cell.symbol}</span>
          <span className="sm-detail-sep">·</span>
          <span className="sm-detail-tf">{cell.timeframe || '—'}</span>
          {cell.provider && (
            <span className={`sm-provider-badge sm-provider-${cell.provider === 'tv_strategy_tester' ? 'tv' : 'js'}`}>
              {cell.provider === 'tv_strategy_tester' ? 'TV' : 'JS'}
            </span>
          )}
        </div>
        <button type="button" className="sm-detail-close" onClick={onClose}>×</button>
      </div>

      <div className="sm-detail-summary">
        <SummaryStat label="Score" value={r.score != null ? r.score.toFixed(1) : '—'} bold />
        <SummaryStat label="Blended" value={r.blended?.toFixed(1) ?? '—'} />
        <SummaryStat label="Shrunk" value={r.shrunk?.toFixed(1) ?? '—'} />
        <SummaryStat
          label="Slope (1M/6M)"
          value={r.slope != null ? `${r.slope > 0 ? '+' : ''}${(r.slope * 100).toFixed(1)}%` : '—'}
          tone={r.slope > 0.02 ? 'good' : r.slope < -0.02 ? 'bad' : 'neutral'}
        />
        <SummaryStat label="Trades (1Y+6M)" value={r.totalTrades ?? 0} />
        <SummaryStat label="Confidence" value={r.confidence ?? '—'} />
        {r.fragilityPenalty < 0 && (
          <SummaryStat label="Fragility" value="⚠ fragile" tone="bad" />
        )}
      </div>

      {orderedKeys.length === 0 ? (
        <div className="sm-detail-empty">No per-window data on this cell.</div>
      ) : (
        <div className="sm-detail-windows-wrap">
          <table className="sm-detail-windows">
            <thead>
              <tr>
                <th>Metric</th>
                {orderedKeys.map(k => {
                  const w = windows[k];
                  return (
                    <th key={k} className="sm-detail-win-head">
                      <div className="sm-detail-win-label">{k.toUpperCase()}</div>
                      {w?.days && <div className="sm-detail-win-days">{w.days}d</div>}
                      {wScores[k] != null && (
                        <div className="sm-detail-win-score">score {Math.round(wScores[k])}</div>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {METRIC_ROWS.map(m => (
                <tr key={m.key}>
                  <td className="sm-detail-metric-name">{m.label}</td>
                  {orderedKeys.map(k => {
                    const w = windows[k];
                    if (!w?.ok || !w.result) {
                      return <td key={k} className="sm-detail-metric-na">—</td>;
                    }
                    return (
                      <td key={k} className="sm-detail-metric-val">
                        {m.fmt(w.result[m.key], w.result)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryStat({ label, value, tone = 'neutral', bold = false }) {
  return (
    <div className={`sm-detail-stat sm-detail-stat-${tone} ${bold ? 'sm-detail-stat-bold' : ''}`}>
      <div className="sm-detail-stat-label">{label}</div>
      <div className="sm-detail-stat-value">{value}</div>
    </div>
  );
}

/* ── Metric row defs ─────────────────────────────────────────────── */
const METRIC_ROWS = [
  { key: 'totalTrades',   label: 'Trades',         fmt: v => v ?? 0 },
  { key: 'winRate',       label: 'Win rate',       fmt: v => v != null ? `${Math.round(v)}%` : '—' },
  { key: 'wilsonWR',      label: 'Wilson WR',      fmt: v => v != null ? `${Math.round(v)}%` : '—' },
  { key: 'profitFactor',  label: 'Profit factor',  fmt: v => v != null ? v.toFixed(2) : '—' },
  { key: 'sharpe',        label: 'Sharpe',         fmt: v => v != null ? v.toFixed(2) : '—' },
  { key: 'sortino',       label: 'Sortino',        fmt: v => v != null ? v.toFixed(2) : '—' },
  { key: 'calmar',        label: 'Calmar',         fmt: v => v != null ? v.toFixed(2) : '—' },
  { key: 'maxDrawdown',   label: 'Max DD %',       fmt: v => v != null ? `${v.toFixed(1)}%` : '—' },
  { key: 'totalPnl',      label: 'Total P&L %',    fmt: v => v != null ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—' },
  { key: 'expectancy',    label: 'Expectancy %',   fmt: v => v != null ? `${v.toFixed(2)}%` : '—' },
];
