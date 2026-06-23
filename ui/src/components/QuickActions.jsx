import { useState } from 'react';
import './QuickActions.css';

export default function QuickActions({ monitoring, onSymbolSwitch }) {
  const [actionStatus, setActionStatus] = useState({});
  const [switchSymbol, setSwitchSymbol] = useState('');

  const runAction = async (actionId, endpoint, method = 'POST', body = null) => {
    setActionStatus(prev => ({ ...prev, [actionId]: 'loading' }));
    try {
      const options = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) options.body = JSON.stringify(body);
      const res = await fetch(endpoint, options);
      const data = await res.json();
      if (data.success) {
        setActionStatus(prev => ({ ...prev, [actionId]: 'success' }));
        setTimeout(() => setActionStatus(prev => ({ ...prev, [actionId]: null })), 3000);
      } else {
        setActionStatus(prev => ({ ...prev, [actionId]: 'error' }));
        setTimeout(() => setActionStatus(prev => ({ ...prev, [actionId]: null })), 5000);
      }
      return data;
    } catch (e) {
      setActionStatus(prev => ({ ...prev, [actionId]: 'error' }));
      setTimeout(() => setActionStatus(prev => ({ ...prev, [actionId]: null })), 5000);
      return { success: false, error: e.message };
    }
  };

  const handleLaunchTV = () => runAction('launch', '/api/actions/launch-tv');
  const handleHealthCheck = () => runAction('health', '/api/actions/health-check', 'GET');
  const handleScreenshot = () => runAction('screenshot', '/api/actions/screenshot');
  const handleFullscreen = () => runAction('fullscreen', '/api/actions/fullscreen');
  const handleOpenPineEditor = () => runAction('pine', '/api/actions/open-panel', 'POST', { panel: 'pine-editor' });
  const handleOpenStrategyTester = () => runAction('strategy', '/api/actions/open-panel', 'POST', { panel: 'strategy-tester' });
  const handleOpenAlerts = () => runAction('tv-alerts', '/api/actions/open-panel', 'POST', { panel: 'alerts' });
  const handleOpenWatchlist = () => runAction('tv-watchlist', '/api/actions/open-panel', 'POST', { panel: 'watchlist' });

  const handleSwitchSymbol = () => {
    if (!switchSymbol.trim()) return;
    runAction('switch', '/api/actions/switch-symbol', 'POST', { symbol: switchSymbol.trim().toUpperCase() });
    if (onSymbolSwitch) onSymbolSwitch(switchSymbol.trim().toUpperCase());
  };

  const handleSetTimeframe = (tf) => {
    runAction('timeframe', '/api/actions/set-timeframe', 'POST', { timeframe: tf });
  };

  const getButtonClass = (id) => {
    if (actionStatus[id] === 'loading') return 'action-btn loading';
    if (actionStatus[id] === 'success') return 'action-btn success';
    if (actionStatus[id] === 'error') return 'action-btn error';
    return 'action-btn';
  };

  const getButtonIcon = (id, defaultIcon) => {
    if (actionStatus[id] === 'loading') return '⏳';
    if (actionStatus[id] === 'success') return '✓';
    if (actionStatus[id] === 'error') return '✗';
    return defaultIcon;
  };

  return (
    <div className="card quick-actions">
      <div className="card-header">
        <h2>⚡ Quick Actions</h2>
      </div>

      {/* Launch & Connection */}
      <div className="action-section">
        <span className="action-section-label">TradingView Control</span>
        <div className="action-grid">
          <button className={getButtonClass('launch')} onClick={handleLaunchTV} title="Launch TradingView with CDP debugging enabled">
            <span className="action-icon">{getButtonIcon('launch', '🚀')}</span>
            <span className="action-label">Launch TV</span>
            <span className="action-sub">with CDP:9222</span>
          </button>

          <button className={getButtonClass('health')} onClick={handleHealthCheck} title="Check connection to TradingView">
            <span className="action-icon">{getButtonIcon('health', '💚')}</span>
            <span className="action-label">Health Check</span>
            <span className="action-sub">test connection</span>
          </button>

          <button className={getButtonClass('screenshot')} onClick={handleScreenshot} title="Capture current chart screenshot">
            <span className="action-icon">{getButtonIcon('screenshot', '📸')}</span>
            <span className="action-label">Screenshot</span>
            <span className="action-sub">capture chart</span>
          </button>

          <button className={getButtonClass('fullscreen')} onClick={handleFullscreen} title="Toggle chart fullscreen">
            <span className="action-icon">{getButtonIcon('fullscreen', '🖥')}</span>
            <span className="action-label">Fullscreen</span>
            <span className="action-sub">toggle view</span>
          </button>
        </div>
      </div>

      {/* Symbol Switch */}
      <div className="action-section">
        <span className="action-section-label">Quick Symbol Switch</span>
        <div className="symbol-switch-row">
          <input
            type="text"
            value={switchSymbol}
            onChange={e => setSwitchSymbol(e.target.value.toUpperCase())}
            placeholder="AMEX:SOXS, NASDAQ:AAPL, NSE:RELIANCE..."
            className="text-input"
            onKeyDown={e => e.key === 'Enter' && handleSwitchSymbol()}
          />
          <button className={getButtonClass('switch')} onClick={handleSwitchSymbol}>
            {getButtonIcon('switch', '→')} Go
          </button>
        </div>
        <div className="quick-symbols-section">
          <span className="quick-sym-label">India</span>
          <div className="quick-symbols">
            {['NSE:NIFTY', 'NSE:BANKNIFTY', 'NSE:RELIANCE', 'NSE:TCS', 'NSE:INFY', 'NSE:HDFCBANK', 'NSE:TATASTEEL', 'NSE:SBIN'].map(sym => (
              <button
                key={sym}
                className="quick-sym-btn"
                onClick={() => {
                  setSwitchSymbol(sym);
                  runAction('switch', '/api/actions/switch-symbol', 'POST', { symbol: sym });
                }}
              >
                {sym.split(':')[1]}
              </button>
            ))}
          </div>
          <span className="quick-sym-label">US / Global</span>
          <div className="quick-symbols">
            {['NASDAQ:AAPL', 'NASDAQ:TSLA', 'NASDAQ:NVDA', 'NASDAQ:QQQ', 'AMEX:SPY', 'AMEX:SOXS', 'AMEX:SOXL', 'BINANCE:BTCUSDT'].map(sym => (
              <button
                key={sym}
                className="quick-sym-btn global"
                onClick={() => {
                  setSwitchSymbol(sym);
                  runAction('switch', '/api/actions/switch-symbol', 'POST', { symbol: sym });
                }}
              >
                {sym.split(':')[1]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Timeframe */}
      <div className="action-section">
        <span className="action-section-label">Timeframe</span>
        <div className="timeframe-grid">
          {[
            { label: '1m', value: '1' },
            { label: '3m', value: '3' },
            { label: '5m', value: '5' },
            { label: '15m', value: '15' },
            { label: '30m', value: '30' },
            { label: '1H', value: '60' },
            { label: '4H', value: '240' },
            { label: 'D', value: 'D' },
            { label: 'W', value: 'W' },
          ].map(tf => (
            <button
              key={tf.value}
              className="tf-btn"
              onClick={() => handleSetTimeframe(tf.value)}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>

      {/* Panel Controls */}
      <div className="action-section">
        <span className="action-section-label">TV Panels</span>
        <div className="action-grid compact">
          <button className={getButtonClass('pine')} onClick={handleOpenPineEditor}>
            <span className="action-icon">{getButtonIcon('pine', '🌲')}</span>
            <span className="action-label">Pine Editor</span>
          </button>
          <button className={getButtonClass('strategy')} onClick={handleOpenStrategyTester}>
            <span className="action-icon">{getButtonIcon('strategy', '📊')}</span>
            <span className="action-label">Strategy Tester</span>
          </button>
          <button className={getButtonClass('tv-alerts')} onClick={handleOpenAlerts}>
            <span className="action-icon">{getButtonIcon('tv-alerts', '🔔')}</span>
            <span className="action-label">TV Alerts</span>
          </button>
          <button className={getButtonClass('tv-watchlist')} onClick={handleOpenWatchlist}>
            <span className="action-icon">{getButtonIcon('tv-watchlist', '📋')}</span>
            <span className="action-label">TV Watchlist</span>
          </button>
        </div>
      </div>
    </div>
  );
}
