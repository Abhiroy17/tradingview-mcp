import './StatusBar.css';

export default function StatusBar({ status, connected }) {
  const priceColor = status.change > 0 ? 'positive' : status.change < 0 ? 'negative' : '';

  return (
    <div className={`status-bar ${connected ? 'active' : ''}`}>
      <div className="status-item primary">
        <span className="status-label">Symbol</span>
        <span className="status-value symbol-value">{status.symbol || '—'}</span>
      </div>

      <div className={`status-item ${priceColor}`}>
        <span className="status-label">Last Price</span>
        <span className="status-value price-value">
          {status.price ? `₹${Number(status.price).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
        </span>
        {status.changePercent != null && (
          <span className={`status-change ${priceColor}`}>
            {status.changePercent > 0 ? '+' : ''}{status.changePercent}%
          </span>
        )}
      </div>

      <div className="status-item">
        <span className="status-label">RSI(2)</span>
        <span className={`status-value ${getRSIClass(status.rsi2)}`}>
          {status.rsi2 || '—'}
        </span>
      </div>

      <div className="status-item">
        <span className="status-label">Day High</span>
        <span className="status-value">
          {status.high ? `₹${Number(status.high).toLocaleString('en-IN')}` : '—'}
        </span>
      </div>

      <div className="status-item">
        <span className="status-label">Day Low</span>
        <span className="status-value">
          {status.low ? `₹${Number(status.low).toLocaleString('en-IN')}` : '—'}
        </span>
      </div>

      <div className="status-item">
        <span className="status-label">Position</span>
        <span className={`status-value position-badge ${status.positions?.length > 0 ? 'in-trade' : 'flat'}`}>
          {status.positions?.length > 0 ? status.positions.join(', ') : 'FLAT'}
        </span>
      </div>

      <div className="status-item">
        <span className="status-label">Updated</span>
        <span className="status-value time-value">{status.time || '—'}</span>
      </div>
    </div>
  );
}

function getRSIClass(rsi) {
  if (!rsi) return '';
  const val = parseFloat(rsi);
  if (val < 30) return 'rsi-oversold';
  if (val > 70) return 'rsi-overbought';
  return '';
}
