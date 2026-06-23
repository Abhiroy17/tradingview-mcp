import './ScanWorkbench.css';
import StrategySelector from '../StrategySelector/StrategySelector.jsx';
import SymbolPicker from '../StrategySelector/SymbolPicker.jsx';

/**
 * ScanWorkbench — the heart of the new Pine Lab.
 *
 * Lets the user pick HOW to scan:
 *   - 'single'      = 1 strategy × 1 symbol (single-symbol backtest)
 *   - 'symbol_all'  = all 20 strategies × 1 symbol
 *   - 'strategy_all' = 1 strategy × N symbols
 *   - 'custom'       = N strategies × N symbols (matrix)
 *
 * Props:
 *   scanMode, setScanMode
 *   primarySymbol, setPrimarySymbol           — for single & symbol_all & custom (first)
 *   multiSymbols, setMultiSymbols             — for strategy_all & custom
 *   primaryStrategy, setPrimaryStrategy       — for single & strategy_all
 *   multiStrategies, setMultiStrategies       — for custom
 *   timeframe                                 — used to filter strategies by TF
 *   onRun                                     — callback when "Run" pressed
 *   running                                   — disabled flag during scan
 *   mode                                      — 'live' or 'backtest' (engine mode)
 *   setMode                                   — toggles between live/backtest
 */
export default function ScanWorkbench({
  scanMode, setScanMode,
  primarySymbol, /* setPrimarySymbol unused — owned by SymbolBar */
  multiSymbols, setMultiSymbols,
  primaryStrategy, setPrimaryStrategy,
  multiStrategies, setMultiStrategies,
  timeframe,
  onRun,
  running,
  mode, setMode,
}) {
  const canRun = (() => {
    switch (scanMode) {
      case 'single': return !!primarySymbol && !!primaryStrategy;
      case 'symbol_all': return !!primarySymbol;
      case 'strategy_all': return !!primaryStrategy && multiSymbols.length > 0;
      case 'custom': return multiStrategies.length > 0 && multiSymbols.length > 0;
      default: return false;
    }
  })();

  const jobCount = (() => {
    switch (scanMode) {
      case 'single': return 1;
      case 'symbol_all': return 'all matching';
      case 'strategy_all': return multiSymbols.length;
      case 'custom': return multiStrategies.length * multiSymbols.length;
      default: return 0;
    }
  })();

  const runBtnLabel = (() => {
    if (running) return 'Running…';
    switch (scanMode) {
      case 'single': return mode === 'live' ? 'Get current signal' : 'Run backtest';
      case 'symbol_all': return 'Scan all strategies';
      case 'strategy_all': return `Scan ${multiSymbols.length || 0} symbols`;
      case 'custom': return `Run ${jobCount} jobs`;
      default: return 'Run';
    }
  })();

  return (
    <div className="pl-workbench">
      <div className="pl-mode-tabs">
        <ModeTab id="single" label="Single" hint="1 strategy × 1 symbol" current={scanMode} onClick={setScanMode} />
        <ModeTab id="symbol_all" label="All strategies" hint="every strategy × 1 symbol" current={scanMode} onClick={setScanMode} />
        <ModeTab id="strategy_all" label="Many symbols" hint="1 strategy × N symbols" current={scanMode} onClick={setScanMode} />
        <ModeTab id="custom" label="Matrix" hint="N strategies × N symbols" current={scanMode} onClick={setScanMode} />
      </div>

      <div className="pl-mode-body">
        {scanMode === 'single' && (
          <div className="pl-wb-section">
            <SectionLabel n="2" text="Pick the strategy you want to test" />
            <StrategySelector
              mode="single"
              value={primaryStrategy}
              onChange={code => setPrimaryStrategy(code)}
              filter={{ timeframe, backtestableOnly: true }}
            />
          </div>
        )}

        {scanMode === 'symbol_all' && (
          <div className="pl-wb-section">
            <div className="pl-info-card">
              <div className="pl-info-head">Scan all 20 strategies on <strong>{primarySymbol || '— pick a symbol —'}</strong></div>
              <div className="pl-info-sub">Strategies that don't support the chosen timeframe are automatically skipped.</div>
            </div>
            <StrategySelector
              mode="all"
              filter={{ timeframe, backtestableOnly: true }}
              onChange={() => {/* count display only */}}
            />
          </div>
        )}

        {scanMode === 'strategy_all' && (
          <>
            <div className="pl-wb-section">
              <SectionLabel n="2" text="Pick the strategy" />
              <StrategySelector
                mode="single"
                value={primaryStrategy}
                onChange={code => setPrimaryStrategy(code)}
                filter={{ timeframe, backtestableOnly: true }}
              />
            </div>
            <div className="pl-wb-section">
              <SectionLabel n="3" text="Add symbols to scan" />
              <SymbolPicker
                mode="multi"
                value={multiSymbols}
                onChange={setMultiSymbols}
                placeholder="Add symbol (Enter to confirm)"
                max={50}
              />
            </div>
          </>
        )}

        {scanMode === 'custom' && (
          <>
            <div className="pl-wb-section">
              <SectionLabel n="2" text="Pick strategies" />
              <StrategySelector
                mode="multi"
                value={multiStrategies}
                onChange={codes => setMultiStrategies(codes)}
                filter={{ timeframe, backtestableOnly: true }}
              />
            </div>
            <div className="pl-wb-section">
              <SectionLabel n="3" text="Pick symbols" />
              <SymbolPicker
                mode="multi"
                value={multiSymbols}
                onChange={setMultiSymbols}
                placeholder="Add symbol (Enter to confirm)"
                max={50}
              />
            </div>
          </>
        )}
      </div>

      <div className="pl-wb-footer">
        <div className="pl-wb-toggle">
          <span className="pl-wb-toggle-label">Engine mode</span>
          <div className="pl-wb-pill-toggle">
            <button
              type="button"
              className={`pl-wb-pill ${mode === 'live' ? 'pl-wb-pill-active' : ''}`}
              onClick={() => setMode('live')}
            >Live signal</button>
            <button
              type="button"
              className={`pl-wb-pill ${mode === 'backtest' ? 'pl-wb-pill-active' : ''}`}
              onClick={() => setMode('backtest')}
            >Full backtest</button>
          </div>
        </div>
        <div className="pl-wb-counts">
          {typeof jobCount === 'number' && jobCount > 0 && (
            <span className="pl-wb-jobs">{jobCount} job{jobCount === 1 ? '' : 's'}</span>
          )}
          {typeof jobCount === 'string' && (
            <span className="pl-wb-jobs">{jobCount} jobs</span>
          )}
        </div>
        <button
          type="button"
          className={`pl-wb-run ${running ? 'pl-wb-run-loading' : ''}`}
          disabled={!canRun || running}
          onClick={onRun}
        >
          {runBtnLabel}
        </button>
      </div>
    </div>
  );
}

function ModeTab({ id, label, hint, current, onClick }) {
  return (
    <button
      type="button"
      className={`pl-mode-tab ${current === id ? 'pl-mode-tab-active' : ''}`}
      onClick={() => onClick(id)}
    >
      <span className="pl-mode-tab-label">{label}</span>
      <span className="pl-mode-tab-hint">{hint}</span>
    </button>
  );
}

function SectionLabel({ n, text }) {
  return (
    <div className="pl-section-label">
      <span className="pl-section-n">{n}</span>
      <span className="pl-section-text">{text}</span>
    </div>
  );
}
