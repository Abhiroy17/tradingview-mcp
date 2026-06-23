import { useMemo } from 'react';

/**
 * MatrixLeaderboard — top-N strategies per symbol, grouped by symbol.
 *
 * Each card shows: rank, score, confidence tier, slope, fragility, trade count.
 * Click → drill into MultiWindowDetail.
 */
export default function MatrixLeaderboard({ topPerSymbol, matrix, topN, onCellClick, mode = 'intraday' }) {
  const scoreKey = mode === 'swing' ? 'swingScore' : 'intradayScore';
  // Fall back: if backend didn't return topPerSymbol, build from `matrix`
  const grouped = useMemo(() => {
    if (topPerSymbol && Object.keys(topPerSymbol).length) return topPerSymbol;
    const map = {};
    for (const row of matrix || []) {
      if (!map[row.symbol]) map[row.symbol] = [];
      map[row.symbol].push(row);
    }
    for (const sym of Object.keys(map)) {
      map[sym] = map[sym]
        .sort((a, b) => (b.rankingV2?.[scoreKey] ?? 0) - (a.rankingV2?.[scoreKey] ?? 0))
        .slice(0, topN || 3);
    }
    return map;
  }, [topPerSymbol, matrix, topN, scoreKey]);

  const symbolList = Object.keys(grouped).sort();

  if (symbolList.length === 0) {
    return <div className="sm-empty-grid">No leaderboard data.</div>;
  }

  return (
    <div className="sm-leaderboard">
      {symbolList.map(sym => (
        <div key={sym} className="sm-lb-symbol">
          <div className="sm-lb-symbol-head">
            <span className="sm-lb-symbol-name">{sym}</span>
            <span className="sm-lb-symbol-meta">{grouped[sym].length} top picks</span>
          </div>
          <div className="sm-lb-cards">
            {grouped[sym].map((row, idx) => (
              <LeaderboardCard
                key={`${row.code}-${idx}`}
                row={row}
                rank={idx + 1}
                mode={mode}
                onClick={() => onCellClick?.(row)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function LeaderboardCard({ row, rank, mode = 'intraday', onClick }) {
  const r = row.rankingV2 || {};
  const modeBlock = r[mode] || r.intraday || {};
  const score = mode === 'swing' ? r.swingScore : r.intradayScore;
  const conf = modeBlock.confidence || 'low';
  const slopeReason = modeBlock.slope?.reason || '';

  return (
    <button type="button" className={`sm-lb-card sm-lb-card-rank-${rank}`} onClick={onClick}>
      <div className="sm-lb-card-head">
        <span className={`sm-lb-rank sm-lb-rank-${rank}`}>#{rank}</span>
        <span className="sm-lb-name">{row.name || row.code}</span>
        <span className={`sm-lb-conf sm-lb-conf-${conf}`}>{conf.toUpperCase()}</span>
      </div>

      <div className="sm-lb-score-row">
        <span className="sm-lb-score">{score != null ? Math.round(score) : '—'}</span>
        <span className="sm-lb-score-label">/100</span>
        {modeBlock.anyTruncated && <span className="sm-lb-fragile" title="Data truncated by provider">⚠ truncated</span>}
      </div>

      <div className="sm-lb-metric-row">
        <Metric label="Trades" value={modeBlock.totalTrades ?? 0} />
        <Metric label="Backtests" value={modeBlock.backtestsPassed ?? 0} />
        <Metric
          label="Recency"
          value={slopeReason === 'heating_up' ? '🔥 heating' : slopeReason === 'cooling_down' ? '❄️ cooling' : '→ stable'}
          tone={slopeReason === 'heating_up' ? 'good' : slopeReason === 'cooling_down' ? 'bad' : 'neutral'}
        />
      </div>

      <div className="sm-lb-windows">
        {Object.entries(modeBlock.tfScores || {}).map(([tf, s]) => (
          <div key={tf} className="sm-lb-window">
            <div className="sm-lb-window-label">{tf}</div>
            <div className="sm-lb-window-score">{s != null ? Math.round(s * 100) : '—'}</div>
          </div>
        ))}
      </div>

      <div className="sm-lb-footer">
        <span className="sm-lb-meta">{modeBlock.totalTrades ?? 0} trades · {modeBlock.backtestsPassed ?? 0} backtests</span>
        {r.meta?.family && <span className="sm-lb-family">{r.meta.family}</span>}
      </div>
    </button>
  );
}

function Metric({ label, value, tone = 'neutral' }) {
  return (
    <div className={`sm-lb-metric sm-lb-metric-${tone}`}>
      <div className="sm-lb-metric-label">{label}</div>
      <div className="sm-lb-metric-value">{value}</div>
    </div>
  );
}
