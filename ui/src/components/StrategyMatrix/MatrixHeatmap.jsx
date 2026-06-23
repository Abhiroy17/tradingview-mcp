import { useMemo } from 'react';

/**
 * MatrixHeatmap — strategy × symbol grid, cell colored by `rankingV2.score` (0..100).
 *
 * Each cell shows: blended score, badge for confidence tier, fragility flag, slope arrow.
 * Empty cells (no row in matrix) render greyed-out.
 */
export default function MatrixHeatmap({
  matrix,
  symbols,
  strategies,
  onCellClick,
  selectedCell,
  mode = 'intraday',
}) {
  // Build a (code, symbol) → row lookup
  const cellIndex = useMemo(() => {
    const m = new Map();
    for (const row of matrix || []) {
      m.set(keyOf(row.code, row.symbol), row);
    }
    return m;
  }, [matrix]);

  // Strategy display name lookup (prefer name from first matrix row of that code)
  const stratName = useMemo(() => {
    const m = new Map();
    for (const row of matrix || []) {
      if (row?.code && !m.has(row.code)) m.set(row.code, row.name || row.code);
    }
    return m;
  }, [matrix]);

  if (!matrix || matrix.length === 0) {
    return <div className="sm-empty-grid">No matrix data.</div>;
  }

  return (
    <div className="sm-heatmap-wrap">
      <table className="sm-heatmap">
        <thead>
          <tr>
            <th className="sm-hm-corner">Strategy ↓ / Symbol →</th>
            {symbols.map(sym => (
              <th key={sym} className="sm-hm-col-head">{sym}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {strategies.map(code => (
            <tr key={code}>
              <td className="sm-hm-row-head" title={stratName.get(code) || code}>
                {stratName.get(code) || code}
              </td>
              {symbols.map(sym => {
                const row = cellIndex.get(keyOf(code, sym));
                const isSelected =
                  selectedCell &&
                  selectedCell.code === code &&
                  selectedCell.symbol === sym;
                return (
                  <td
                    key={sym}
                    className={`sm-hm-cell ${isSelected ? 'sm-hm-cell-selected' : ''} ${row ? '' : 'sm-hm-cell-empty'}`}
                    style={row ? { background: cellColor(getScore(row, mode)) } : undefined}
                    onClick={() => row && onCellClick?.(row)}
                    title={row ? buildTooltip(row, mode) : 'No data'}
                  >
                    {row ? <CellContent row={row} mode={mode} /> : <span className="sm-hm-empty">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <Legend />
    </div>
  );
}

function CellContent({ row, mode = 'intraday' }) {
  const score = getScore(row, mode);
  const modeBlock = row.rankingV2?.[mode] || row.rankingV2?.intraday;
  const conf = modeBlock?.confidence || 'low';
  const slopeReason = modeBlock?.slope?.reason || '';
  const slopeIcon = slopeReason === 'heating_up' ? '↑' : slopeReason === 'cooling_down' ? '↓' : '→';
  const slopeClass = slopeReason === 'heating_up' ? 'sm-hm-slope-up' : slopeReason === 'cooling_down' ? 'sm-hm-slope-down' : 'sm-hm-slope-flat';

  return (
    <div className="sm-hm-cell-body">
      <div className="sm-hm-score">{score != null ? Math.round(score) : '—'}</div>
      <div className="sm-hm-row">
        <span className={`sm-hm-conf sm-hm-conf-${conf}`}>{confInitial(conf)}</span>
        <span className={`sm-hm-slope ${slopeClass}`}>{slopeIcon}</span>
        {modeBlock?.anyTruncated && <span className="sm-hm-frag" title="Data truncated by provider">⚠</span>}
      </div>
      <div className="sm-hm-meta">
        {modeBlock?.totalTrades != null && <span>{modeBlock.totalTrades}t</span>}
        {modeBlock?.backtestsPassed != null && <span>·{modeBlock.backtestsPassed}w</span>}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="sm-hm-legend">
      <span className="sm-hm-legend-label">Score:</span>
      <span className="sm-hm-legend-item" style={{ background: cellColor(85) }}>85+ Excellent</span>
      <span className="sm-hm-legend-item" style={{ background: cellColor(70) }}>70 Good</span>
      <span className="sm-hm-legend-item" style={{ background: cellColor(55) }}>55 Fair</span>
      <span className="sm-hm-legend-item" style={{ background: cellColor(40) }}>40 Weak</span>
      <span className="sm-hm-legend-item" style={{ background: cellColor(20) }}>&lt;30 Avoid</span>
      <span className="sm-hm-legend-sep">·</span>
      <span className="sm-hm-legend-label">Confidence:</span>
      <span className="sm-hm-conf sm-hm-conf-high">H</span>
      <span className="sm-hm-conf sm-hm-conf-medium">M</span>
      <span className="sm-hm-conf sm-hm-conf-low">L</span>
      <span className="sm-hm-legend-sep">·</span>
      <span>↑↓ recency slope · ⚠ fragile under cost stress</span>
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────────────── */

function keyOf(code, symbol) { return `${code}::${symbol}`; }

function confInitial(conf) {
  return conf === 'high' ? 'H' : conf === 'medium' ? 'M' : 'L';
}

function getScore(row, mode) {
  const r = row.rankingV2;
  if (!r) return null;
  return mode === 'swing' ? r.swingScore : r.intradayScore;
}

/**
 * Map score (0..100) → background color (red → orange → yellow → green → deep green).
 * Returns CSS rgba string.
 */
function cellColor(score) {
  if (score == null || isNaN(score)) return 'rgba(255,255,255,0.04)';
  const s = Math.max(0, Math.min(100, score));
  if (s >= 80) return 'rgba(34, 197, 94, 0.55)';   // deep green
  if (s >= 65) return 'rgba(74, 222, 128, 0.45)';  // green
  if (s >= 50) return 'rgba(250, 204, 21, 0.35)';  // yellow
  if (s >= 35) return 'rgba(251, 146, 60, 0.35)';  // orange
  return 'rgba(248, 113, 113, 0.35)';              // red
}

function buildTooltip(row, mode = 'intraday') {
  const r = row.rankingV2 || {};
  const modeBlock = r[mode] || r.intraday || {};
  const score = mode === 'swing' ? r.swingScore : r.intradayScore;
  const lines = [
    `${row.name || row.code} · ${row.symbol}`,
    `Mode: ${mode}`,
    `Score: ${score ?? '—'}`,
    `Confidence: ${modeBlock.confidence ?? '—'}`,
    `Total trades: ${modeBlock.totalTrades ?? 0}`,
    `Backtests passed: ${modeBlock.backtestsPassed ?? 0}`,
  ];
  if (modeBlock.slope?.reason === 'heating_up') lines.push('🔥 Recency: heating up');
  if (modeBlock.slope?.reason === 'cooling_down') lines.push('❄️ Recency: cooling down');
  if (modeBlock.anyTruncated) lines.push('⚠ Some data truncated by provider');
  return lines.join('\n');
}
