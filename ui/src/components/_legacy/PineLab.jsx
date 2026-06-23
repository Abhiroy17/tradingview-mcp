import { useState, useEffect } from 'react';
import { useStore } from '../store';
import InfoTooltip from './InfoTooltip';
import './PineLab.css';

export default function PineLab({ api }) {
  // Persistent state (survives tab switches)
  const analysis = useStore(s => s.pl_analysis);
  const selectedTemplate = useStore(s => s.pl_selectedTemplate);
  const generatedCode = useStore(s => s.pl_generatedCode);
  const backtest = useStore(s => s.pl_backtest);
  const autoMode = useStore(s => s.pl_autoMode);
  const showAllRankings = useStore(s => s.pl_showAllRankings);
  const deployStatus = useStore(s => s.pl_deployStatus);
  const backtestTimeframe = useStore(s => s.pl_backtestTimeframe);
  const setAnalysis = useStore(s => s.setPlAnalysis);
  const setSelectedTemplate = useStore(s => s.setPlSelectedTemplate);
  const setGeneratedCode = useStore(s => s.setPlGeneratedCode);
  const setBacktest = useStore(s => s.setPlBacktest);
  const setAutoMode = useStore(s => s.setPlAutoMode);
  const setShowAllRankings = useStore(s => s.setPlShowAllRankings);
  const setDeployStatus = useStore(s => s.setPlDeployStatus);
  const setBacktestTimeframe = useStore(s => s.setPlBacktestTimeframe);

  // Ephemeral state (OK to reset on remount)
  const [templates, setTemplates] = useState([]);
  const [communityScripts, setCommunityScripts] = useState([]);
  const [loading, setLoading] = useState('');
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [symbolQuery, setSymbolQuery] = useState('');
  const [symbolResults, setSymbolResults] = useState([]);
  const [symbolSearchOpen, setSymbolSearchOpen] = useState(false);

  useEffect(() => {
    loadTemplates();
    loadCommunityScripts();
  }, []);

  const loadTemplates = async () => {
    const res = await fetch('/api/pine/templates');
    const data = await res.json();
    if (data.success) setTemplates(data.templates);
  };

  const loadCommunityScripts = async () => {
    try {
      const res = await fetch('/api/pine/community');
      const data = await res.json();
      if (data.success) setCommunityScripts(data.scripts);
    } catch (e) {}
  };

  const loadCommunityScript = async (id) => {
    setLoading('community');
    try {
      const res = await fetch(`/api/pine/community/${id}`);
      const data = await res.json();
      if (data.success) {
        setGeneratedCode(data.source);
        setDeployStatus(null);
      }
    } catch (e) {}
    setLoading('');
  };

  const analyzeChart = async () => {
    setLoading('analyzing');
    try {
      const tfQs = backtestTimeframe ? `?timeframe=${encodeURIComponent(backtestTimeframe)}` : '';
      const res = await fetch(`/api/pine/analyze${tfQs}`);
      const data = await res.json();
      if (data.success) {
        setAnalysis(data);
        if (data.selection) {
          setSelectedTemplate(data.selection.strategy);
          // Auto-show backtest for top ranked strategy
          const topRanked = data.selection.rankings?.[0];
          if (topRanked?.backtest) {
            setBacktest({ success: true, backtest: topRanked.backtest, method: 'js_simulation' });
          }
        }
      }
    } catch (e) {}
    setLoading('');
  };

  const generateScript = async (auto = false) => {
    setLoading('generating');
    try {
      const body = auto ? { auto: true } : { strategy: selectedTemplate };
      const res = await fetch('/api/pine/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success) {
        setGeneratedCode(data.code);
        if (data.analysis) {
          setAnalysis(prev => ({ ...prev, ...data }));
        }
        setSelectedTemplate(data.strategy);
      }
    } catch (e) {}
    setLoading('');
  };

  const deployToTV = async () => {
    if (!generatedCode) return;
    setLoading('deploying');
    setDeployStatus('⏳ Deploying to TradingView...');
    try {
      const res = await fetch('/api/pine/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: generatedCode })
      });
      const data = await res.json();
      if (data.success) {
        const stepsText = (data.steps || []).join('\n');
        setDeployStatus(`✅ ${data.message}\n${stepsText}`);
      } else {
        const stepsText = (data.steps || []).join('\n');
        setDeployStatus(`❌ ${data.error}\n${stepsText}`);
      }
    } catch (e) {
      setDeployStatus('❌ Failed to connect — is TradingView running?');
    }
    setLoading('');
  };

  const runBacktest = async (stratId) => {
    if (!stratId) return;
    setBacktestLoading(true);
    setBacktest(null);
    try {
      const body = { strategy: stratId };
      if (backtestTimeframe) body.timeframe = backtestTimeframe;
      const res = await fetch('/api/pine/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success) setBacktest(data);
    } catch (e) {}
    setBacktestLoading(false);
  };

  const autoGenerate = async () => {
    setAutoMode(true);
    setLoading('auto');
    setBacktest(null);
    try {
      // Step 1: Analyze
      const tfQs = backtestTimeframe ? `?timeframe=${encodeURIComponent(backtestTimeframe)}` : '';
      const res1 = await fetch(`/api/pine/analyze${tfQs}`);
      const data1 = await res1.json();
      let stratId = null;
      if (data1.success) {
        setAnalysis(data1);
        stratId = data1.selection?.strategy;
        setSelectedTemplate(stratId);
      }

      // Step 2: Generate
      const res2 = await fetch('/api/pine/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto: true })
      });
      const data2 = await res2.json();
      if (data2.success) {
        setGeneratedCode(data2.code);
        setSelectedTemplate(data2.strategy);
        stratId = data2.strategy;
      }

      // Step 3: Backtest recommended strategy
      if (stratId) {
        setBacktestLoading(true);
        const btBody = { strategy: stratId };
        if (backtestTimeframe) btBody.timeframe = backtestTimeframe;
        const res3 = await fetch('/api/pine/backtest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(btBody)
        });
        const data3 = await res3.json();
        if (data3.success) setBacktest(data3);
        setBacktestLoading(false);
      }
    } catch (e) {}
    setLoading('');
  };

  const getRegimeIcon = (regime) => {
    const icons = {
      trending_up: '📈', trending_down: '📉', ranging: '↔️',
      squeeze: '🔒', volatile: '⚡', unknown: '❓'
    };
    return icons[regime] || '❓';
  };

  const getRegimeColor = (regime) => {
    const colors = {
      trending_up: '#4caf50', trending_down: '#f44336', ranging: '#ff9800',
      squeeze: '#9c27b0', volatile: '#e91e63'
    };
    return colors[regime] || '#888';
  };

  const getScoreLabel = (score) => {
    if (score >= 60) return { text: 'STRONG BUY', color: '#00c853' };
    if (score >= 30) return { text: 'BUY', color: '#4caf50' };
    if (score >= -30) return { text: 'NEUTRAL', color: '#ff9800' };
    if (score >= -60) return { text: 'SELL', color: '#f44336' };
    return { text: 'STRONG SELL', color: '#d50000' };
  };

  // ── Symbol Search ──
  const searchSymbol = async (q) => {
    setSymbolQuery(q);
    if (q.length < 2) { setSymbolResults([]); return; }
    try {
      const res = await fetch(`/api/symbol-search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data.success) setSymbolResults(data.results || []);
    } catch (e) { setSymbolResults([]); }
  };

  const selectSymbol = async (sym) => {
    setSymbolSearchOpen(false);
    setSymbolQuery('');
    setSymbolResults([]);
    setLoading('switching');
    try {
      await fetch('/api/chart/set-symbol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: sym.full_name || sym.symbol })
      });
    } catch (e) {}
    setLoading('');
  };

  return (
    <div className="pine-lab-page">
      {/* Symbol Search Bar */}
      <div className="card symbol-search-card">
        <div className="symbol-search-row">
          <span className="symbol-search-icon">🔍</span>
          <input
            type="text"
            className="symbol-search-input"
            placeholder="Search symbol... (e.g. NIFTY, RELIANCE, AAPL)"
            value={symbolQuery}
            onChange={e => { searchSymbol(e.target.value); setSymbolSearchOpen(true); }}
            onFocus={() => symbolResults.length > 0 && setSymbolSearchOpen(true)}
          />
          {loading === 'switching' && <span className="symbol-switching">⏳ Switching...</span>}
          {analysis?.symbol && <span className="symbol-current">📌 {analysis.symbol}</span>}
        </div>
        {symbolSearchOpen && symbolResults.length > 0 && (
          <div className="symbol-results-dropdown">
            {symbolResults.map((r, i) => (
              <div key={i} className="symbol-result-item" onClick={() => selectSymbol(r)}>
                <span className="sr-name">{r.full_name}</span>
                <span className="sr-desc">{r.description}</span>
                <span className="sr-type">{r.type}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Auto Mode Hero */}
      <div className="card auto-card">
        <div className="card-header">
          <h2>🧪 Pine Script Lab</h2>
          <InfoTooltip text={"Quant-Grade Strategy Lab\n\n• Detects regime via ADX + Hurst exponent + Variance Ratio\n• Backtests with realistic execution: next-bar-open entry, slippage & costs\n• Splits data 70/30 for out-of-sample (OOS) validation\n• Scores via Probabilistic Sharpe + Wilson lower-bound + Calmar + Sortino\n• Applies Deflated Sharpe correction for selection bias\n• Picks the strategy with proven edge in your CURRENT market regime"} />
          <span className="lab-badge">AI-Powered</span>
        </div>
        <p className="lab-desc">
          Analyze your live chart, auto-select the optimal strategy, generate Pine Script, and deploy to TradingView — all in one click.
        </p>
        <div className="tf-selector-row">
          <label className="tf-selector-label">
            <span>⏱ Backtest Timeframe</span>
            <InfoTooltip text={"Select the timeframe to use for backtesting & ranking strategies.\n\n• Chart (default): uses the chart's current TF\n• Other TFs: chart briefly switches to fetch bars at that resolution, then restores\n\nUse this to compare strategy performance across different timeframes (e.g., 15m intraday vs 1H swing vs 1D positional)."} />
          </label>
          <select
            className="tf-selector"
            value={backtestTimeframe}
            onChange={(e) => setBacktestTimeframe(e.target.value)}
            disabled={!!loading}
          >
            <option value="">Chart (current TF)</option>
            <option value="1">1 minute</option>
            <option value="3">3 minutes</option>
            <option value="5">5 minutes</option>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="120">2 hours</option>
            <option value="240">4 hours</option>
            <option value="D">1 day</option>
            <option value="W">1 week</option>
            <option value="M">1 month</option>
          </select>
          {backtestTimeframe && (
            <span className="tf-selector-hint">Chart will briefly switch to {backtestTimeframe === 'D' ? '1D' : backtestTimeframe === 'W' ? '1W' : backtestTimeframe === 'M' ? '1M' : `${backtestTimeframe}m`} & restore</span>
          )}
        </div>
        <div className="auto-actions">
          <button
            className={`btn-auto ${loading === 'auto' ? 'loading' : ''}`}
            onClick={autoGenerate}
            disabled={!!loading}
          >
            {loading === 'auto' ? '⏳ Analyzing & Generating...' : '🤖 Auto Mode — Analyze → Generate → Ready'}
          </button>
          <button
            className={`btn-analyze ${loading === 'analyzing' ? 'loading' : ''}`}
            onClick={analyzeChart}
            disabled={!!loading}
          >
            {loading === 'analyzing' ? '⏳ Reading chart...' : '📊 Analyze Chart Only'}
          </button>
        </div>
      </div>

      {/* Analysis Results — Enhanced with Rankings */}
      {analysis && (
        <div className="card analysis-card">
          <div className="card-header">
            <h2>📊 Market Intelligence</h2>
            <span className="analysis-symbol">{analysis.symbol} • ₹{analysis.price?.toLocaleString()}</span>
          </div>

          {/* Quality Banner — warnings, ambiguity, actionability */}
          {analysis.selection?.dataQuality?.warnings?.length > 0 && (
            <div className={`quality-banner ${analysis.selection.actionable ? 'warning' : 'critical'}`}>
              <span className="quality-icon">{analysis.selection.actionable ? '⚠️' : '🛑'}</span>
              <div className="quality-msgs">
                {analysis.selection.dataQuality.warnings.map((w, i) => <div key={i}>{w}</div>)}
              </div>
              <span className={`quality-verdict ${analysis.selection.qualityVerdict}`}>{analysis.selection.qualityVerdict?.toUpperCase()}</span>
            </div>
          )}

          {/* Context Bar — shows what the engine detected */}
          {analysis.selection?.context && (
            <div className="context-bar">
              <div className="context-chip" title="Market Regime">
                <span className="ctx-icon">{getRegimeIcon(analysis.selection.context.regime)}</span>
                <span className="ctx-label">{analysis.selection.context.regime?.replace('_', ' ')}</span>
                {analysis.selection.context.regimeBars > 0 && (
                  <span className="ctx-meta">{analysis.selection.context.regimeBars}b</span>
                )}
              </div>
              <div className={`context-chip stab-${analysis.selection.context.regimeStability}`} title="Regime Stability">
                <span className="ctx-icon">🎯</span>
                <span className="ctx-label">{analysis.selection.context.regimeStability} risk</span>
              </div>
              <div className="context-chip" title="Volatility">
                <span className="ctx-icon">📊</span>
                <span className="ctx-label">{analysis.selection.context.volatility} vol</span>
                {analysis.selection.context.volatilityPercentile != null && (
                  <span className="ctx-meta">{analysis.selection.context.volatilityPercentile}%ile</span>
                )}
              </div>
              <div className="context-chip" title="Kaufman Efficiency Ratio">
                <span className="ctx-icon">⚡</span>
                <span className="ctx-label">{analysis.selection.context.trendStrength} trend</span>
                {analysis.selection.context.efficiencyRatio != null && (
                  <span className="ctx-meta">ER {analysis.selection.context.efficiencyRatio}%</span>
                )}
              </div>
              <div className={`context-chip mtf-${analysis.selection.context.mtfConfluence}`} title="Multi-Timeframe Alignment">
                <span className="ctx-icon">📐</span>
                <span className="ctx-label">MTF: {analysis.selection.context.mtfConfluence}</span>
                {analysis.selection.context.htfDirection !== 'unknown' && (
                  <span className="ctx-meta">HTF {analysis.selection.context.htfDirection}</span>
                )}
              </div>
              <div className="context-chip" title="Trend Maturity">
                <span className="ctx-icon">⏱️</span>
                <span className="ctx-label">{analysis.selection.context.trendMaturity}</span>
              </div>
              <div className="context-chip" title="Volume Profile">
                <span className="ctx-icon">📈</span>
                <span className="ctx-label">{analysis.selection.context.volumeProfile} vol</span>
              </div>
              <div className="context-chip" title="Asset Class">
                <span className="ctx-icon">🏷️</span>
                <span className="ctx-label">{analysis.selection.context.assetClass}</span>
              </div>
              {analysis.selection.context.session !== 'n/a' && (
                <div className="context-chip" title="Session">
                  <span className="ctx-icon">🕐</span>
                  <span className="ctx-label">{analysis.selection.context.session}</span>
                </div>
              )}
              {analysis.selection.context.divergence !== 'none' && (
                <div className="context-chip divergence" title="Divergence Detected (swing-point based)">
                  <span className="ctx-icon">⚠️</span>
                  <span className="ctx-label">{analysis.selection.context.divergence} div</span>
                </div>
              )}
            </div>
          )}

          <div className="analysis-grid">
            <div className="analysis-item regime">
              <span className="analysis-label">Market Regime</span>
              <span className="analysis-value" style={{ color: getRegimeColor(analysis.analysis?.regime) }}>
                {getRegimeIcon(analysis.analysis?.regime)} {analysis.analysis?.regime?.replace('_', ' ').toUpperCase()}
              </span>
              <span className="analysis-sub">Confidence: {analysis.analysis?.regimeConfidence}%</span>
            </div>

            <div className="analysis-item score">
              <span className="analysis-label">Composite Score</span>
              <span className="analysis-value" style={{ color: getScoreLabel(analysis.analysis?.compositeScore).color }}>
                {getScoreLabel(analysis.analysis?.compositeScore).text}
              </span>
              <div className="score-bar">
                <div className="score-fill" style={{
                  width: `${Math.abs(analysis.analysis?.compositeScore || 0)}%`,
                  background: getScoreLabel(analysis.analysis?.compositeScore).color,
                  marginLeft: (analysis.analysis?.compositeScore || 0) < 0 ? `${50 - Math.abs(analysis.analysis?.compositeScore || 0) / 2}%` : '50%',
                }}></div>
                <div className="score-center"></div>
              </div>
            </div>

            <div className="analysis-item recommendation">
              <span className="analysis-label">AI Confidence</span>
              <span className={`analysis-value confidence-${analysis.selection?.confidence}`}>
                {analysis.selection?.confidence?.toUpperCase()} ({analysis.selection?.score}/100)
              </span>
              <span className="analysis-sub">{analysis.selection?.reason}</span>
            </div>
          </div>

          {/* Rankings — the core of the intelligent selector */}
          {analysis.selection?.rankings?.length > 0 && (
            <div className="rankings-section">
              <div className="rankings-header">
                <h3>🏆 Strategy Rankings</h3>
                <span className="rankings-sub">Quant-grade: 65% backtest (PSR + Wilson + OOS + Calmar + regime fit) + 35% AI</span>
              </div>
              <div className="rankings-list">
                {(showAllRankings ? analysis.selection.rankings : analysis.selection.rankings.slice(0, 3)).map((r, i) => (
                  <div
                    key={r.id}
                    className={`ranking-item ${selectedTemplate === r.id ? 'selected' : ''} rank-${i + 1}`}
                    onClick={() => { setSelectedTemplate(r.id); if (!r.backtest) runBacktest(r.id); else setBacktest({ success: true, backtest: r.backtest, method: 'js_simulation' }); }}
                  >
                    <div className="rank-position">
                      <span className="rank-num">#{i + 1}</span>
                      <div className="rank-score-ring" style={{ '--score': r.finalScore || r.score }}>
                        <span className="rank-score">{r.finalScore || r.score}</span>
                      </div>
                      {r.aiScore != null && r.finalScore != null && r.aiScore !== r.finalScore && (
                        <span className="rank-ai-score" title="AI-only score (before backtest)">AI: {r.aiScore}</span>
                      )}
                    </div>
                    <div className="rank-info">
                      <div className="rank-title-row">
                        <span className="rank-name">{r.name}</span>
                        <span className={`rank-style ${r.style}`}>{r.style.replace('_', ' ')}</span>
                        <span className={`rank-source ${r.source === 'backtested' ? 'backtested' : 'ai-only'}`}>
                          {r.source === 'backtested' ? '✓ backtested' : 'AI only'}
                        </span>
                      </div>
                      <div className="rank-factors">
                        {r.factors.map((f, fi) => (
                          <span key={fi} className={`factor-chip ${f.impact === '+' ? 'positive' : 'negative'}`}>
                            {f.impact === '+' ? '✓' : '✗'} {f.label}
                          </span>
                        ))}
                      </div>
                      <div className="rank-meta">
                        <span className={`risk-badge risk-${r.riskLevel}`}>{r.riskLevel} risk</span>
                        <span className="holding-badge">⏱ {r.holdingPeriod}</span>
                        {r.backtest && (
                          <>
                            <span className={`bt-inline ${r.backtest.winRate >= 50 ? 'positive' : 'negative'}`}>
                              {r.backtest.winRate}% WR
                            </span>
                            {r.backtest.wilsonWR != null && (
                              <span className="bt-inline" title="95% Wilson lower-bound win rate">
                                LB {r.backtest.wilsonWR}%
                              </span>
                            )}
                            <span className={`bt-inline ${r.backtest.totalPnl >= 0 ? 'positive' : 'negative'}`}>
                              {r.backtest.totalPnl >= 0 ? '+' : ''}{r.backtest.totalPnl}% P&L
                            </span>
                            {r.backtest.capital && (
                              <span className={`bt-inline ${r.backtest.capital.netProfit >= 0 ? 'positive' : 'negative'}`} title="Net profit on ₹1L capital">
                                {r.backtest.capital.netProfit >= 0 ? '+' : ''}₹{(r.backtest.capital.netProfit / 1000).toFixed(1)}K
                              </span>
                            )}
                            <span className="bt-inline">{r.backtest.totalTrades}T</span>
                            {r.backtest.psr != null && (
                              <span className={`bt-inline ${r.backtest.psr >= 60 ? 'positive' : r.backtest.psr >= 40 ? '' : 'negative'}`} title="Probabilistic Sharpe Ratio: P(true Sharpe>0)">
                                PSR {r.backtest.psr}%
                              </span>
                            )}
                            {r.backtest.calmar != null && (
                              <span className="bt-inline" title="Calmar Ratio: Return/MaxDD">
                                Cal {r.backtest.calmar}
                              </span>
                            )}
                            {r.backtest.oos?.trades >= 3 && (
                              <span className={`bt-inline ${r.backtest.oos.winRate >= 50 ? 'positive' : 'negative'}`} title="Out-of-sample win rate (last 30% of bars)">
                                OOS {r.backtest.oos.winRate}%
                              </span>
                            )}
                            {r.backtest.currentSignal && r.backtest.currentSignal.type !== 'WAIT' && (
                              <span className={`signal-live ${r.backtest.currentSignal.type.toLowerCase()}`}>
                                {r.backtest.currentSignal.type}
                              </span>
                            )}
                          </>
                        )}
                        {r.hardFilters && r.hardFilters.length > 0 && (
                          <span className="bt-inline negative" title={`Quant filters triggered: ${r.hardFilters.join(', ')}`}>
                            ⚠ {r.hardFilters.length} penalty
                          </span>
                        )}
                        {r.proven === false && (
                          <span className="bt-inline muted" title="No quantitative backtest available — score capped at 50">
                            UNPROVEN
                          </span>
                        )}
                        {!r.backtest && r.monitorable === false && (
                          <span className="bt-inline muted">deploy to backtest</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {analysis.selection.rankings.length > 3 && (
                <button className="btn-show-more" onClick={() => setShowAllRankings(!showAllRankings)}>
                  {showAllRankings ? '▲ Show Top 3' : `▼ Show All ${analysis.selection.rankings.length} Rankings`}
                </button>
              )}
            </div>
          )}

          {/* Indicator readings */}
          {analysis.analysis?.indicators && (
            <div className="indicators-row">
              {Object.entries(analysis.analysis.indicators).map(([key, val]) => {
                if (!val || typeof val === 'object') return null;
                return (
                  <div key={key} className="ind-chip">
                    <span className="ind-name">{key.toUpperCase()}</span>
                    <span className="ind-val">{val}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Signals */}
          {analysis.analysis?.signals?.length > 0 && (
            <div className="signals-list">
              <span className="signals-label">Signals Detected:</span>
              {analysis.analysis.signals.map((s, i) => (
                <span key={i} className={`signal-chip ${s.type.toLowerCase()}`}>
                  {s.type}: {s.reason} ({s.strength}%)
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Backtest Results + Signal Scanner */}
      {(backtest || backtestLoading) && (
        <div className="card backtest-card">
          <div className="card-header">
            <h2>📈 Backtest & Signal Scanner</h2>
            {backtest?.backtest && (
              <span className="bt-bars">
                {backtest.backtest.barsAnalyzed} bars analyzed
                {backtestTimeframe && <span className="bt-tf-badge"> · TF: {backtestTimeframe === 'D' ? '1D' : backtestTimeframe === 'W' ? '1W' : backtestTimeframe === 'M' ? '1M' : `${backtestTimeframe}m`}</span>}
              </span>
            )}
          </div>

          {backtestLoading && <div className="bt-loading">⏳ Running backtest simulation...</div>}

          {backtest?.method === 'requires_deploy' && (
            <div className="bt-deploy-hint">
              <span className="bt-hint-icon">⚡</span>
              <div>
                <strong>No JS Backtest — Auto-Deploy Available</strong>
                <p>Click "Deploy to TradingView" below to auto-compile and check results in Strategy Tester.</p>
              </div>
            </div>
          )}

          {backtest?.backtest && (
            <>
              {/* Current Signal */}
              {backtest.backtest.currentSignal && (
                <div className={`bt-signal signal-${backtest.backtest.currentSignal.type.toLowerCase()}`}>
                  <span className="signal-badge">{backtest.backtest.currentSignal.type === 'BUY' ? '🟢 BUY SIGNAL' : backtest.backtest.currentSignal.type === 'IN_TRADE' ? '🔵 IN POSITION' : '⏸️ WAITING'}</span>
                  <span className="signal-detail">
                    {backtest.backtest.currentSignal.type === 'IN_TRADE'
                      ? `Entry: ₹${backtest.backtest.currentSignal.entryPrice?.toFixed(2)} | P&L: ${backtest.backtest.currentSignal.unrealizedPnl}% | ${backtest.backtest.currentSignal.barsHeld} bars`
                      : backtest.backtest.currentSignal.type === 'BUY'
                      ? `Entry conditions met at ₹${backtest.backtest.currentSignal.price?.toFixed(2)}`
                      : 'No entry signal — waiting for setup'
                    }
                  </span>
                </div>
              )}

              {/* Stats Grid */}
              <div className="bt-stats-grid">
                <div className="bt-stat">
                  <span className="bt-stat-label">Win Rate</span>
                  <span className={`bt-stat-value ${backtest.backtest.winRate >= 50 ? 'positive' : 'negative'}`}>{backtest.backtest.winRate}%</span>
                  <span className="bt-stat-sub">{backtest.backtest.wins}W / {backtest.backtest.losses}L</span>
                </div>
                <div className="bt-stat">
                  <span className="bt-stat-label" title="Wilson 95% lower bound — what the win rate likely is, accounting for sample size">Wilson LB</span>
                  <span className={`bt-stat-value ${(backtest.backtest.wilsonWR || 0) >= 50 ? 'positive' : 'negative'}`}>{backtest.backtest.wilsonWR != null ? `${backtest.backtest.wilsonWR}%` : '—'}</span>
                  <span className="bt-stat-sub">95% confidence</span>
                </div>
                <div className="bt-stat">
                  <span className="bt-stat-label">Total P&L</span>
                  <span className={`bt-stat-value ${backtest.backtest.totalPnl >= 0 ? 'positive' : 'negative'}`}>{backtest.backtest.totalPnl > 0 ? '+' : ''}{backtest.backtest.totalPnl}%</span>
                  <span className="bt-stat-sub">{backtest.backtest.totalTrades} trades, net of costs</span>
                </div>
                <div className="bt-stat">
                  <span className="bt-stat-label" title="Probabilistic Sharpe Ratio: probability that the true Sharpe exceeds 0">PSR</span>
                  <span className={`bt-stat-value ${(backtest.backtest.psr || 0) >= 60 ? 'positive' : (backtest.backtest.psr || 0) >= 40 ? '' : 'negative'}`}>{backtest.backtest.psr != null ? `${backtest.backtest.psr}%` : '—'}</span>
                  <span className="bt-stat-sub">P(Sharpe&gt;0)</span>
                </div>
                <div className="bt-stat">
                  <span className="bt-stat-label">Profit Factor</span>
                  <span className={`bt-stat-value ${backtest.backtest.profitFactor >= 1.5 ? 'positive' : backtest.backtest.profitFactor >= 1 ? '' : 'negative'}`}>{backtest.backtest.profitFactor}x</span>
                  <span className="bt-stat-sub">Avg Win: {backtest.backtest.avgWin}%</span>
                </div>
                <div className="bt-stat">
                  <span className="bt-stat-label">Max Drawdown</span>
                  <span className="bt-stat-value negative">-{backtest.backtest.maxDrawdown}%</span>
                  <span className="bt-stat-sub">Avg Loss: {backtest.backtest.avgLoss}%</span>
                </div>
                <div className="bt-stat">
                  <span className="bt-stat-label" title="Sortino: downside risk-adjusted return">Sortino</span>
                  <span className={`bt-stat-value ${(backtest.backtest.sortino || 0) >= 0.5 ? 'positive' : ''}`}>{backtest.backtest.sortino != null ? backtest.backtest.sortino : '—'}</span>
                  <span className="bt-stat-sub">Sharpe: {backtest.backtest.sharpe}</span>
                </div>
                <div className="bt-stat">
                  <span className="bt-stat-label" title="Calmar Ratio: total return / max drawdown">Calmar</span>
                  <span className={`bt-stat-value ${(backtest.backtest.calmar || 0) >= 1 ? 'positive' : ''}`}>{backtest.backtest.calmar != null ? backtest.backtest.calmar : '—'}</span>
                  <span className="bt-stat-sub">Ulcer: {backtest.backtest.ulcer}</span>
                </div>
                {backtest.backtest.oos && (
                  <div className="bt-stat">
                    <span className="bt-stat-label" title="Out-of-sample: trades from the last 30% of bars (held-out test set)">OOS Test</span>
                    <span className={`bt-stat-value ${(backtest.backtest.oos.wilsonWR || 0) >= 50 ? 'positive' : 'negative'}`}>{backtest.backtest.oos.wilsonWR}%</span>
                    <span className="bt-stat-sub">{backtest.backtest.oos.trades}T · {backtest.backtest.oos.totalPnl > 0 ? '+' : ''}{backtest.backtest.oos.totalPnl}%</span>
                  </div>
                )}
                <div className="bt-stat">
                  <span className="bt-stat-label">Avg Hold</span>
                  <span className="bt-stat-value">{backtest.backtest.avgBarsHeld} bars</span>
                  <span className="bt-stat-sub">{backtest.backtest.name}</span>
                </div>
                {backtest.backtest.bootstrap95 && (
                  <div className="bt-stat">
                    <span className="bt-stat-label" title="95% bootstrap confidence interval for mean trade P&L">Mean P&L (CI)</span>
                    <span className={`bt-stat-value ${backtest.backtest.bootstrap95.lower > 0 ? 'positive' : ''}`}>
                      [{backtest.backtest.bootstrap95.lower}, {backtest.backtest.bootstrap95.upper}]
                    </span>
                    <span className="bt-stat-sub">Skew: {backtest.backtest.skew} · Kurt: {backtest.backtest.kurtosis}</span>
                  </div>
                )}
                {backtest.backtest.quantScore != null && (
                  <div className="bt-stat">
                    <span className="bt-stat-label" title="Composite quant-grade score combining PSR, Wilson, Calmar, Sortino, OOS, regime fit">Quant Score</span>
                    <span className={`bt-stat-value ${backtest.backtest.quantScore >= 70 ? 'positive' : backtest.backtest.quantScore >= 50 ? '' : 'negative'}`}>{backtest.backtest.quantScore}/100</span>
                    <span className="bt-stat-sub">Deflated for selection bias</span>
                  </div>
                )}
                {backtest.backtest.capital && (
                  <>
                    <div className="bt-stat">
                      <span className="bt-stat-label" title="Net profit on ₹1,00,000 capital with full (100%) position sizing">Net P&L (₹)</span>
                      <span className={`bt-stat-value ${backtest.backtest.capital.netProfit >= 0 ? 'positive' : 'negative'}`}>
                        {backtest.backtest.capital.netProfit >= 0 ? '+' : ''}₹{backtest.backtest.capital.netProfit.toLocaleString('en-IN')}
                      </span>
                      <span className="bt-stat-sub">₹1L → ₹{(backtest.backtest.capital.final / 1000).toFixed(1)}K</span>
                    </div>
                    <div className="bt-stat">
                      <span className="bt-stat-label" title="Maximum drawdown in rupees">Max DD (₹)</span>
                      <span className="bt-stat-value negative">-₹{backtest.backtest.capital.maxDrawdownRs.toLocaleString('en-IN')}</span>
                      <span className="bt-stat-sub">{backtest.backtest.capital.positionSizePct}% per trade</span>
                    </div>
                  </>
                )}
              </div>

              {/* Regime Performance */}
              {backtest.backtest.regimePerformance && Object.keys(backtest.backtest.regimePerformance).length > 1 && (
                <div className="bt-regime-perf">
                  <span className="bt-regime-label">Performance by Market Regime</span>
                  <div className="bt-regime-chips">
                    {Object.entries(backtest.backtest.regimePerformance)
                      .filter(([_, v]) => v.count >= 1)
                      .sort((a, b) => b[1].count - a[1].count)
                      .map(([regime, stats]) => (
                      <div key={regime} className={`regime-perf-chip ${stats.winRate >= 50 ? 'positive' : 'negative'}`}>
                        <span className="rp-regime">{regime.replace('_', ' ')}</span>
                        <span className="rp-stats">{stats.winRate}% WR · {stats.totalPnl > 0 ? '+' : ''}{stats.totalPnl}% · {stats.count}T</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Mini Equity Curve */}
              {backtest.backtest.equity?.length > 2 && (
                <div className="bt-equity">
                  <span className="bt-equity-label">Equity Curve ({backtest.backtest.totalTrades} trades)</span>
                  <div className="bt-equity-chart">
                    {(() => {
                      const eq = backtest.backtest.equity;
                      const min = Math.min(...eq);
                      const max = Math.max(...eq);
                      const range = max - min || 1;
                      const points = eq.map((v, i) => `${(i / (eq.length - 1)) * 100},${100 - ((v - min) / range) * 80 - 10}`).join(' ');
                      return (
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="equity-svg">
                          <polyline points={points} fill="none" stroke={backtest.backtest.totalPnl >= 0 ? '#00c853' : '#f44336'} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                          <line x1="0" y1="90" x2="100" y2="90" stroke="var(--border)" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
                        </svg>
                      );
                    })()}
                    <div className="bt-equity-range">
                      <span>{Math.min(...backtest.backtest.equity).toFixed(1)}%</span>
                      <span>{Math.max(...backtest.backtest.equity).toFixed(1)}%</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Recent Trades */}
              {backtest.backtest.trades?.length > 0 && (
                <div className="bt-trades">
                  <span className="bt-trades-label">Recent Trades</span>
                  <div className="bt-trades-list">
                    {backtest.backtest.trades.map((t, i) => (
                      <div key={i} className={`bt-trade ${t.pnl >= 0 ? 'win' : 'loss'}`}>
                        <span className="bt-trade-pnl">{t.pnl > 0 ? '+' : ''}{t.pnl}%</span>
                        <span className="bt-trade-exit">{t.exitReason}</span>
                        <span className="bt-trade-bars">{t.barsHeld}b</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Template Selection */}
      <div className="card">
        <div className="card-header">
          <h2>📝 All Strategies & Scripts</h2>
          <span className="template-count">{templates.length} available</span>
        </div>

        <div className="templates-grid">
          {templates.map(t => (
            <div
              key={t.id}
              className={`template-card ${selectedTemplate === t.id ? 'selected' : ''} ${analysis?.selection?.strategy === t.id ? 'recommended' : ''} ${analysis?.selection?.alt?.strategy === t.id ? 'alt-recommended' : ''}`}
              onClick={() => { setSelectedTemplate(t.id); runBacktest(t.id); }}
            >
              {analysis?.selection?.strategy === t.id && <span className="recommended-badge">★ RECOMMENDED</span>}
              {analysis?.selection?.alt?.strategy === t.id && <span className="recommended-badge alt-badge">⚡ ALT</span>}
              <span className="template-name">{t.name}</span>
              <span className="template-desc">{t.description}</span>
              <div className="template-meta">
                <span className={`template-type ${t.type}`}>{t.type}</span>
                <span className="template-regime">{t.style?.replace('_', ' ') || ''}</span>
                {t.backtestable && <span className="template-source backtested">✓ quant</span>}
              </div>
            </div>
          ))}
        </div>

        <button
          className="btn-generate"
          onClick={() => generateScript(false)}
          disabled={!selectedTemplate || !!loading}
        >
          {loading === 'generating' ? '⏳ Generating...' : `⚡ Generate ${selectedTemplate?.replace(/_/g, ' ') || 'Script'}`}
        </button>
      </div>

      {/* Pine Script Library — all available scripts */}
      {communityScripts.length > 0 && (
        <div className="card community-card">
          <div className="card-header">
            <h2>📚 Script Library</h2>
            <span className="template-count">{communityScripts.length} pine scripts</span>
          </div>
          <p className="lab-desc" style={{ marginBottom: '12px' }}>
            All available Pine scripts. Click to load source, then deploy to your chart. Scripts with ✓ have JS backtest engines.
          </p>
          <div className="templates-grid">
            {communityScripts.map(s => (
              <div
                key={s.id}
                className="template-card"
                onClick={() => loadCommunityScript(s.id)}
              >
                <span className="template-name">{s.name}</span>
                <span className="template-desc">{s.description}</span>
                <div className="template-meta">
                  <span className={`template-type ${s.type}`}>{s.type}</span>
                  <span className="template-regime">{s.style?.replace('_', ' ') || ''}</span>
                  {s.backtestable && <span className="template-source backtested">✓ quant</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Generated Code */}
      {generatedCode && (
        <div className="card code-card">
          <div className="card-header">
            <h2>💻 Generated Pine Script</h2>
            <div className="code-actions">
              <button className="btn-copy" onClick={() => {
                navigator.clipboard.writeText(generatedCode);
                setDeployStatus('Copied to clipboard!');
                setTimeout(() => setDeployStatus(null), 2000);
              }}>📋 Copy</button>
              <button
                className={`btn-deploy ${loading === 'deploying' ? 'loading' : ''}`}
                onClick={deployToTV}
                disabled={!!loading}
              >
                {loading === 'deploying' ? '⏳ Deploying...' : '🚀 Deploy to TradingView'}
              </button>
            </div>
          </div>

          {deployStatus && (
            <div className={`deploy-status ${deployStatus.startsWith('✅') ? 'success' : deployStatus.startsWith('❌') ? 'error' : 'pending'}`}>
              {deployStatus.split('\n').map((line, i) => <div key={i}>{line}</div>)}
            </div>
          )}

          <pre className="code-block"><code>{generatedCode}</code></pre>
        </div>
      )}
    </div>
  );
}
