import './RecommendationsPanel.css';

export default function RecommendationsPanel({ recommendations, currentPrice, symbol }) {
  // Compute active recommendation from latest signals
  const latestBuy = recommendations.find(r => r.type === 'BUY');
  const hasActivePosition = recommendations.length > 0 && recommendations[0].type === 'BUY';

  // Parse target prices from the latest buy signal
  let buyPrice = null;
  let targetPrice = null;
  let stopLoss = null;

  if (latestBuy) {
    const tpMatch = latestBuy.msg.match(/TP=₹([\d.]+)/);
    const slMatch = latestBuy.msg.match(/SL=₹([\d.]+)/);
    const buyMatch = latestBuy.msg.match(/@ ₹([\d.]+)/);
    if (buyMatch) buyPrice = parseFloat(buyMatch[1]);
    if (tpMatch) targetPrice = parseFloat(tpMatch[1]);
    if (slMatch) stopLoss = parseFloat(slMatch[1]);
  }

  const riskReward = targetPrice && stopLoss && buyPrice
    ? ((targetPrice - buyPrice) / (buyPrice - stopLoss)).toFixed(2)
    : null;

  return (
    <div className="card recommendations-panel">
      <div className="card-header">
        <h2>💡 Buy/Sell Recommendations</h2>
      </div>

      {/* Active Signal */}
      {hasActivePosition && latestBuy ? (
        <div className="active-signal buy-signal">
          <div className="signal-header">
            <span className="signal-badge buy">BUY SIGNAL</span>
            <span className="signal-time">{latestBuy.time}</span>
          </div>
          <div className="signal-symbol">{latestBuy.symbol || symbol}</div>
          <div className="signal-prices">
            <div className="price-row">
              <span className="price-label">Entry Price</span>
              <span className="price-value entry">₹{buyPrice?.toLocaleString('en-IN') || '—'}</span>
            </div>
            <div className="price-row">
              <span className="price-label">Target (TP)</span>
              <span className="price-value target">₹{targetPrice?.toLocaleString('en-IN') || '—'}</span>
            </div>
            <div className="price-row">
              <span className="price-label">Stop Loss</span>
              <span className="price-value stoploss">₹{stopLoss?.toLocaleString('en-IN') || '—'}</span>
            </div>
            {currentPrice && buyPrice && (
              <div className="price-row">
                <span className="price-label">Current P&L</span>
                <span className={`price-value ${currentPrice >= buyPrice ? 'target' : 'stoploss'}`}>
                  {((currentPrice - buyPrice) / buyPrice * 100).toFixed(2)}%
                </span>
              </div>
            )}
            {riskReward && (
              <div className="price-row">
                <span className="price-label">Risk:Reward</span>
                <span className="price-value">1:{riskReward}</span>
              </div>
            )}
          </div>
          <div className="signal-strategy">
            Strategy: {latestBuy.strategy}
          </div>
        </div>
      ) : (
        <div className="no-signal">
          <div className="no-signal-icon">🎯</div>
          <p>No active buy signal</p>
          <p className="no-signal-sub">Strategies are scanning for entry opportunities...</p>
        </div>
      )}

      {/* Recent Recommendations */}
      {recommendations.length > 0 && (
        <div className="recent-recs">
          <h3 className="section-title">Recent Signals</h3>
          <div className="recs-list">
            {recommendations.slice(0, 8).map((rec, i) => (
              <div key={i} className={`rec-item ${rec.type.toLowerCase()}`}>
                <span className={`rec-badge ${rec.type.toLowerCase()}`}>{rec.type}</span>
                <span className="rec-symbol">{rec.symbol}</span>
                <span className="rec-msg">{rec.msg}</span>
                <span className="rec-time">{rec.time}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
