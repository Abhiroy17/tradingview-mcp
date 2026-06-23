import { useState, useEffect, useRef, useMemo } from 'react';
import { useStore } from '../store';
import { useV2Api } from '../hooks/useV2Api';
import SymbolSearch from './SymbolSearch';
import InfoTooltip from './InfoTooltip';
import StrategySelector from './StrategySelector/StrategySelector';
import ScanResultGrid from './StrategySelector/ScanResultGrid';
import './WatchlistPanel.css';

export default function WatchlistPanel({ api }) {
  // Persistent state (survives tab switches)
  const selectedSymbols = useStore(s => s.wl_selectedSymbols);
  const selectAll = useStore(s => s.wl_selectAll);
  const scanResults = useStore(s => s.wl_scanResults);
  const scanning = useStore(s => s.wl_scanning);
  const scanInterval = useStore(s => s.wl_scanInterval);
  const strategyOverrides = useStore(s => s.wl_strategyOverrides);
  const setSelectedSymbols = useStore(s => s.setWlSelectedSymbols);
  const setSelectAll = useStore(s => s.setWlSelectAll);
  const setScanResults = useStore(s => s.setWlScanResults);
  const setScanning = useStore(s => s.setWlScanning);
  const setScanInterval = useStore(s => s.setWlScanInterval);
  const setStrategyOverride = useStore(s => s.setWlStrategyOverride);

  // v2 Quick Scan state (persistent)
  const v2Strategies = useStore(s => s.wl_v2Strategies);
  const v2Timeframe = useStore(s => s.wl_v2Timeframe);
  const v2Mode = useStore(s => s.wl_v2Mode);
  const setV2Strategies = useStore(s => s.setWlV2Strategies);
  const setV2Timeframe = useStore(s => s.setWlV2Timeframe);
  const setV2Mode = useStore(s => s.setWlV2Mode);

  // Live Matrix Scanner state (persistent)
  const matrixScanning = useStore(s => s.wl_matrixScanning);
  const matrixResults = useStore(s => s.wl_matrixResults);
  const matrixStrategies = useStore(s => s.wl_matrixStrategies);
  const matrixTimeframe = useStore(s => s.wl_matrixTimeframe);
  const matrixInterval = useStore(s => s.wl_matrixInterval);
  const matrixMode = useStore(s => s.wl_matrixMode);
  const setMatrixScanning = useStore(s => s.setWlMatrixScanning);
  const setMatrixResults = useStore(s => s.setWlMatrixResults);
  const setMatrixStrategies = useStore(s => s.setWlMatrixStrategies);
  const setMatrixTimeframe = useStore(s => s.setWlMatrixTimeframe);
  const setMatrixInterval = useStore(s => s.setWlMatrixInterval);
  const setMatrixMode = useStore(s => s.setWlMatrixMode);

  // Munafa tips dropdown state (persistent)
  const munafaOptions = useStore(s => s.wl_munafaOptions);
  const munafaSelected = useStore(s => s.wl_munafaSelected);
  const munafaLastFetchAt = useStore(s => s.wl_munafaLastFetchAt);
  const setMunafaOptions = useStore(s => s.setWlMunafaOptions);
  const setMunafaSelected = useStore(s => s.setWlMunafaSelected);
  const setMunafaLastFetchAt = useStore(s => s.setWlMunafaLastFetchAt);

  // Ephemeral state
  const [watchlist, setWatchlist] = useState([]);
  const [newSymbol, setNewSymbol] = useState('');
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState(null);
  const [availableStrategies, setAvailableStrategies] = useState([]);
  const [showStrategyConfig, setShowStrategyConfig] = useState(false);

  // v2 ephemeral state
  const [v2Scanning, setV2Scanning] = useState(false);
  const [v2Results, setV2Results] = useState([]);
  const [v2Error, setV2Error] = useState('');
  const [munafaBusy, setMunafaBusy] = useState(false);
  const [munafaMessage, setMunafaMessage] = useState('');

  const v2 = useV2Api();
  const sseRef = useRef(null);

  useEffect(() => {
    loadWatchlist();
    loadScannerStatus();
    loadScannerResults();
    loadStrategies();
    loadMatrixStatus();
    loadMunafaTipsSymbols();

    // SSE for live scanner updates
    const evtSource = new EventSource('/api/events');
    evtSource.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'scanner_result') {
          setScanResults(prev => ({ ...prev, [msg.data.symbol]: msg.data }));
        }
        if (msg.type === 'scanner_complete') {
          setScanProgress(null);
        }
        if (msg.type === 'watchlist_update') {
          setWatchlist(msg.data);
        }
        if (msg.type === 'matrix_scanner_update') {
          setMatrixResults(msg.data.results || []);
        }
      } catch {}
    };
    sseRef.current = evtSource;
    return () => evtSource.close();
  }, []);

  const loadWatchlist = async () => {
    const data = await api.getWatchlist();
    if (data.watchlist) setWatchlist(data.watchlist);
  };

  const loadScannerStatus = async () => {
    const data = await api.getScannerStatus();
    if (data.success) {
      setScanning(data.scanning);
      if (data.symbols && Array.isArray(data.symbols)) {
        if (data.symbols.includes('ALL')) {
          setSelectAll(true);
          setSelectedSymbols([]);
        } else {
          setSelectedSymbols(data.symbols);
          setSelectAll(false);
        }
      }
    }
  };

  const loadScannerResults = async () => {
    const data = await api.getScannerResults();
    if (data.success && data.results) setScanResults(data.results);
  };

  const loadStrategies = async () => {
    const data = await api.getStrategies();
    if (data.success && data.strategies) setAvailableStrategies(data.strategies);
  };

  const loadMatrixStatus = async () => {
    try {
      const data = await api.getMatrixScannerStatus();
      if (data?.scanning) {
        setMatrixScanning(true);
        const res = await api.getMatrixScannerResults();
        if (res?.results) setMatrixResults(res.results);
      }
    } catch {}
  };

  const loadMunafaTipsSymbols = async () => {
    try {
      const data = await api.getTipsSourceSymbols();
      if (data?.success && Array.isArray(data.symbols)) {
        setMunafaOptions(data.symbols);
        setMunafaLastFetchAt(data.lastRunAt || null);
      }
    } catch {}
  };

  const fetchMunafaTipsNow = async () => {
    setMunafaBusy(true);
    setMunafaMessage('');
    try {
      const res = await api.refreshTipsSource();
      if (res?.success) {
        const symbols = Array.isArray(res.mergedSymbols) ? res.mergedSymbols : [];
        setMunafaOptions(symbols);
        setMunafaLastFetchAt(new Date().toISOString());
        setMunafaMessage(`Fetched ${symbols.length} merged Munafa symbols.`);
      } else {
        setMunafaMessage(res?.error || res?.reason || 'Tips fetch skipped');
      }
    } finally {
      setMunafaBusy(false);
    }
  };

  const toggleMunafaSymbol = (symbol) => {
    setMunafaSelected(prev => (
      prev.includes(symbol) ? prev.filter(s => s !== symbol) : [...prev, symbol]
    ));
  };

  const selectAllMunafa = () => {
    setMunafaSelected(munafaOptions.slice());
  };

  const clearMunafaSelection = () => {
    setMunafaSelected([]);
  };

  const addSelectedMunafaToWatchlist = async (addAll = false) => {
    const symbols = addAll ? munafaOptions : munafaSelected;
    if (!symbols.length) return;
    const res = await api.addManyToWatchlist(symbols);
    if (res?.success) {
      setMunafaMessage(`Added ${res.added || 0} symbols to watchlist.`);
      loadWatchlist();
    } else {
      setMunafaMessage(res?.error || 'Failed to add symbols');
    }
  };

  const startMunafaMatrix = async (useAllMunafa = false) => {
    const symbols = useAllMunafa ? munafaOptions : munafaSelected;
    if (!symbols.length) {
      setMunafaMessage('Select at least one Munafa symbol');
      return;
    }
    if (!matrixStrategies.length) {
      setMunafaMessage('Pick matrix strategies first in Live Matrix Scanner');
      return;
    }

    const maxSymbols = Math.max(1, Math.floor(200 / matrixStrategies.length));
    const sliced = symbols.slice(0, maxSymbols);
    const res = await api.startMatrixScanner({
      symbols: sliced,
      strategies: matrixStrategies,
      timeframe: matrixTimeframe,
      mode: matrixMode,
      interval: matrixInterval,
    });
    if (res?.success) {
      setMatrixScanning(true);
      setMunafaMessage(`Live matrix started: ${sliced.length} symbols × ${matrixStrategies.length} strategies.`);
      if (sliced.length < symbols.length) {
        setMunafaMessage(`Live matrix started with ${sliced.length}/${symbols.length} symbols due to job cap (200).`);
      }
    } else {
      setMunafaMessage(res?.error || 'Failed to start matrix scan');
    }
  };

  const handleMatrixStart = async () => {
    const symbols = selectAll
      ? watchlist.map(w => w.symbol)
      : (selectedSymbols.length > 0 ? selectedSymbols : watchlist.map(w => w.symbol));
    if (!symbols.length || !matrixStrategies.length) return;

    const res = await api.startMatrixScanner({
      symbols,
      strategies: matrixStrategies,
      timeframe: matrixTimeframe,
      mode: matrixMode,
      interval: matrixInterval,
    });
    if (res?.success) setMatrixScanning(true);
  };

  const handleMatrixStop = async () => {
    await api.stopMatrixScanner();
    setMatrixScanning(false);
  };

  const addSymbol = async () => {
    if (!newSymbol.trim()) return;
    setLoading(true);
    const result = await api.addToWatchlist(newSymbol.trim().toUpperCase());
    if (result.success) {
      setWatchlist(result.watchlist || [...watchlist, { symbol: newSymbol.trim().toUpperCase(), price: null }]);
      setNewSymbol('');
    }
    setLoading(false);
  };

  const removeSymbol = async (symbol) => {
    const result = await api.removeFromWatchlist(symbol);
    if (result.success) {
      setWatchlist(prev => prev.filter(w => w.symbol !== symbol));
      setSelectedSymbols(prev => prev.filter(s => s !== symbol));
      setScanResults(prev => { const n = { ...prev }; delete n[symbol]; return n; });
    }
  };

  const toggleSymbol = (symbol) => {
    setSelectedSymbols(prev =>
      prev.includes(symbol) ? prev.filter(s => s !== symbol) : [...prev, symbol]
    );
    if (selectAll) setSelectAll(false);
  };

  const handleSelectAll = () => {
    if (selectAll) {
      setSelectAll(false);
      setSelectedSymbols([]);
    } else {
      setSelectAll(true);
      setSelectedSymbols([]);
    }
  };

  const getSymbolsToScan = () => {
    if (selectAll) return ['ALL'];
    return selectedSymbols;
  };

  const toggleScanner = async () => {
    if (scanning) {
      await api.stopScanner();
      setScanning(false);
      setScanProgress(null);
    } else {
      const symbols = getSymbolsToScan();
      if (symbols.length === 0) return; // nothing selected
      const result = await api.startScanner(scanInterval, symbols, strategyOverrides);
      if (result.success) {
        setScanning(true);
        const count = symbols.includes('ALL') ? watchlist.length : symbols.length;
        setScanProgress(`Scanning ${count} symbol${count > 1 ? 's' : ''}...`);
      }
    }
  };

  const selectedCount = selectAll ? watchlist.length : selectedSymbols.length;
  const hasResults = Object.keys(scanResults).length > 0;

  // ── v2 Quick Scan handler ──
  const quickScanV2 = async () => {
    setV2Error('');

    // Determine target symbols (current scanner selection, or fall back to all watchlist)
    const symbolsToScan = selectAll
      ? watchlist.map(w => w.symbol)
      : (selectedSymbols.length > 0 ? selectedSymbols : watchlist.map(w => w.symbol));

    if (symbolsToScan.length === 0) {
      setV2Error('Add symbols to your watchlist first');
      return;
    }
    if (v2Strategies.length === 0) {
      setV2Error('Pick at least one strategy');
      return;
    }

    setV2Scanning(true);
    setV2Results([]);

    // Build N×M job grid
    const jobs = [];
    for (const sym of symbolsToScan) {
      for (const code of v2Strategies) {
        jobs.push({ code, symbol: sym, timeframe: v2Timeframe });
      }
    }

    // Defensive cap (server enforces 200; we warn user above 100)
    if (jobs.length > 200) {
      setV2Error(`Too many jobs (${jobs.length}). Reduce symbols or strategies.`);
      setV2Scanning(false);
      return;
    }

    const result = await v2.rank({
      jobs,
      mode: v2Mode,
      lookbackDays: 730,
      concurrency: 6,
      actionableOnly: false,
    });

    setV2Scanning(false);
    if (!result.success) {
      setV2Error(result.error || 'Quick scan failed');
      return;
    }

    setV2Results(result.ranked || []);
  };

  const v2JobCount = useMemo(() => {
    const symCount = selectAll
      ? watchlist.length
      : (selectedSymbols.length > 0 ? selectedSymbols.length : watchlist.length);
    return symCount * v2Strategies.length;
  }, [selectAll, watchlist.length, selectedSymbols.length, v2Strategies.length]);

  return (
    <div className="watchlist-page">
      {/* v2 Quick Scan (instant ranked matrix — no backend state) */}
      <div className="card v2-quickscan-card">
        <div className="card-header">
          <h2>🚀 Quick Scan & Rank (v2)</h2>
          <InfoTooltip text={"v2 Symbol-Aware Engine\n\n• Runs all selected strategies × all selected symbols in one shot\n• 2yr backtest per pair\n• Heuristic AI ranker scores each result (0-100 + tier)\n• No chart-switching; no backend state\n• Use this for instant 'what's best right now?' analysis"} />
          <span className="v2-badge">v2</span>
        </div>
        <p className="scanner-desc">
          Pick strategies and run an instant ranked scan across {selectAll
            ? `all ${watchlist.length} watchlist symbols`
            : (selectedSymbols.length > 0 ? `${selectedSymbols.length} selected symbols` : `all ${watchlist.length} watchlist symbols`)}.
          Each {selectAll ? 'symbol' : 'pair'} gets a 2-year backtest, regime fit, and ranking score.
        </p>

        {v2Error && <div className="error-message">{v2Error}</div>}

        <div className="v2-controls-row">
          <select
            className="scanner-select"
            value={v2Timeframe}
            onChange={e => setV2Timeframe(e.target.value)}
            disabled={v2Scanning}
          >
            <option value="1D">Daily</option>
            <option value="1W">Weekly</option>
            <option value="60">1H</option>
            <option value="15">15m</option>
          </select>
          <select
            className="scanner-select"
            value={v2Mode}
            onChange={e => setV2Mode(e.target.value)}
            disabled={v2Scanning}
          >
            <option value="backtest">Backtest mode</option>
            <option value="live">Live signal only</option>
          </select>
          <button
            className={`btn-scanner ${v2Scanning ? 'btn-stop' : 'btn-start'}`}
            onClick={quickScanV2}
            disabled={v2Scanning || v2Strategies.length === 0 || v2JobCount === 0}
            title={v2JobCount > 200 ? `Too many jobs (${v2JobCount}); max 200` : ''}
          >
            {v2Scanning
              ? '⏳ Ranking…'
              : `🏆 Rank ${v2JobCount} ${v2JobCount === 1 ? 'pair' : 'pairs'}`}
          </button>
        </div>

        <div className="v2-strategy-section">
          <label className="control-label" style={{ marginBottom: 6 }}>
            Strategies to evaluate ({v2Strategies.length} selected)
          </label>
          <StrategySelector
            mode="multi"
            value={v2Strategies}
            onChange={setV2Strategies}
            filter={{ backtestableOnly: true }}
            showSearch={true}
            showMeta={true}
            disabled={v2Scanning}
          />
        </div>

        {v2Results.length > 0 && (
          <div className="v2-results-section">
            <div className="v2-results-head">
              <strong>🏆 Ranked Results ({v2Results.length})</strong>
              <span className="v2-results-hint">
                Click a row to deep-dive in Pine Lab (coming soon — for now, copy the strategy code)
              </span>
            </div>
            <ScanResultGrid
              results={v2Results}
              loading={false}
              groupBy="none"
              onSelect={(row) => {
                // Promote selection: set strategyOverride for that symbol so background scanner uses it
                if (row?.symbol && row?.code) {
                  setStrategyOverride(row.symbol, row.code);
                }
              }}
            />
          </div>
        )}
      </div>

      {/* Munafa Tips source picker */}
      <div className="card scanner-card">
        <div className="card-header">
          <h2>🧲 Munafa Tips</h2>
          <InfoTooltip text={"Merged Source Dropdown\n\n• Fetches from BOTH intradayTradingTips + BestIntradayTips\n• Both sources merged & deduplicated\n• Multi-select symbols and add to watchlist in one click\n• Can start live matrix scan directly from selected tips\n• Manual re-fetch button available anytime"} />
          <span className="scanner-badge active">MUNAFA TIPS</span>
        </div>
        <p className="scanner-desc">
          Merged from <strong>intradayTradingTips</strong> (vol+price gainers) + <strong>BestIntradayTips</strong> (top picks).
          {munafaLastFetchAt ? ` Last fetch: ${new Date(munafaLastFetchAt).toLocaleTimeString()}` : ''}
        </p>

        <div className="scanner-controls" style={{ marginBottom: 8 }}>
          <button className="btn-scanner btn-start" onClick={fetchMunafaTipsNow} disabled={munafaBusy}>
            {munafaBusy ? '⏳ Fetching…' : '🔄 Fetch Munafa Tips'}
          </button>
          <button className="btn-strategy-config" onClick={selectAllMunafa} disabled={!munafaOptions.length || munafaBusy}>
            Select All
          </button>
          <button className="btn-strategy-config" onClick={clearMunafaSelection} disabled={!munafaSelected.length || munafaBusy}>
            Clear
          </button>
          <button className="btn-scanner btn-start" onClick={() => addSelectedMunafaToWatchlist(false)} disabled={!munafaSelected.length || munafaBusy}>
            + Add Selected ({munafaSelected.length})
          </button>
          <button className="btn-strategy-config" onClick={() => addSelectedMunafaToWatchlist(true)} disabled={!munafaOptions.length || munafaBusy}>
            + Add All ({munafaOptions.length})
          </button>
        </div>

        <div className="scanner-controls" style={{ marginBottom: 8 }}>
          <button className="btn-scanner btn-start" onClick={() => startMunafaMatrix(false)} disabled={!munafaSelected.length || !matrixStrategies.length}>
            ▶ Scan Selected × All Strategies
          </button>
          <button className="btn-strategy-config" onClick={() => startMunafaMatrix(true)} disabled={!munafaOptions.length || !matrixStrategies.length}>
            ▶ Scan All Munafa × All Strategies
          </button>
          {!matrixStrategies.length && (
            <span style={{ fontSize: 11, color: '#e67e22' }}>⚠ Select strategies in Matrix Scanner below first</span>
          )}
        </div>

        {munafaMessage ? <p className="scanner-note">{munafaMessage}</p> : null}

        <div className="scanner-selection">
          <div className="scanner-selection-header">
            <span className="selected-count">{munafaSelected.length} selected / {munafaOptions.length} fetched</span>
          </div>
          <div className="scanner-symbol-chips">
            {munafaOptions.length === 0 ? (
              <span className="scanner-note">No symbols loaded. Click Fetch Munafa Tips.</span>
            ) : munafaOptions.map(symbol => {
              const selected = munafaSelected.includes(symbol);
              return (
                <button
                  key={symbol}
                  className={`scanner-chip ${selected ? 'selected' : ''}`}
                  onClick={() => toggleMunafaSymbol(symbol)}
                  title="Munafa Tips"
                >
                  <span className="chip-name">{symbol.replace(/^NSE:|^BSE:/, '')}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Live Matrix Scanner — continuous N×M */}
      <div className="card scanner-card">
        <div className="card-header">
          <h2>📡 Live Matrix Scanner</h2>
          <InfoTooltip text={"Continuous N×M Scanner\n\n• Repeatedly scans selected symbols × selected strategies\n• Uses v2 engine (Yahoo Finance) — no chart switching needed\n• Emits alerts when signals change\n• Results update via SSE in real time\n• Desktop notifications on new BUY/SELL signals"} />
          <span className={`scanner-badge ${matrixScanning ? 'active' : ''}`}>
            {matrixScanning ? 'LIVE' : 'STOPPED'}
          </span>
        </div>
        <p className="scanner-desc">
          Continuously scan {selectAll ? `all ${watchlist.length}` : (selectedSymbols.length || watchlist.length)} symbols
          against {matrixStrategies.length || 0} strategies every {matrixInterval / 1000}s.
        </p>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontWeight: 600, fontSize: 13, display: 'block', marginBottom: 4 }}>Strategies</label>
          <StrategySelector
            mode="multi"
            value={matrixStrategies}
            onChange={setMatrixStrategies}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
          <label style={{ fontSize: 13 }}>Timeframe</label>
          <select
            value={matrixTimeframe}
            onChange={e => setMatrixTimeframe(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
          >
            <option value="1D">Daily</option>
            <option value="1W">Weekly</option>
            <option value="60">1H</option>
            <option value="15">15m</option>
          </select>

          <label style={{ fontSize: 13, marginLeft: 8 }}>Interval</label>
          <select
            value={matrixInterval}
            onChange={e => setMatrixInterval(Number(e.target.value))}
            style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
          >
            <option value={30000}>30s</option>
            <option value={60000}>1 min</option>
            <option value={120000}>2 min</option>
            <option value={300000}>5 min</option>
            <option value={600000}>10 min</option>
          </select>

          <label style={{ fontSize: 13, marginLeft: 8 }}>Mode</label>
          <select
            value={matrixMode}
            onChange={e => setMatrixMode(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
          >
            <option value="backtest">Backtest (metrics)</option>
            <option value="live">Live (fast)</option>
          </select>
        </div>

        <button
          onClick={matrixScanning ? handleMatrixStop : handleMatrixStart}
          className={`scan-btn ${matrixScanning ? 'stop' : 'start'}`}
          disabled={!matrixScanning && (!matrixStrategies.length || (!selectAll && !selectedSymbols.length && !watchlist.length))}
        >
          {matrixScanning
            ? '⏹ Stop Matrix Scanner'
            : `▶ Start (${(selectAll ? watchlist.length : (selectedSymbols.length || watchlist.length)) * matrixStrategies.length} jobs)`}
        </button>

        {matrixResults.length > 0 && (
          <div style={{ marginTop: 12, overflowX: 'auto' }}>
            <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 13 }}>
                📊 Live Signals ({matrixResults.filter(r => r.signalType && !['WAIT', 'HOLD', 'ERROR'].includes(r.signalType)).length} actionable / {matrixResults.length} total)
              </strong>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                Last scan: {matrixResults[0]?.lastScanned || '—'}
              </span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>Symbol</th>
                  <th style={{ padding: '6px 8px' }}>Strategy</th>
                  <th style={{ padding: '6px 8px' }}>Signal</th>
                  <th style={{ padding: '6px 8px' }}>Price</th>
                  <th style={{ padding: '6px 8px' }}>Reason / Detail</th>
                  <th style={{ padding: '6px 8px' }}>Win%</th>
                  <th style={{ padding: '6px 8px' }}>PF</th>
                  <th style={{ padding: '6px 8px' }}>P&L</th>
                  <th style={{ padding: '6px 8px' }}>Regime</th>
                </tr>
              </thead>
              <tbody>
                {matrixResults
                  .slice()
                  .sort((a, b) => {
                    const sigOrder = { BUY: 0, SELL: 1, IN_TRADE: 2, HOLD: 3, WAIT: 4, ERROR: 5 };
                    return (sigOrder[a.signalType] ?? 9) - (sigOrder[b.signalType] ?? 9);
                  })
                  .filter(r => r.signalType !== 'WAIT' && r.signalType !== 'HOLD')
                  .map((r) => (
                    <tr key={`${r.symbol}-${r.code}`} style={{
                      borderBottom: '1px solid var(--border)',
                      background: r.signalType === 'BUY' ? 'rgba(46,204,113,0.08)'
                        : r.signalType === 'SELL' ? 'rgba(231,76,60,0.08)'
                        : r.signalType === 'IN_TRADE' ? 'rgba(41,128,185,0.06)'
                        : r.signalType === 'ERROR' ? 'rgba(231,76,60,0.04)'
                        : 'transparent',
                    }}>
                      <td style={{ padding: '5px 8px', fontWeight: 600 }}>{r.symbol?.replace(/^NSE:|^BSE:/, '')}</td>
                      <td style={{ padding: '5px 8px' }}>
                        <div style={{ lineHeight: 1.3 }}>
                          <span style={{ fontWeight: 500 }}>{r.name || r.code}</span>
                          {r.detail?.strategyDescription && (
                            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                              {r.detail.strategyDescription}
                            </div>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '5px 8px' }}>
                        <span style={{
                          padding: '2px 6px',
                          borderRadius: 4,
                          fontSize: 11,
                          fontWeight: 700,
                          color: '#fff',
                          background: r.signalType === 'BUY' ? '#27ae60'
                            : r.signalType === 'SELL' ? '#e74c3c'
                            : r.signalType === 'IN_TRADE' ? '#2980b9'
                            : r.signalType === 'ERROR' ? '#7f8c8d'
                            : '#95a5a6',
                        }}>
                          {r.signalType}
                        </span>
                        {r.detail?.signalDirection && (
                          <span style={{ fontSize: 10, marginLeft: 4, color: 'var(--text-secondary)' }}>
                            {r.detail.signalDirection}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '5px 8px', fontFamily: 'monospace' }}>
                        {r.price != null ? `₹${Number(r.price).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                        {r.detail?.entryPrice && (
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                            Entry: ₹{Number(r.detail.entryPrice).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '5px 8px', maxWidth: 220 }}>
                        <div style={{ fontSize: 11, lineHeight: 1.4 }}>
                          {r.detail?.signalReason || r.signal?.reason || '—'}
                        </div>
                        {r.detail?.exitRules && (
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                            TP: {r.detail.exitRules.tp}% | SL: {r.detail.exitRules.sl}% | Max: {r.detail.exitRules.maxBars} bars
                          </div>
                        )}
                        {r.detail?.lastTrade && (
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 1 }}>
                            Last: {r.detail.lastTrade.direction} → {r.detail.lastTrade.pnl > 0 ? '+' : ''}{r.detail.lastTrade.pnl?.toFixed(2)}%
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '5px 8px' }}>{r.metrics?.winRate != null ? r.metrics.winRate.toFixed(0) + '%' : '—'}</td>
                      <td style={{ padding: '5px 8px' }}>{r.metrics?.profitFactor != null ? r.metrics.profitFactor.toFixed(2) : '—'}</td>
                      <td style={{ padding: '5px 8px' }}>
                        {r.metrics?.totalPnl != null ? (
                          <span style={{ color: r.metrics.totalPnl >= 0 ? '#27ae60' : '#e74c3c' }}>
                            {r.metrics.totalPnl >= 0 ? '+' : ''}{r.metrics.totalPnl.toFixed(1)}%
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ padding: '5px 8px' }}>{r.regime || '—'}</td>
                    </tr>
                  ))}
                {matrixResults.filter(r => r.signalType === 'WAIT' || r.signalType === 'HOLD').length > 0 && (
                  <tr style={{ borderTop: '2px solid var(--border)' }}>
                    <td colSpan={9} style={{ padding: '6px 8px', fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center' }}>
                      {matrixResults.filter(r => r.signalType === 'WAIT' || r.signalType === 'HOLD').length} more pairs waiting (no signal)
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Scanner Controls */}
      <div className="card scanner-card">
        <div className="card-header">
          <h2>🔍 Multi-Symbol Scanner</h2>
          <InfoTooltip text={"Background Scanner\n\n• Scans multiple watchlist symbols in the background\n• Each symbol gets independent regime analysis & strategy match\n• Shows live signals, win-rate & P&L per symbol\n• Use this to find opportunities across your entire watchlist"} />
          <span className={`scanner-badge ${scanning ? 'active' : ''}`}>
            {scanning ? 'SCANNING' : 'STOPPED'}
          </span>
        </div>
        <p className="scanner-desc">
          Select symbols to scan — each gets analyzed independently and matched with its optimal strategy.
          Many-to-many: different symbols can have different best strategies.
        </p>

        {/* Symbol Selection */}
        <div className="scanner-selection">
          <div className="scanner-selection-header">
            <label className="select-all-label">
              <input
                type="checkbox"
                checked={selectAll}
                onChange={handleSelectAll}
                disabled={scanning}
              />
              <span>Select All ({watchlist.length})</span>
            </label>
            <span className="selected-count">
              {selectedCount > 0 ? `${selectedCount} selected` : 'None selected'}
            </span>
          </div>
          <div className="scanner-symbol-chips">
            {watchlist.map((item) => {
              const isSelected = selectAll || selectedSymbols.includes(item.symbol);
              const result = scanResults[item.symbol];
              return (
                <button
                  key={item.symbol}
                  className={`scanner-chip ${isSelected ? 'selected' : ''} ${result?.signal?.type === 'BUY' ? 'has-buy' : ''} ${result?.signal?.type === 'IN_TRADE' ? 'has-trade' : ''}`}
                  onClick={() => !scanning && toggleSymbol(item.symbol)}
                  disabled={scanning}
                  title={result ? `${result.optimalStrategy?.name} — ${result.signal?.type}` : 'Not scanned yet'}
                >
                  <span className="chip-name">{item.symbol.replace(/^NSE:|^BSE:/, '')}</span>
                  {result && <span className={`chip-signal ${result.signal?.type?.toLowerCase()}`}>●</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="scanner-controls">
          <select
            value={scanInterval}
            onChange={e => setScanInterval(parseInt(e.target.value))}
            className="scanner-select"
            disabled={scanning}
          >
            <option value={60000}>Every 1 min</option>
            <option value={120000}>Every 2 min</option>
            <option value={300000}>Every 5 min</option>
            <option value={600000}>Every 10 min</option>
          </select>
          <button
            className={`btn-scanner ${scanning ? 'btn-stop' : 'btn-start'}`}
            onClick={toggleScanner}
            disabled={!scanning && selectedCount === 0}
            title={selectedCount === 0 ? 'Select at least one symbol' : ''}
          >
            {scanning ? '■ Stop' : '▶ Start Scanner'}
          </button>
          <button
            className={`btn-strategy-config ${showStrategyConfig ? 'active' : ''}`}
            onClick={() => setShowStrategyConfig(!showStrategyConfig)}
            disabled={scanning}
            title="Configure strategy per symbol"
          >
            🎯 Strategy
          </button>
          {scanProgress && <span className="scan-progress">{scanProgress}</span>}
        </div>

        {/* Per-Symbol Strategy Configuration */}
        {showStrategyConfig && !scanning && (
          <div className="strategy-config-section">
            <div className="strategy-config-header">
              <span className="strategy-config-title">Per-Symbol Strategy Override</span>
              <span className="strategy-config-hint">Set "Auto" to let AI pick the optimal strategy</span>
            </div>
            <div className="strategy-config-list">
              {watchlist.map((item) => {
                const isSelected = selectAll || selectedSymbols.includes(item.symbol);
                if (!isSelected && !selectAll) return null;
                return (
                  <div key={item.symbol} className="strategy-config-row">
                    <span className="strategy-config-symbol">{item.symbol.replace(/^NSE:|^BSE:/, '')}</span>
                    <select
                      className="strategy-config-select"
                      value={strategyOverrides[item.symbol] || 'auto'}
                      onChange={(e) => setStrategyOverride(item.symbol, e.target.value)}
                    >
                      <option value="auto">🤖 Auto (AI-detected)</option>
                      {availableStrategies.map(s => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {scanning && (
          <p className="scanner-note">
            ⚠ Scanner switches the chart between symbols. Do not interact with TradingView while scanning.
          </p>
        )}
      </div>

      {/* Scanner Results — Per-Symbol Strategy Table */}
      {hasResults && (
        <div className="card scanner-results-card">
          <div className="card-header">
            <h2>📊 Scan Results — Per-Symbol Strategy Match</h2>
            <span className="results-count">{Object.keys(scanResults).length} symbols analyzed</span>
          </div>
          <div className="scanner-results-table">
            <div className="srt-header">
              <span className="srt-col sym">Symbol</span>
              <span className="srt-col price">Price</span>
              <span className="srt-col strat">Optimal Strategy</span>
              <span className="srt-col score">Score</span>
              <span className="srt-col signal">Signal</span>
              <span className="srt-col wr">Win Rate</span>
              <span className="srt-col pnl">P&L</span>
              <span className="srt-col regime">Regime</span>
            </div>
            {Object.values(scanResults)
              .sort((a, b) => {
                // Sort: actionable signals first, then by score
                const sigOrder = { BUY: 0, IN_TRADE: 1, WAIT: 2 };
                const sa = sigOrder[a.signal?.type] ?? 3;
                const sb = sigOrder[b.signal?.type] ?? 3;
                if (sa !== sb) return sa - sb;
                return (b.optimalStrategy?.score || 0) - (a.optimalStrategy?.score || 0);
              })
              .map((r) => (
                <div key={r.symbol} className={`srt-row ${r.signal?.type === 'BUY' ? 'row-buy' : ''} ${r.signal?.type === 'IN_TRADE' ? 'row-trade' : ''}`}>
                  <span className="srt-col sym">
                    <strong>{r.symbol.replace(/^NSE:|^BSE:/, '')}</strong>
                    {r.change != null && (
                      <small className={r.change >= 0 ? 'positive' : 'negative'}>
                        {r.change >= 0 ? '+' : ''}{r.change}%
                      </small>
                    )}
                  </span>
                  <span className="srt-col price">
                    {r.price ? `₹${Number(r.price).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                  </span>
                  <span className="srt-col strat">
                    <span className="strat-name">{r.optimalStrategy?.name || '—'}</span>
                    {r.optimalStrategy?.source === 'manual' && (
                      <span className="strat-source manual">manual</span>
                    )}
                    {r.optimalStrategy?.source && r.optimalStrategy.source !== 'manual' && (
                      <span className={`strat-source ${r.optimalStrategy.source}`}>{r.optimalStrategy.source}</span>
                    )}
                  </span>
                  <span className="srt-col score">
                    <span className={`score-ring ${r.optimalStrategy?.score >= 75 ? 'high' : r.optimalStrategy?.score >= 60 ? 'mid' : 'low'}`}>
                      {r.optimalStrategy?.score || 0}
                    </span>
                  </span>
                  <span className="srt-col signal">
                    <span className={`signal-badge ${r.signal?.type?.toLowerCase()}`}>
                      {r.signal?.type || 'WAIT'}
                    </span>
                  </span>
                  <span className="srt-col wr">
                    {r.backtest ? `${r.backtest.winRate}%` : '—'}
                  </span>
                  <span className="srt-col pnl">
                    {r.backtest ? (
                      <span className={r.backtest.totalPnl >= 0 ? 'positive' : 'negative'}>
                        {r.backtest.totalPnl >= 0 ? '+' : ''}{r.backtest.totalPnl}%
                      </span>
                    ) : '—'}
                  </span>
                  <span className="srt-col regime">
                    <span className={`regime-chip ${r.regime}`}>{r.regime || '—'}</span>
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Watchlist Management */}
      <div className="card">
        <div className="card-header">
          <h2>👁 Watchlist</h2>
          <span className="watchlist-count">{watchlist.length} symbols</span>
        </div>

        <div className="watchlist-add">
          <SymbolSearch
            value={newSymbol}
            onChange={setNewSymbol}
            onSelect={async (item) => {
              const sym = item.full_name || newSymbol;
              if (!sym.trim()) return;
              setLoading(true);
              const result = await api.addToWatchlist(sym.trim().toUpperCase());
              if (result.success) {
                setWatchlist(result.watchlist || [...watchlist, { symbol: sym.trim().toUpperCase(), price: null }]);
                setNewSymbol('');
              }
              setLoading(false);
            }}
            api={api}
            disabled={false}
            placeholder="Search & add symbol..."
          />
          <button className="btn-add" onClick={addSymbol} disabled={loading}>
            {loading ? '...' : '+ Add'}
          </button>
        </div>

        <div className="watchlist-grid">
          {watchlist.length === 0 ? (
            <div className="empty-watchlist">
              <p>No symbols in watchlist</p>
              <p className="sub">Add symbols to monitor multiple stocks simultaneously</p>
            </div>
          ) : (
            watchlist.map((item, i) => (
              <div key={i} className="watchlist-item">
                <div className="wl-symbol">
                  <span className="wl-name">{item.symbol}</span>
                  {item.optimalStrategy && (
                    <span className="wl-strat-tag">{item.optimalStrategy}</span>
                  )}
                </div>
                <div className="wl-price-section">
                  {item.price ? (
                    <>
                      <span className="wl-price">₹{Number(item.price).toLocaleString('en-IN')}</span>
                      {item.change != null && (
                        <span className={`wl-change ${item.change >= 0 ? 'positive' : 'negative'}`}>
                          {item.change >= 0 ? '+' : ''}{item.change}%
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="wl-price pending">—</span>
                  )}
                </div>
                <div className="wl-signals">
                  {item.signal && (
                    <span className={`wl-signal ${item.signal.toLowerCase()}`}>{item.signal}</span>
                  )}
                  {item.lastScanned && (
                    <span className="wl-scanned" title="Last scanned">🕐 {item.lastScanned}</span>
                  )}
                </div>
                <button className="wl-remove" onClick={() => removeSymbol(item.symbol)} title="Remove">
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header">
          <h2>📋 Quick Add Popular Stocks</h2>
        </div>
        <div className="quick-add-grid">
          {['NSE:RELIANCE', 'NSE:TCS', 'NSE:INFY', 'NSE:HDFCBANK', 'NSE:ICICIBANK', 'NSE:TATASTEEL', 'NSE:SBIN', 'NSE:BHARTIARTL', 'NSE:ITC', 'NSE:KOTAKBANK', 'NSE:LT', 'NSE:AXISBANK'].map(sym => (
            <button
              key={sym}
              className="quick-add-btn"
              onClick={() => {
                setNewSymbol(sym);
                api.addToWatchlist(sym).then(r => {
                  if (r.success) loadWatchlist();
                });
              }}
            >
              {sym.replace('NSE:', '')}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
