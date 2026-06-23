import { useState } from 'react';
import './TradeHistory.css';

export default function TradeHistory({ trades }) {
  const [sortBy, setSortBy] = useState('time'); // time, pnl

  // Calculate summary stats
  const completedTrades = trades.filter(t => t.type === 'TP' || t.type === 'SL' || t.type === 'SELL');
  const wins = completedTrades.filter(t => t.type === 'TP' || (t.msg && t.msg.includes('+'))).length;
  const losses = completedTrades.filter(t => t.type === 'SL').length;
  const winRate = completedTrades.length > 0 ? ((wins / completedTrades.length) * 100).toFixed(1) : '0';

  // Extract P&L values from messages
  const pnlValues = completedTrades.map(t => {
    const match = t.msg?.match(/P&L:\s*([+-]?[\d.]+)%/);
    return match ? parseFloat(match[1]) : 0;
  });
  const totalPnl = pnlValues.reduce((a, b) => a + b, 0);
  const avgPnl = pnlValues.length > 0 ? (totalPnl / pnlValues.length).toFixed(2) : '0';
  const maxWin = pnlValues.length > 0 ? Math.max(...pnlValues).toFixed(2) : '0';
  const maxLoss = pnlValues.length > 0 ? Math.min(...pnlValues).toFixed(2) : '0';

  return (
    <div className="trade-history-page">
      {/* Stats Cards */}
      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">Total Trades</span>
          <span className="stat-value">{completedTrades.length}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Win Rate</span>
          <span className="stat-value green">{winRate}%</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Total P&L</span>
          <span className={`stat-value ${totalPnl >= 0 ? 'green' : 'red'}`}>
            {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}%
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Avg Return</span>
          <span className={`stat-value ${parseFloat(avgPnl) >= 0 ? 'green' : 'red'}`}>
            {parseFloat(avgPnl) >= 0 ? '+' : ''}{avgPnl}%
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Best Trade</span>
          <span className="stat-value green">+{maxWin}%</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Worst Trade</span>
          <span className="stat-value red">{maxLoss}%</span>
        </div>
      </div>

      {/* Trade Log */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header">
          <h2>📋 Trade Log</h2>
          <div className="sort-controls">
            <button
              className={`sort-btn ${sortBy === 'time' ? 'active' : ''}`}
              onClick={() => setSortBy('time')}
            >
              Latest
            </button>
            <button
              className={`sort-btn ${sortBy === 'pnl' ? 'active' : ''}`}
              onClick={() => setSortBy('pnl')}
            >
              By P&L
            </button>
          </div>
        </div>

        <div className="trade-list">
          {trades.length === 0 ? (
            <div className="empty-trades">
              <div className="empty-icon">📊</div>
              <p>No completed trades yet</p>
              <p className="sub">Trades will appear here when strategies trigger exit signals</p>
            </div>
          ) : (
            trades.map((trade, i) => {
              const pnlMatch = trade.msg?.match(/P&L:\s*([+-]?[\d.]+)%/);
              const pnl = pnlMatch ? parseFloat(pnlMatch[1]) : null;

              return (
                <div key={i} className={`trade-item ${trade.type.toLowerCase()}`}>
                  <div className="trade-type">
                    <span className={`trade-badge ${trade.type.toLowerCase()}`}>
                      {trade.type === 'TP' ? '🎯 TP' : trade.type === 'SL' ? '🛑 SL' : '📤 EXIT'}
                    </span>
                  </div>
                  <div className="trade-details">
                    <span className="trade-symbol">{trade.symbol}</span>
                    <span className="trade-strategy">{trade.strategy}</span>
                  </div>
                  <div className="trade-message">{trade.msg}</div>
                  <div className="trade-pnl-col">
                    {pnl != null && (
                      <span className={`trade-pnl ${pnl >= 0 ? 'positive' : 'negative'}`}>
                        {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%
                      </span>
                    )}
                  </div>
                  <div className="trade-time">{trade.time}</div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
