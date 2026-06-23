import { useState, useMemo } from 'react';
import { useStore } from '../store';
import { useV2Api } from '../hooks/useV2Api';
import SymbolSearch from './SymbolSearch';
import InfoTooltip from './InfoTooltip';
import StrategySelector from './StrategySelector/StrategySelector';
import ScanResultGrid from './StrategySelector/ScanResultGrid';
import './ControlPanel.css';

/**
 * ControlPanel (v2 — symbol-aware)
 *
 * • Uses <StrategySelector> for strategy picks (no more LEGACY_STRATEGIES + smartAnalysis duplication)
 * • Uses /api/v2/scan + /api/v2/rank for analysis (no more chart-switching)
 * • Keeps the existing live monitoring backend (/api/start) — we just hand it cleaner inputs
 */
export default function ControlPanel({ monitoring, onStart, onStop, api }) {
  // Persistent state
  const symbol = useStore(s => s.cp_symbol);
  const interval = useStore(s => s.cp_interval);
  const selectedStrategies = useStore(s => s.cp_selectedStrategies);
  const setSymbol = useStore(s => s.setCpSymbol);
  const setInterval = useStore(s => s.setCpInterval);
  const setSelectedStrategies = useStore(s => s.setCpSelectedStrategies);

  // Ephemeral state
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [rankedResults, setRankedResults] = useState([]);

  const v2 = useV2Api();

  // Strategy filter — only backtestable strategies for live monitoring
  const strategyFilter = useMemo(() => ({ backtestableOnly: true }), []);

  // Convert string|array shape from store into stable array for component
  const selectedArray = Array.isArray(selectedStrategies) ? selectedStrategies : [];

  const handleStrategyChange = (next) => {
    setSelectedStrategies(next);
    // Clear previous ranked results when selection changes (stale data)
    if (rankedResults.length > 0) setRankedResults([]);
  };

  const analyzeSymbol = async () => {
    const s = symbol.trim();
    if (!s) { setError('Enter a symbol first'); return; }
    if (selectedArray.length === 0) { setError('Pick at least one strategy first'); return; }
    setError('');
    setAnalyzing(true);
    setRankedResults([]);

    // Build N×1 jobs: each selected strategy on the chosen symbol
    const jobs = selectedArray.map(code => ({ code, symbol: s, timeframe: '1D' }));

    const result = await v2.rank({
      jobs,
      mode: 'backtest',
      lookbackDays: 730,
      concurrency: 4,
      actionableOnly: false,
    });

    setAnalyzing(false);
    if (!result.success) {
      setError(result.error || 'Analysis failed');
      return;
    }

    setRankedResults(result.ranked || []);

    // Auto-promote the top-ranked strategy if user has many selected
    if (result.ranked?.length > 0 && selectedArray.length > 3) {
      const topThree = result.ranked.slice(0, 3).map(r => r.code);
      setSelectedStrategies(topThree);
    }
  };

  const handleStart = async () => {
    if (!symbol.trim()) { setError('Please enter a stock symbol'); return; }
    if (selectedArray.length === 0) { setError('Pick at least one strategy'); return; }

    setError('');
    setLoading(true);

    const result = await onStart({
      symbol: symbol.trim(),
      strategies: selectedArray,
      interval
    });

    setLoading(false);
    if (!result.success) {
      setError(result.error || 'Failed to start monitoring');
    }
  };

  const handleSymbolSelect = (item) => {
    if (item.full_name) {
      setSymbol(item.full_name);
    }
  };

  return (
    <div className="card control-panel">
      <div className="card-header">
        <h2>⚙️ Control Panel</h2>
        <InfoTooltip text={"Live Signal Engine (v2)\n\n• Search a symbol → pick strategies → Rank → Start Monitoring\n• Rank uses /api/v2/rank — runs all selected strategies against the symbol and scores them\n• Top-ranked strategies are highlighted; you can pick which to monitor\n• Runs selected strategies in real-time and fires buy/sell alerts"} />
        {monitoring && <span className="monitoring-badge">ACTIVE</span>}
      </div>

      {error && <div className="error-message">{error}</div>}

      {/* Symbol input */}
      <div className="control-section">
        <label className="control-label">Symbol</label>
        <div className="input-row">
          <SymbolSearch
            value={symbol}
            onChange={(v) => setSymbol(v)}
            onSelect={handleSymbolSelect}
            api={api}
            disabled={monitoring}
            placeholder="Search symbol... (RELIANCE, AAPL, BTC, ES1!)"
          />
          {!monitoring && (
            <button className="btn-analyze" onClick={analyzeSymbol} disabled={analyzing || !symbol.trim() || selectedArray.length === 0}>
              {analyzing ? '⏳' : '🧠'} {analyzing ? 'Ranking...' : 'Rank'}
            </button>
          )}
        </div>
      </div>

      {/* Scan interval */}
      <div className="control-section">
        <label className="control-label">Scan Interval</label>
        <select
          value={interval}
          onChange={e => setInterval(Number(e.target.value))}
          className="select-input full"
          disabled={monitoring}
        >
          <option value={15000}>Every 15 seconds (aggressive)</option>
          <option value={30000}>Every 30 seconds (recommended)</option>
          <option value={60000}>Every 1 minute (conservative)</option>
          <option value={120000}>Every 2 minutes (slow)</option>
        </select>
      </div>

      {/* Strategy selection — reusable v2 component */}
      <div className="control-section">
        <label className="control-label">
          Strategies
          <span className="hint-inline">— pick any combination, then Rank to score them</span>
        </label>
        <StrategySelector
          mode="multi"
          value={selectedArray}
          onChange={handleStrategyChange}
          filter={strategyFilter}
          showSearch={true}
          showMeta={true}
          disabled={monitoring}
        />
      </div>

      {/* Ranked results */}
      {rankedResults.length > 0 && (
        <div className="control-section">
          <label className="control-label">
            🏆 Ranked Results for <span className="cp-symbol-tag">{symbol}</span>
          </label>
          <ScanResultGrid
            results={rankedResults}
            loading={false}
            groupBy="none"
            onSelect={(row) => {
              // Promote a clicked row to the selection (single-pick from ranked grid)
              if (row?.code) setSelectedStrategies([row.code]);
            }}
          />
        </div>
      )}

      {/* Start monitoring */}
      <div className="control-actions">
        {!monitoring ? (
          <button
            className="btn btn-start"
            onClick={handleStart}
            disabled={loading || selectedArray.length === 0}
          >
            {loading ? '⏳ Connecting...' : `▶ Start Monitoring (${selectedArray.length} ${selectedArray.length === 1 ? 'strategy' : 'strategies'})`}
          </button>
        ) : (
          <button className="btn btn-stop" onClick={onStop}>
            ■ Stop Monitoring
          </button>
        )}
      </div>
    </div>
  );
}
