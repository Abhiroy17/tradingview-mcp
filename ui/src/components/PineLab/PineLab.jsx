import { useState, useMemo, useCallback } from 'react';
import { useV2Api } from '../../hooks/useV2Api.js';
import { useStore } from '../../store.js';
import SymbolBar from './SymbolBar.jsx';
import ScanWorkbench from './ScanWorkbench.jsx';
import PineCodeCard from './PineCodeCard.jsx';
import BacktestResultView from '../StrategySelector/BacktestResultView.jsx';
import ScanResultGrid from '../StrategySelector/ScanResultGrid.jsx';
import './PineLab.css';

/**
 * PineLab (v2) — Pine Script research workbench, symbol-aware.
 *
 * Top-down flow:
 *   1. SymbolBar: pick symbol + timeframe + history length
 *   2. ScanWorkbench: choose scan mode (single / symbol-all / strategy-all / matrix)
 *   3. Results: BacktestResultView for single-strategy mode, ScanResultGrid for batch modes
 *   4. PineCodeCard: view/copy/deploy Pine source for the selected strategy
 */
export default function PineLab() {
  const api = useV2Api();

  // ── Persistent UI state (zustand) ──
  const symbol = useStore(s => s.pl_symbol || 'AAPL');
  const setSymbol = useStore(s => s.setPlSymbol);
  const timeframe = useStore(s => s.pl_timeframe || '1D');
  const setTimeframe = useStore(s => s.setPlTimeframe);
  const lookbackDays = useStore(s => s.pl_lookbackDays || 730);
  const setLookbackDays = useStore(s => s.setPlLookbackDays);
  const scanMode = useStore(s => s.pl_scanMode || 'single');
  const setScanMode = useStore(s => s.setPlScanMode);
  const engineMode = useStore(s => s.pl_engineMode || 'backtest');
  const setEngineMode = useStore(s => s.setPlEngineMode);
  const primaryStrategy = useStore(s => s.pl_primaryStrategy || '');
  const setPrimaryStrategy = useStore(s => s.setPlPrimaryStrategy);
  const multiStrategies = useStore(s => s.pl_multiStrategies || []);
  const setMultiStrategies = useStore(s => s.setPlMultiStrategies);
  const multiSymbols = useStore(s => s.pl_multiSymbols || []);
  const setMultiSymbols = useStore(s => s.setPlMultiSymbols);

  // ── Ephemeral state (results, loading) ──
  const [running, setRunning] = useState(false);
  const [singleResult, setSingleResult] = useState(null);
  const [scanResults, setScanResults] = useState(null);
  const [error, setError] = useState(null);
  const [selectedRow, setSelectedRow] = useState(null); // row clicked in scan grid

  const handleRun = useCallback(async () => {
    setRunning(true);
    setError(null);
    setSingleResult(null);
    setScanResults(null);
    setSelectedRow(null);
    try {
      if (scanMode === 'single') {
        const res = await api.analyze({
          code: primaryStrategy,
          symbol,
          timeframe,
          mode: engineMode,
          lookbackDays,
        });
        if (!res.success) throw new Error(res.error || 'Analyze failed');
        setSingleResult(res.result);
      } else if (scanMode === 'symbol_all') {
        const res = await api.scanSymbolAll({
          symbol,
          timeframe,
          mode: engineMode,
        });
        if (!res.success) throw new Error(res.error || 'Scan failed');
        setScanResults(res.results || []);
      } else if (scanMode === 'strategy_all') {
        const res = await api.scanStrategyAll({
          code: primaryStrategy,
          symbols: multiSymbols,
          timeframe,
          mode: engineMode,
        });
        if (!res.success) throw new Error(res.error || 'Scan failed');
        setScanResults(res.results || []);
      } else if (scanMode === 'custom') {
        const jobs = [];
        for (const c of multiStrategies) {
          for (const sy of multiSymbols) {
            jobs.push({ code: c, symbol: sy, timeframe });
          }
        }
        const res = await api.scan({ jobs, mode: engineMode });
        if (!res.success) throw new Error(res.error || 'Scan failed');
        setScanResults(res.results || []);
      }
    } catch (e) {
      setError(e.message || String(e));
    }
    setRunning(false);
  }, [
    api, scanMode, engineMode, symbol, timeframe, lookbackDays,
    primaryStrategy, multiStrategies, multiSymbols,
  ]);

  const handleScanRowClick = useCallback((row) => {
    setSelectedRow(row);
    // Promote into "single" mode display so the user can deep-dive
    setSingleResult(row.result);
    setPrimaryStrategy(row.code);
  }, [setPrimaryStrategy]);

  // What strategy code is the PineCodeCard pinned to?
  const pinnedStrategy = useMemo(() => {
    if (scanMode === 'single' && primaryStrategy) return primaryStrategy;
    if (selectedRow) return selectedRow.code;
    if (singleResult?.code) return singleResult.code;
    return primaryStrategy || '';
  }, [scanMode, primaryStrategy, selectedRow, singleResult]);

  const pinnedStrategyName = useMemo(() => {
    if (selectedRow?.result?.name) return selectedRow.result.name;
    if (singleResult?.name) return singleResult.name;
    return '';
  }, [selectedRow, singleResult]);

  return (
    <div className="pine-lab">
      <div className="pl-header">
        <h1 className="pl-title">Pine Lab</h1>
        <p className="pl-subtitle">
          Symbol-aware strategy research. Backtest one or many strategies against one or many symbols.
        </p>
      </div>

      <SymbolBar
        symbol={symbol}
        setSymbol={setSymbol}
        timeframe={timeframe}
        setTimeframe={setTimeframe}
        lookbackDays={lookbackDays}
        setLookbackDays={setLookbackDays}
        disabled={running}
      />

      <ScanWorkbench
        scanMode={scanMode}
        setScanMode={setScanMode}
        primarySymbol={symbol}
        multiSymbols={multiSymbols}
        setMultiSymbols={setMultiSymbols}
        primaryStrategy={primaryStrategy}
        setPrimaryStrategy={setPrimaryStrategy}
        multiStrategies={multiStrategies}
        setMultiStrategies={setMultiStrategies}
        timeframe={timeframe}
        onRun={handleRun}
        running={running}
        mode={engineMode}
        setMode={setEngineMode}
      />

      {error && (
        <div className="pl-error">
          <span className="pl-error-icon">⚠️</span>
          <div className="pl-error-body">
            <div className="pl-error-title">Run failed</div>
            <div className="pl-error-msg">{error}</div>
          </div>
        </div>
      )}

      {scanResults !== null && (
        <div className="pl-results-section">
          <div className="pl-section-head">
            <h2>Scan Results</h2>
            <span className="pl-section-meta">{scanResults.length} jobs · click any row to inspect</span>
          </div>
          <ScanResultGrid
            results={scanResults}
            loading={running}
            onSelect={handleScanRowClick}
            groupBy={scanMode === 'symbol_all' ? 'none' : scanMode === 'strategy_all' ? 'symbol' : 'symbol'}
            actionableOnly={engineMode === 'live'}
          />
        </div>
      )}

      {singleResult && (
        <div className="pl-results-section">
          <div className="pl-section-head">
            <h2>Detailed Result</h2>
            <span className="pl-section-meta">
              {singleResult.code} on {singleResult.symbol} · {singleResult.timeframe} · {singleResult.mode}
            </span>
          </div>
          <BacktestResultView
            result={singleResult}
            onClose={selectedRow ? () => { setSelectedRow(null); setSingleResult(null); } : undefined}
          />
        </div>
      )}

      <div className="pl-results-section">
        <div className="pl-section-head">
          <h2>Pine Script</h2>
          <span className="pl-section-meta">View, copy, or deploy to TradingView</span>
        </div>
        <PineCodeCard
          strategyCode={pinnedStrategy}
          strategyName={pinnedStrategyName}
        />
      </div>
    </div>
  );
}
