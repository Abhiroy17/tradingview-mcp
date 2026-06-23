import './SymbolBar.css';
import SymbolPicker from '../StrategySelector/SymbolPicker.jsx';

/**
 * SymbolBar — top-of-page input for symbol + timeframe + days-back.
 *
 * Props:
 *   symbol, setSymbol     — controlled single-symbol value
 *   timeframe, setTimeframe — TF string ("1D", "5", etc.)
 *   lookbackDays, setLookbackDays — number of days of history to fetch
 *   disabled              — disables inputs while a request is in flight
 */
export default function SymbolBar({
  symbol, setSymbol,
  timeframe, setTimeframe,
  lookbackDays, setLookbackDays,
  disabled = false,
}) {
  return (
    <div className="pl-symbol-bar">
      <div className="pl-bar-row">
        <div className="pl-bar-field pl-bar-field-symbol">
          <label className="pl-bar-label">Symbol</label>
          <SymbolPicker
            mode="single"
            value={symbol}
            onChange={setSymbol}
            placeholder="AAPL, NSE:RELIANCE, BTC-USD..."
            disabled={disabled}
          />
        </div>
        <div className="pl-bar-field">
          <label className="pl-bar-label">Timeframe</label>
          <select
            value={timeframe}
            onChange={e => setTimeframe(e.target.value)}
            disabled={disabled}
            className="pl-bar-select"
          >
            <option value="1">1 min</option>
            <option value="5">5 min</option>
            <option value="15">15 min</option>
            <option value="30">30 min</option>
            <option value="60">1 hour</option>
            <option value="240">4 hour</option>
            <option value="1D">Daily</option>
            <option value="1W">Weekly</option>
          </select>
        </div>
        <div className="pl-bar-field">
          <label className="pl-bar-label">History (days)</label>
          <select
            value={lookbackDays}
            onChange={e => setLookbackDays(Number(e.target.value))}
            disabled={disabled}
            className="pl-bar-select"
          >
            <option value={60}>60</option>
            <option value={180}>180</option>
            <option value={365}>365 (1y)</option>
            <option value={730}>730 (2y)</option>
            <option value={1825}>1825 (5y)</option>
          </select>
        </div>
      </div>
    </div>
  );
}
