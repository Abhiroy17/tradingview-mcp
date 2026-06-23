import { useState, useCallback, useMemo } from 'react';
import { useV2Api } from '../../hooks/useV2Api.js';
import StrategySelector from '../StrategySelector/StrategySelector.jsx';
import SymbolPicker from '../StrategySelector/SymbolPicker.jsx';
import MatrixHeatmap from './MatrixHeatmap.jsx';
import MatrixLeaderboard from './MatrixLeaderboard.jsx';
import MultiWindowDetail from './MultiWindowDetail.jsx';
import MultiTFGrid from './MultiTFGrid.jsx';
import './StrategyMatrix.css';

const DEFAULT_PROVIDER = 'js';
const DEFAULT_COST_PROFILE = 'base';

/**
 * StrategyMatrixView (Phase 8.7)
 *
 * Orchestrates the HFT mode-aware backtest matrix:
 *   Intraday : 5m (3M + 6M) + 15m (6M) — recency-weighted
 *   Swing    : 15m / 1H / 4H / Daily × 6M — multi-TF blended
 *   Both     : runs both modes so UI can toggle without re-running
 *
 *   POST /api/v2/matrix/modes/rank
 */
export default function StrategyMatrixView() {
  const api = useV2Api();

  // Controls
  const [symbols, setSymbols] = useState(['NSE:RELIANCE', 'NSE:INFY', 'NSE:TCS']);
  const [strategies, setStrategies] = useState([]);
  const [mode, setMode] = useState('intraday');             // 'intraday' | 'swing'
  const [costProfile, setCostProfile] = useState(DEFAULT_COST_PROFILE);
  const [topN, setTopN] = useState(3);
  const [highConfidenceOnly, setHighConfidenceOnly] = useState(false);
  const [viewMode, setViewMode] = useState('heatmap');       // 'heatmap' | 'leaderboard'

  // Results
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [matrix, setMatrix] = useState(null);
  const [topPerSymbol, setTopPerSymbol] = useState(null);
  const [stats, setStats] = useState(null);
  const [selectedCell, setSelectedCell] = useState(null);

  // Build cells — no timeframe; backend expands per mode
  const cells = useMemo(() => {
    const out = [];
    for (const code of strategies) {
      for (const sym of symbols) {
        out.push({ code, symbol: sym });
      }
    }
    return out;
  }, [strategies, symbols]);

  const totalCells = cells.length;
  const tooMany = totalCells > 50;

  const handleRun = useCallback(async () => {
    if (!cells.length) { setError('Pick at least one strategy and one symbol.'); return; }
    if (tooMany) { setError(`Too many cells (${totalCells}). Max 50 per run.`); return; }

    setRunning(true);
    setError(null);
    setMatrix(null);
    setTopPerSymbol(null);
    setStats(null);
    setSelectedCell(null);

    const t0 = Date.now();
    try {
      const res = await api.matrixModesRank({
        cells,
        mode: 'both',       // always run both so toggle is instant
        sortBy: mode,
        costProfile,
        topN,
        highConfidenceOnly,
        genai: true,
        limit: 200,
      });
      if (!res.success) throw new Error(res.error || 'matrixModesRank failed');
      setMatrix(res.ranked || []);
      setTopPerSymbol(res.topNPerSymbol || null);
      setStats({
        totalRanked: res.totalRanked,
        cells: totalCells,
        elapsedMs: Date.now() - t0,
        mode: res.mode,
        sortBy: res.sortBy,
        costProfile,
      });
    } catch (err) {
      setError(err.message || String(err));
    }
    setRunning(false);
  }, [api, cells, totalCells, tooMany, mode, costProfile, topN, highConfidenceOnly]);

  // Re-sort existing results when mode toggle changes (no re-run needed)
  const sortedMatrix = useMemo(() => {
    if (!matrix) return null;
    const sortKey = mode === 'swing' ? 'swingScore' : 'intradayScore';
    const copy = [...matrix];
    copy.sort((a, b) => (b.rankingV2?.[sortKey] ?? 0) - (a.rankingV2?.[sortKey] ?? 0));
    copy.forEach((c, i) => { if (c.rankingV2) c.rankingV2.rank = i + 1; });
    return copy;
  }, [matrix, mode]);

  const handleCellClick = useCallback((cell) => {
    setSelectedCell(cell);
  }, []);

  return (
    <div className="strategy-matrix">
      <div className="sm-header">
        <h1 className="sm-title">🎯 Strategy Matrix</h1>
        <p className="sm-subtitle">
          HFT mode-aware backtesting — Intraday (5m/15m, recency-weighted) or
          Swing (15m/1H/4H/Daily). Scores both modes in a single run.
        </p>
      </div>

      <div className="sm-controls">
        <div className="sm-ctrl-row">
          <div className="sm-ctrl">
            <label className="sm-label">Symbols ({symbols.length})</label>
            <SymbolPicker
              mode="multi"
              value={symbols}
              onChange={setSymbols}
              max={20}
              placeholder="Add symbol (NSE:RELIANCE, AAPL…)"
              disabled={running}
            />
          </div>

          <div className="sm-ctrl sm-ctrl-narrow">
            <label className="sm-label">Signal Mode</label>
            <ToggleGroup
              value={mode}
              options={[
                { value: 'intraday', label: '⚡ Intraday' },
                { value: 'swing', label: '📈 Short-term Swing' },
              ]}
              onChange={setMode}
            />
          </div>
        </div>

        <div className="sm-ctrl-row">
          <div className="sm-ctrl sm-ctrl-wide">
            <label className="sm-label">Strategies ({strategies.length})</label>
            <StrategySelector
              mode="multi"
              value={strategies}
              onChange={setStrategies}
              filter={{ backtestableOnly: true }}
              showMeta={false}
              disabled={running}
            />
          </div>
        </div>

        <div className="sm-ctrl-row sm-ctrl-row-flex">
          <ToggleGroup
            label="Cost profile"
            value={costProfile}
            options={[
              { value: 'base', label: 'Base (10/5 bps)' },
              { value: 'stress', label: 'Stress (25/15 bps)' },
            ]}
            onChange={setCostProfile}
            disabled={running}
          />

          <div className="sm-ctrl sm-ctrl-narrow">
            <label className="sm-label">Top per symbol</label>
            <select
              className="sm-select"
              value={topN}
              onChange={e => setTopN(Number(e.target.value))}
              disabled={running}
            >
              <option value={1}>Top 1</option>
              <option value={3}>Top 3</option>
              <option value={5}>Top 5</option>
              <option value={10}>Top 10</option>
            </select>
          </div>

          <label className="sm-check">
            <input
              type="checkbox"
              checked={highConfidenceOnly}
              onChange={e => setHighConfidenceOnly(e.target.checked)}
              disabled={running}
            />
            High confidence only
          </label>

          <div className="sm-spacer" />

          <button
            type="button"
            className="sm-btn-run"
            onClick={handleRun}
            disabled={running || !cells.length || tooMany}
          >
            {running ? '⏳ Running matrix…' : `▶ Run ${totalCells} cells`}
          </button>
        </div>

        {tooMany && (
          <div className="sm-warning">
            ⚠️ {totalCells} cells exceeds the 50-cell cap. Trim symbols or strategies.
          </div>
        )}
      </div>

      {error && (
        <div className="sm-error">
          <span className="sm-error-icon">⚠️</span>
          <div className="sm-error-body">
            <div className="sm-error-title">Matrix run failed</div>
            <div className="sm-error-msg">{error}</div>
          </div>
        </div>
      )}

      {sortedMatrix && (
        <>
          <div className="sm-result-head">
            <div className="sm-stats">
              <span className="sm-stat">
                <strong>{stats?.totalRanked ?? sortedMatrix.length}</strong> ranked
              </span>
              <span className="sm-stat">
                <strong>{stats?.cells}</strong> cells
              </span>
              <span className="sm-stat">
                <span className={`sm-mode-badge sm-mode-${mode}`}>
                  {mode === 'intraday' ? '⚡ Intraday' : '📈 Swing'}
                </span>
              </span>
              <span className="sm-stat">
                <span className={`sm-cost-badge sm-cost-${stats?.costProfile}`}>
                  {stats?.costProfile === 'stress' ? 'Cost stress' : 'Base cost'}
                </span>
              </span>
              <span className="sm-stat sm-stat-meta">
                {(stats?.elapsedMs / 1000).toFixed(1)}s
              </span>
            </div>

            <ToggleGroup
              value={viewMode}
              options={[
                { value: 'heatmap', label: '🔥 Heatmap' },
                { value: 'leaderboard', label: '🏆 Leaderboard' },
              ]}
              onChange={setViewMode}
            />
          </div>

          {viewMode === 'heatmap' && (
            <MatrixHeatmap
              matrix={sortedMatrix}
              symbols={symbols}
              strategies={strategies}
              onCellClick={handleCellClick}
              selectedCell={selectedCell}
              mode={mode}
            />
          )}

          {viewMode === 'leaderboard' && (
            <MatrixLeaderboard
              topPerSymbol={topPerSymbol}
              matrix={sortedMatrix}
              topN={topN}
              onCellClick={handleCellClick}
              mode={mode}
            />
          )}

          {selectedCell && (
            <MultiTFGrid
              cell={selectedCell}
              mode={mode}
              onClose={() => setSelectedCell(null)}
            />
          )}
        </>
      )}

      {!matrix && !running && !error && (
        <div className="sm-empty">
          Configure cells above and hit <strong>Run</strong> to see the matrix.
          <ul className="sm-empty-tips">
            <li>⚡ <strong>Intraday</strong>: 5m + 15m TFs, recency-weighted (3M vs 6M)</li>
            <li>📈 <strong>Swing</strong>: 15m/1H/4H/Daily × 6M, multi-TF blended</li>
            <li>🔬 <strong>Both modes scored</strong> in a single run — toggle instantly</li>
            <li>🧠 <strong>GenAI-ready</strong>: each cell produces a structured signal payload</li>
            <li>🛡 <strong>Cost stress</strong>: switch profile to flag fragile edges</li>
          </ul>
        </div>
      )}
    </div>
  );
}

/* ── tiny helpers ─────────────────────────────────────────────── */

function ToggleGroup({ label, value, options, onChange, disabled = false }) {
  return (
    <div className="sm-toggle-group">
      {label && <span className="sm-label sm-toggle-label">{label}</span>}
      <div className="sm-toggle-wrap">
        {options.map(opt => (
          <button
            key={opt.value}
            type="button"
            className={`sm-toggle ${value === opt.value ? 'sm-toggle-active' : ''}`}
            onClick={() => onChange(opt.value)}
            disabled={disabled}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
