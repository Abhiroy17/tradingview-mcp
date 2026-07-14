import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Header from './components/Header.jsx';
import StatusBar from './components/StatusBar.jsx';
import ControlPanel from './components/ControlPanel.jsx';
import QuickActions from './components/QuickActions.jsx';
import RecommendationsPanel from './components/RecommendationsPanel.jsx';
import AlertsPanel from './components/AlertsPanel.jsx';
import WatchlistPanel from './components/WatchlistPanel.jsx';
import TradeHistory from './components/TradeHistory.jsx';
import PriceAlerts from './components/PriceAlerts.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import PineLab from './components/PineLab/PineLab.jsx';
import StrategyMatrixView from './components/StrategyMatrix/StrategyMatrixView.jsx';
import AiAgentPanel from './components/AiAgentPanel.jsx';
import MultibaggerPanel from './components/MultibaggerPanel.jsx';
import EarningsReport from './components/EarningsReport.jsx';
import { useSSE } from './hooks/useSSE.js';
import { useApi } from './hooks/useApi.js';
import './App.css';

export default function App() {
  const [status, setStatus] = useState({
    monitoring: false,
    symbol: '',
    price: null,
    rsi2: null,
    positions: [],
    time: '',
    change: null,
    changePercent: null,
    high: null,
    low: null,
    volume: null
  });
  const [alerts, setAlerts] = useState([]);
  const [recommendations, setRecommendations] = useState([]);
  const [tradeHistory, setTradeHistory] = useState([]);
  const [connected, setConnected] = useState(false);

  const handleSSEMessage = useCallback((payload) => {
    if (payload.type === 'status') {
      setStatus(prev => ({ ...prev, ...payload.data, monitoring: true }));
      setConnected(true);
    }
    if (payload.type === 'alert') {
      const alert = { ...payload.data, id: Date.now() + Math.random() };
      setAlerts(prev => [alert, ...prev].slice(0, 200));

      // Add to recommendations
      if (alert.type === 'BUY' || alert.type === 'SELL' || alert.type === 'TP' || alert.type === 'SL') {
        setRecommendations(prev => [alert, ...prev].slice(0, 50));
      }

      // Track completed trades
      if (alert.type === 'SELL' || alert.type === 'TP' || alert.type === 'SL') {
        setTradeHistory(prev => [alert, ...prev].slice(0, 100));
      }

      // Play notification sound (if enabled)
      if (localStorage.getItem('soundEnabled') !== 'false') {
        playAlertSound(alert.type);
      }

      // Browser notification
      if (Notification.permission === 'granted') {
        new Notification(`Trading Alert: ${alert.type}`, {
          body: `${alert.symbol} — ${alert.msg}`,
          icon: alert.type === 'BUY' ? '🟢' : '🔴',
          tag: 'trade-alert'
        });
      }
    }
    if (payload.type === 'recommendation') {
      setRecommendations(prev => [payload.data, ...prev].slice(0, 50));
    }
    if (payload.type === 'watchlist_update') {
      // Handled within WatchlistPanel via its own state
    }
  }, []);

  const { sseConnected, reconnect } = useSSE(handleSSEMessage, status.monitoring);
  const api = useApi();

  // Load persisted data on mount
  useEffect(() => {
    fetch('/api/alerts').then(r => r.json()).then(data => {
      if (data.alerts?.length) setAlerts(data.alerts);
    }).catch(() => {});
    fetch('/api/trades').then(r => r.json()).then(data => {
      if (data.trades?.length) setTradeHistory(data.trades);
    }).catch(() => {});
  }, []);

  const handleStart = async (config) => {
    const result = await api.startMonitoring(config);
    if (result.success) {
      setStatus(prev => ({ ...prev, monitoring: true, symbol: config.symbol }));
      setConnected(true);
      reconnect();
    }
    return result;
  };

  const handleStop = async () => {
    await api.stopMonitoring();
    setStatus(prev => ({ ...prev, monitoring: false }));
    setConnected(false);
  };

  const clearAlerts = () => {
    setAlerts([]);
    api.clearAlerts();
  };

  return (
    <div className="app">
      <Header
        connected={connected && sseConnected}
        monitoring={status.monitoring}
      />

      <Routes>
        <Route path="/" element={
          <main className="main-content">
            <StatusBar status={status} connected={connected && sseConnected} />
            <div className="dashboard-grid">
              <div className="grid-left">
                <QuickActions monitoring={status.monitoring} />
                <ControlPanel
                  monitoring={status.monitoring}
                  onStart={handleStart}
                  onStop={handleStop}
                  api={api}
                />
                <RecommendationsPanel
                  recommendations={recommendations}
                  currentPrice={status.price}
                  symbol={status.symbol}
                />
              </div>
              <div className="grid-right">
                <AlertsPanel alerts={alerts} onClear={clearAlerts} />
              </div>
            </div>
          </main>
        } />
        <Route path="/watchlist" element={<main className="main-content"><WatchlistPanel api={api} /></main>} />
        <Route path="/multibagger" element={<main className="main-content"><MultibaggerPanel /></main>} />
        <Route path="/earnings" element={<main className="main-content"><EarningsReport /></main>} />
        <Route path="/matrix" element={<main className="main-content"><StrategyMatrixView /></main>} />
        <Route path="/alerts" element={<main className="main-content"><PriceAlerts api={api} currentPrice={status.price} symbol={status.symbol} /></main>} />
        <Route path="/history" element={<main className="main-content"><TradeHistory trades={tradeHistory} /></main>} />
        <Route path="/pine-lab" element={<main className="main-content"><PineLab /></main>} />
        <Route path="/ai-agent" element={<main className="main-content"><AiAgentPanel api={api} status={status} /></main>} />
        <Route path="/settings" element={<main className="main-content"><SettingsPanel api={api} /></main>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

function playAlertSound(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0.1;

    if (type === 'BUY') {
      osc.frequency.value = 800;
      osc.type = 'sine';
    } else if (type === 'TP') {
      osc.frequency.value = 1000;
      osc.type = 'sine';
    } else {
      osc.frequency.value = 400;
      osc.type = 'square';
    }

    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.stop(ctx.currentTime + 0.3);
  } catch (e) {
    // Audio not supported
  }
}
