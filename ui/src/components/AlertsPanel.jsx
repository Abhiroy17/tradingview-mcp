import { useState } from 'react';
import './AlertsPanel.css';

export default function AlertsPanel({ alerts, onClear }) {
  const [filter, setFilter] = useState('all');

  const filteredAlerts = filter === 'all'
    ? alerts
    : alerts.filter(a => a.type.toLowerCase() === filter);

  const buyCount = alerts.filter(a => a.type === 'BUY').length;
  const sellCount = alerts.filter(a => a.type === 'SELL' || a.type === 'TP' || a.type === 'SL').length;

  return (
    <div className="card alerts-panel">
      <div className="card-header">
        <h2>🔔 Live Alerts</h2>
        <div className="alerts-meta">
          <span className="alert-total">{alerts.length}</span>
          {alerts.length > 0 && (
            <button className="clear-btn" onClick={onClear}>Clear</button>
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="alert-filters">
        <button
          className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All ({alerts.length})
        </button>
        <button
          className={`filter-btn buy ${filter === 'buy' ? 'active' : ''}`}
          onClick={() => setFilter('buy')}
        >
          Buy ({buyCount})
        </button>
        <button
          className={`filter-btn sell ${filter === 'sell' ? 'active' : ''}`}
          onClick={() => setFilter('sell')}
        >
          Sell ({sellCount})
        </button>
      </div>

      {/* Alerts list */}
      <div className="alerts-list">
        {filteredAlerts.length === 0 ? (
          <div className="empty-alerts">
            <div className="empty-icon">📡</div>
            <p>No alerts yet</p>
            <p className="empty-sub">Start monitoring to receive live trading signals</p>
          </div>
        ) : (
          filteredAlerts.map((alert, i) => (
            <AlertItem key={alert.id || i} alert={alert} />
          ))
        )}
      </div>
    </div>
  );
}

function AlertItem({ alert }) {
  const typeClass = alert.type.toLowerCase();

  return (
    <div className={`alert-item ${typeClass}`}>
      <div className="alert-left">
        <span className={`alert-type-badge ${typeClass}`}>{alert.type}</span>
        <span className="alert-symbol-name">{alert.symbol}</span>
      </div>
      <div className="alert-content">
        <span className="alert-message">{alert.msg}</span>
      </div>
      <div className="alert-right">
        <span className="alert-timestamp">{alert.time}</span>
      </div>
    </div>
  );
}
