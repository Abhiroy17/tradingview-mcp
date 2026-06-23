import { useState, useEffect } from 'react';
import './PriceAlerts.css';

export default function PriceAlerts({ api, currentPrice, symbol }) {
  const [priceAlerts, setPriceAlerts] = useState([]);
  const [newAlert, setNewAlert] = useState({ price: '', condition: 'above', note: '' });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadAlerts();
  }, []);

  // Check price alerts when currentPrice changes
  useEffect(() => {
    if (!currentPrice) return;
    const triggered = [];
    setPriceAlerts(prev => prev.map(alert => {
      if (alert.triggered) return alert;
      const shouldTrigger =
        (alert.condition === 'above' && currentPrice >= alert.price) ||
        (alert.condition === 'below' && currentPrice <= alert.price) ||
        (alert.condition === 'cross' && Math.abs(currentPrice - alert.price) < alert.price * 0.001);

      if (shouldTrigger) {
        triggered.push(alert);
        return { ...alert, triggered: true, triggeredAt: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) };
      }
      return alert;
    }));

    // Play sound for triggered alerts
    if (triggered.length > 0) {
      playTriggerSound();
      triggered.forEach(a => {
        if (Notification.permission === 'granted') {
          new Notification('Price Alert Triggered!', {
            body: `${a.symbol || symbol} ${a.condition} ₹${a.price} — ${a.note || 'Target reached'}`,
            tag: 'price-alert-' + a.id
          });
        }
      });
    }
  }, [currentPrice, symbol]);

  const loadAlerts = async () => {
    const data = await api.getPriceAlerts();
    if (data.alerts) setPriceAlerts(data.alerts);
  };

  const createAlert = async () => {
    if (!newAlert.price) return;
    setLoading(true);

    const alert = {
      id: Date.now(),
      symbol: symbol || 'ANY',
      price: parseFloat(newAlert.price),
      condition: newAlert.condition,
      note: newAlert.note,
      triggered: false,
      createdAt: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
    };

    const result = await api.createPriceAlert(alert);
    if (result.success) {
      setPriceAlerts(prev => [alert, ...prev]);
      setNewAlert({ price: '', condition: 'above', note: '' });
    } else {
      // Store locally if API not available
      setPriceAlerts(prev => [alert, ...prev]);
      setNewAlert({ price: '', condition: 'above', note: '' });
    }
    setLoading(false);
  };

  const deleteAlert = async (id) => {
    await api.deletePriceAlert(id);
    setPriceAlerts(prev => prev.filter(a => a.id !== id));
  };

  const activeAlerts = priceAlerts.filter(a => !a.triggered);
  const triggeredAlerts = priceAlerts.filter(a => a.triggered);

  return (
    <div className="price-alerts-page">
      <div className="card">
        <div className="card-header">
          <h2>🔔 Custom Price Alerts</h2>
          <span className="alert-info">{activeAlerts.length} active</span>
        </div>

        {/* Create new alert */}
        <div className="create-alert-form">
          <div className="form-row">
            <div className="form-group">
              <label>Price Level (₹)</label>
              <input
                type="number"
                value={newAlert.price}
                onChange={e => setNewAlert(prev => ({ ...prev, price: e.target.value }))}
                placeholder={currentPrice ? currentPrice.toString() : '0.00'}
                className="text-input"
                step="0.05"
              />
            </div>
            <div className="form-group">
              <label>Condition</label>
              <select
                value={newAlert.condition}
                onChange={e => setNewAlert(prev => ({ ...prev, condition: e.target.value }))}
                className="select-input full"
              >
                <option value="above">Price goes ABOVE</option>
                <option value="below">Price goes BELOW</option>
                <option value="cross">Price CROSSES level</option>
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group full">
              <label>Note (optional)</label>
              <input
                type="text"
                value={newAlert.note}
                onChange={e => setNewAlert(prev => ({ ...prev, note: e.target.value }))}
                placeholder="e.g., Resistance level, Support zone, Take profit..."
                className="text-input"
              />
            </div>
          </div>
          <button className="btn btn-create" onClick={createAlert} disabled={loading || !newAlert.price}>
            {loading ? 'Creating...' : '+ Create Alert'}
          </button>
        </div>

        {/* Current price reference */}
        {currentPrice && (
          <div className="current-price-ref">
            <span>Current: </span>
            <strong>₹{Number(currentPrice).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong>
            <span className="price-symbol">{symbol}</span>
          </div>
        )}
      </div>

      {/* Active alerts */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header">
          <h2>⏳ Active Alerts</h2>
        </div>
        <div className="alerts-grid">
          {activeAlerts.length === 0 ? (
            <div className="empty-state-small">No active price alerts</div>
          ) : (
            activeAlerts.map(alert => (
              <div key={alert.id} className={`price-alert-item ${alert.condition}`}>
                <div className="pa-icon">
                  {alert.condition === 'above' ? '📈' : alert.condition === 'below' ? '📉' : '↔️'}
                </div>
                <div className="pa-info">
                  <div className="pa-price">₹{Number(alert.price).toLocaleString('en-IN')}</div>
                  <div className="pa-condition">
                    {alert.condition === 'above' ? 'Above' : alert.condition === 'below' ? 'Below' : 'Cross'}
                    {alert.note && ` — ${alert.note}`}
                  </div>
                  <div className="pa-meta">{alert.symbol} • Set at {alert.createdAt}</div>
                </div>
                {currentPrice && (
                  <div className="pa-distance">
                    {((alert.price - currentPrice) / currentPrice * 100).toFixed(2)}%
                  </div>
                )}
                <button className="pa-delete" onClick={() => deleteAlert(alert.id)}>✕</button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Triggered alerts */}
      {triggeredAlerts.length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="card-header">
            <h2>✅ Triggered Alerts</h2>
          </div>
          <div className="alerts-grid">
            {triggeredAlerts.map(alert => (
              <div key={alert.id} className="price-alert-item triggered">
                <div className="pa-icon">✅</div>
                <div className="pa-info">
                  <div className="pa-price">₹{Number(alert.price).toLocaleString('en-IN')}</div>
                  <div className="pa-condition">
                    Triggered at {alert.triggeredAt}
                    {alert.note && ` — ${alert.note}`}
                  </div>
                </div>
                <button className="pa-delete" onClick={() => deleteAlert(alert.id)}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function playTriggerSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.value = 0.15;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) {}
}
