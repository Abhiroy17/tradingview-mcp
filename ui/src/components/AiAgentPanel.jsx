import { useState, useCallback, useEffect, useRef } from 'react';
import { useStore } from '../store';
import './AiAgentPanel.css';

const PROMPT_TEMPLATES = [
  { id: 'trade', label: '📈 Trade Plan', suffix: '\n\nBased on this briefing, give me a concrete trade plan: entry, stop-loss, take-profit, position size, and confidence level.' },
  { id: 'risk', label: '⚠️ Risk Check', suffix: '\n\nAnalyze the risks for this setup. What could go wrong? What regime shift signals should I watch?' },
  { id: 'pine', label: '🧪 Pine Patch', suffix: '\n\nSuggest a Pine Script improvement for the top strategy. Use pine_set_source and pine_smart_compile to apply it.' },
  { id: 'similar', label: '🔍 Similar Setups', suffix: '\n\nFind historically similar market conditions and how they resolved. Use data_get_ohlcv to check recent patterns.' },
  { id: 'compare', label: '🏆 Compare Winners', suffix: '\n\nCompare the top 3 strategies and explain which one fits current conditions best and why.' },
  { id: 'feed', label: '📡 Check Feed', suffix: '\n\nCall tv_live_feed_get to check if any new signals fired since this briefing was generated.' },
];

export default function AiAgentPanel({ api, status }) {
  // Persisted in Zustand store — survives tab switches
  const symbol = useStore(s => s.ai_symbol);
  const setSymbol = useStore(s => s.setAiSymbol);
  const briefing = useStore(s => s.ai_briefing);
  const setBriefing = useStore(s => s.setAiBriefing);
  const error = useStore(s => s.ai_error);
  const setError = useStore(s => s.setAiError);
  const feed = useStore(s => s.ai_feed);
  const setFeed = useStore(s => s.setAiFeed);
  const feedCursor = useStore(s => s.ai_feedCursor);
  const setFeedCursor = useStore(s => s.setAiFeedCursor);

  // Ephemeral UI state — OK to reset on remount
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [feedLoading, setFeedLoading] = useState(false);

  // Live Activity Log via SSE — proves data is flowing
  const [liveLog, setLiveLog] = useState([]);
  const [sseConnected, setSseConnected] = useState(false);
  const [lastTick, setLastTick] = useState(null);
  const logRef = useRef(null);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onopen = () => setSseConnected(true);
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        const now = new Date();
        const ts = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        setLastTick(now);

        let line = '';
        if (payload.type === 'status' && payload.data) {
          const d = payload.data;
          line = `[${ts}] 📈 ${d.symbol} ₹${d.price} (${d.changePercent >= 0 ? '+' : ''}${d.changePercent}%) RSI(2)=${d.rsi2}`;
        } else if (payload.type === 'alert' && payload.data) {
          const d = payload.data;
          line = `[${ts}] 🚨 ${d.type} ${d.symbol} — ${d.msg}`;
        } else if (payload.type === 'scanner_result' && payload.data) {
          const d = payload.data;
          line = `[${ts}] 🔍 SCAN ${d.symbol} ${d.signal || ''} ${d.strategy || ''}`;
        } else {
          line = `[${ts}] ${payload.type || 'event'}`;
        }

        setLiveLog(prev => [...prev.slice(-99), { ts: now.getTime(), line, type: payload.type }]);
      } catch {}
    };
    es.onerror = () => setSseConnected(false);
    return () => es.close();
  }, []);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [liveLog]);

  const handleSearch = useCallback(async (q) => {
    setSearchQuery(q);
    if (q.length < 2) { setSearchResults([]); return; }
    const res = await api.symbolSearch(q);
    if (res.success && res.results) setSearchResults(res.results.slice(0, 8));
  }, [api]);

  const generateBriefing = useCallback(async () => {
    if (!symbol) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/ai/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      const data = await res.json();
      if (data.success) {
        setBriefing(data);
        setFeedCursor(data.feedCursor || 0);
      } else {
        setError(data.error || 'Failed to generate briefing');
      }
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [symbol, setBriefing, setError, setFeedCursor]);

  const refreshFeed = useCallback(async () => {
    setFeedLoading(true);
    try {
      const res = await fetch(`/api/ai/feed?since=${feedCursor}&limit=50`);
      const data = await res.json();
      if (data.success && data.events?.length) {
        setFeed(data.events);
        setFeedCursor(data.cursor);
      }
    } catch {}
    setFeedLoading(false);
  }, [feedCursor, setFeed, setFeedCursor]);

  const copyToClipboard = useCallback((text, label) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
    });
  }, []);

  const useCurrentChart = useCallback(() => {
    if (status?.symbol) setSymbol(status.symbol);
  }, [status]);

  return (
    <div className="ai-agent-panel">
      {/* Symbol Picker */}
      <div className="ai-header">
        <div className="ai-symbol-picker">
          <div className="ai-search-box">
            <input
              type="text"
              placeholder="Search symbol (e.g., NSE:RELIANCE)..."
              value={searchQuery || symbol}
              onChange={(e) => { setSymbol(e.target.value); handleSearch(e.target.value); }}
              onFocus={() => handleSearch(symbol)}
            />
            {searchResults.length > 0 && (
              <div className="ai-search-dropdown">
                {searchResults.map((r, i) => (
                  <button key={i} onClick={() => { setSymbol(r.symbol || r); setSearchResults([]); setSearchQuery(''); }}>
                    {r.symbol || r} {r.description && <span className="ai-desc">— {r.description}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="ai-btn secondary" onClick={useCurrentChart} disabled={!status?.symbol}>
            📊 Use Current
          </button>
          <button className="ai-btn primary" onClick={generateBriefing} disabled={!symbol || loading}>
            {loading ? '⏳ Analyzing...' : '🤖 Generate Briefing'}
          </button>
        </div>
      </div>

      {error && <div className="ai-error">❌ {error}</div>}

      {briefing?.chartRestored && (
        <div className="ai-info">↩ Chart restored to monitored symbol after briefing.</div>
      )}

      {/* Live Activity Log — always visible, proves data is flowing */}
      <div className="ai-card ai-live-log">
        <h3>
          <span className={`live-dot ${sseConnected ? 'connected' : 'disconnected'}`}></span>
          Live Activity
          {lastTick && <span className="ai-last-tick">last: {lastTick.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}</span>}
          <button className="ai-btn-small" onClick={() => setLiveLog([])}>Clear</button>
        </h3>
        {liveLog.length === 0 ? (
          <div className="ai-empty">
            {sseConnected ? 'Connected — waiting for data ticks...' : 'Connecting to SSE stream...'}
          </div>
        ) : (
          <div className="ai-live-log-scroll" ref={logRef}>
            {liveLog.map((entry, i) => (
              <div key={i} className={`log-line log-${entry.type}`}>{entry.line}</div>
            ))}
          </div>
        )}
      </div>

      {briefing && (
        <div className="ai-content">
          {/* Row 1: Quote + Regime */}
          <div className="ai-row">
            <div className="ai-card ai-quote">
              <h3>💰 Quote</h3>
              <div className="ai-price">₹{briefing.quote.price?.toLocaleString()}</div>
              <div className={`ai-change ${briefing.quote.changePercent >= 0 ? 'positive' : 'negative'}`}>
                {briefing.quote.changePercent >= 0 ? '+' : ''}{briefing.quote.changePercent?.toFixed(2)}%
              </div>
              <div className="ai-meta">
                Range: {briefing.quote.low}–{briefing.quote.high} | Vol: {briefing.quote.volume?.toLocaleString()}
              </div>
            </div>

            <div className="ai-card ai-regime">
              <h3>🎯 Regime</h3>
              <div className={`ai-regime-badge regime-${briefing.regime.regime}`}>
                {briefing.regime.regime.toUpperCase().replace('_', ' ')}
              </div>
              <div className="ai-meta">
                Confidence: {Math.round(briefing.regime.confidence)}% | Composite: {briefing.regime.composite > 0 ? '+' : ''}{briefing.regime.composite}
              </div>
              <div className="ai-meta">
                Trend: {briefing.regime.trend?.direction} | ADX: {briefing.indicators?.adx} | Hurst: {briefing.indicators?.hurst}
              </div>
            </div>
          </div>

          {/* Row 2: Indicators */}
          <div className="ai-card ai-indicators">
            <h3>📊 Indicators</h3>
            <div className="ai-indicator-grid">
              {Object.entries(briefing.indicators || {}).filter(([k]) => k !== 'bb').map(([key, val]) => (
                <div key={key} className="ai-ind-item">
                  <span className="ai-ind-label">{key.toUpperCase()}</span>
                  <span className="ai-ind-value">{val}</span>
                </div>
              ))}
              {briefing.indicators?.bb && (
                <>
                  <div className="ai-ind-item"><span className="ai-ind-label">BB UPPER</span><span className="ai-ind-value">{briefing.indicators.bb.upper}</span></div>
                  <div className="ai-ind-item"><span className="ai-ind-label">BB LOWER</span><span className="ai-ind-value">{briefing.indicators.bb.lower}</span></div>
                  <div className="ai-ind-item"><span className="ai-ind-label">BB WIDTH</span><span className="ai-ind-value">{briefing.indicators.bb.width}</span></div>
                </>
              )}
            </div>
          </div>

          {/* Row 3: Signals */}
          {briefing.regime.signals?.length > 0 && (
            <div className="ai-card ai-signals">
              <h3>⚡ Active Signals</h3>
              <div className="ai-signal-list">
                {briefing.regime.signals.map((s, i) => (
                  <div key={i} className={`ai-signal-chip signal-${s.type.toLowerCase()}`}>
                    <span className="signal-type">{s.type}</span>
                    <span className="signal-reason">{s.reason}</span>
                    <span className="signal-strength">{s.strength}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Row 4: Top Strategies */}
          <div className="ai-card ai-strategies">
            <h3>🏆 Top Strategies (Quant-Ranked)</h3>
            <div className="ai-strategy-list">
              {briefing.rankings?.map((r, i) => (
                <div key={i} className="ai-strategy-row">
                  <span className="ai-rank">#{i + 1}</span>
                  <span className="ai-strat-name">{r.name || r.id}</span>
                  <span className="ai-strat-score">{r.finalScore}</span>
                  <span className={`ai-badge ${r.proven ? 'proven' : 'unproven'}`}>{r.proven ? '✓ Proven' : '? Unproven'}</span>
                  {r.backtest && (
                    <span className="ai-strat-stats">
                      WR: {r.backtest.winRate}% | PF: {r.backtest.profitFactor?.toFixed(2)} | Sharpe: {r.backtest.sharpe?.toFixed(2)}
                    </span>
                  )}
                  {r.backtest?.currentSignal && (() => {
                    const sig = r.backtest.currentSignal;
                    const sigType = typeof sig === 'string' ? sig : sig?.type;
                    if (!sigType || sigType === 'HOLD' || sigType === 'WAIT') return null;
                    return (
                      <span className={`ai-signal-mini signal-${sigType.toLowerCase()}`}>{sigType}</span>
                    );
                  })()}
                  {r.hardFilters?.length > 0 && (
                    <span className="ai-filters">⚠ {r.hardFilters.join(', ')}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Row 5: Live Feed */}
          <div className="ai-card ai-feed">
            <h3>
              📡 Live Feed
              <button className="ai-btn-small" onClick={refreshFeed} disabled={feedLoading}>
                {feedLoading ? '...' : '↻ Refresh'}
              </button>
              <span className="ai-cursor">cursor: {feedCursor}</span>
            </h3>
            {feed.length === 0 ? (
              <div className="ai-empty">No events yet. Click Refresh after triggering scanner or alerts.</div>
            ) : (
              <div className="ai-feed-list">
                {feed.slice(-20).reverse().map((e, i) => (
                  <div key={i} className={`ai-feed-item type-${e.type}`}>
                    <span className="feed-time">{new Date(e.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}</span>
                    <span className="feed-type">{e.type}</span>
                    <span className="feed-msg">{e.data?.symbol} {e.data?.msg || e.data?.signal || ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Row 6: Prompt + Copy */}
          <div className="ai-card ai-prompt">
            <h3>
              📋 Copilot Chat Prompt
              <button
                className="ai-btn-small"
                onClick={() => copyToClipboard(briefing.prompt, 'prompt')}
              >
                {copied === 'prompt' ? '✓ Copied!' : '📋 Copy'}
              </button>
            </h3>
            <div className="ai-prompt-templates">
              {PROMPT_TEMPLATES.map(t => (
                <button
                  key={t.id}
                  className="ai-template-chip"
                  onClick={() => copyToClipboard(briefing.prompt + t.suffix, t.id)}
                >
                  {t.label} {copied === t.id && '✓'}
                </button>
              ))}
            </div>
            <pre className="ai-prompt-text">{briefing.prompt}</pre>
          </div>

          {/* Row 7: MCP Tools cheat-sheet */}
          <div className="ai-card ai-mcp">
            <h3>🔧 MCP Tools for Follow-up</h3>
            <div className="ai-mcp-list">
              <div><code>tv_briefing_get</code> — Full quant snapshot (this view)</div>
              <div><code>tv_live_feed_get(since:{feedCursor})</code> — Poll for new events</div>
              <div><code>quote_get</code> — Real-time price</div>
              <div><code>data_get_study_values</code> — All indicator values</div>
              <div><code>data_get_ohlcv(summary:true)</code> — Price summary</div>
              <div><code>data_get_pine_lines</code> — Custom indicator levels</div>
              <div><code>capture_screenshot</code> — Visual chart state</div>
              <div><code>chart_set_symbol</code> — Switch ticker</div>
            </div>
          </div>
        </div>
      )}

      {!briefing && !loading && !error && (
        <div className="ai-empty-state">
          <div className="ai-empty-icon">🤖</div>
          <h2>AI Agent Briefing Center</h2>
          <p>Generate a full quant briefing for any symbol, then copy the prompt into Copilot Chat for AI-powered analysis.</p>
          <div className="ai-how-it-works">
            <h4>How it works:</h4>
            <ol>
              <li>Pick a symbol above (or use current chart)</li>
              <li>Click <strong>Generate Briefing</strong> — runs regime detection, indicator analysis, strategy ranking + backtests</li>
              <li>Copy the prompt into Copilot Chat — it includes all context + MCP tool hints</li>
              <li>Ask Copilot for trade plans, risk checks, Pine patches, or "check the live feed for new signals"</li>
            </ol>
            <h4>Copilot can also call directly:</h4>
            <ul>
              <li><code>tv_briefing_get</code> — generates this briefing via MCP (no UI needed)</li>
              <li><code>tv_live_feed_get</code> — polls for new alerts/scanner signals (cursor-based streaming)</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
