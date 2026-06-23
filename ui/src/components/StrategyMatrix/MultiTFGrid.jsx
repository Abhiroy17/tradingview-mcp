/**
 * MultiTFGrid — Phase 8.7 drill-in panel for a single cell.
 *
 * Shows the per-TF × per-window results grid for both Intraday and Swing
 * modes with recency slope, confidence, and GenAI signals.
 */
import './StrategyMatrix.css';

export default function MultiTFGrid({ cell, mode, onClose }) {
  if (!cell?.rankingV2) return null;
  const r = cell.rankingV2;
  const modeBlock = r[mode] || r.intraday;
  const otherMode = mode === 'intraday' ? 'swing' : 'intraday';
  const otherBlock = r[otherMode];

  return (
    <div className="sm-detail-overlay" onClick={onClose}>
      <div className="sm-detail-panel mtfg" onClick={e => e.stopPropagation()}>
        <div className="sm-detail-header">
          <h2>{cell.code} — {cell.symbol}</h2>
          <button className="sm-detail-close" onClick={onClose}>✕</button>
        </div>

        <div className="mtfg-summary">
          <div className="mtfg-mode-scores">
            <ModeScoreBadge label="⚡ Intraday" score={r.intradayScore} confidence={r.intraday?.confidence} active={mode === 'intraday'} />
            <ModeScoreBadge label="📈 Swing" score={r.swingScore} confidence={r.swing?.confidence} active={mode === 'swing'} />
          </div>
          {modeBlock.slope?.reason && modeBlock.slope.reason !== 'no_slope_for_mode' && (
            <div className={`mtfg-slope mtfg-slope-${modeBlock.slope.reason}`}>
              {slopeIcon(modeBlock.slope.reason)} Recency: {modeBlock.slope.reason.replace('_', ' ')}
              {modeBlock.slope.slope && ` (ratio ${modeBlock.slope.slope})`}
            </div>
          )}
        </div>

        <h3 className="mtfg-section-title">
          {mode === 'intraday' ? '⚡' : '📈'} {mode.charAt(0).toUpperCase() + mode.slice(1)} — Per-TF Breakdown
        </h3>
        <TFTable modeBlock={modeBlock} />

        {otherBlock && (
          <>
            <h3 className="mtfg-section-title mtfg-other">
              {otherMode === 'intraday' ? '⚡' : '📈'} {otherMode.charAt(0).toUpperCase() + otherMode.slice(1)}
            </h3>
            <TFTable modeBlock={otherBlock} />
          </>
        )}

        {cell.provider_warnings?.length > 0 && (
          <div className="mtfg-warnings">
            <strong>Provider warnings:</strong>
            {cell.provider_warnings.map((w, i) => (
              <div key={i} className="mtfg-warning-item">⚠️ {w.message}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TFTable({ modeBlock }) {
  if (!modeBlock?.tfDetails) return <p className="mtfg-empty">No data</p>;
  return (
    <table className="mtfg-table">
      <thead>
        <tr>
          <th>TF</th>
          <th>Score</th>
          <th>Trades</th>
          <th>Windows</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(modeBlock.tfDetails).map(([tf, det]) => (
          <tr key={tf}>
            <td className="mtfg-tf">{tf}</td>
            <td className="mtfg-score">
              <span className={`mtfg-score-val ${scoreColor(det.score)}`}>
                {det.missing ? '—' : (det.score * 100).toFixed(0)}
              </span>
            </td>
            <td>{det.trades ?? '—'}</td>
            <td>{det.windowsScored ?? 0}</td>
            <td className="mtfg-wd-cell">
              {det.windowDetail && Object.entries(det.windowDetail).map(([wl, wd]) => (
                <WindowChip key={wl} label={wl} wd={wd} />
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WindowChip({ label, wd }) {
  if (!wd?.ok) return <span className="mtfg-chip mtfg-chip-err" title={wd?.error}>{label}: ✕</span>;
  return (
    <span className={`mtfg-chip ${wd.bars_truncated ? 'mtfg-chip-trunc' : ''}`}
          title={`PF ${wd.profitFactor} | WR ${wd.winRate}% | DD ${wd.maxDrawdown}% | ${wd.trades} trades${wd.bars_truncated ? ' [TRUNCATED]' : ''}`}>
      {label}: PF {wd.profitFactor} ({wd.trades}t)
    </span>
  );
}

function ModeScoreBadge({ label, score, confidence, active }) {
  return (
    <div className={`mtfg-mode-badge ${active ? 'mtfg-mode-active' : ''}`}>
      <span className="mtfg-mode-label">{label}</span>
      <span className={`mtfg-mode-score ${scoreColor((score || 0) / 100)}`}>{score ?? '—'}</span>
      <span className={`mtfg-conf mtfg-conf-${confidence}`}>{confidence || '—'}</span>
    </div>
  );
}

function scoreColor(s) {
  if (s >= 0.6) return 'mtfg-green';
  if (s >= 0.35) return 'mtfg-yellow';
  return 'mtfg-red';
}

function slopeIcon(reason) {
  if (reason === 'heating_up') return '🔥';
  if (reason === 'cooling_down') return '❄️';
  return '➡️';
}
