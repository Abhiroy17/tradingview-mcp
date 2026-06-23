import { useState, useEffect } from 'react';
import { useV2Api } from '../../hooks/useV2Api.js';
import './PineCodeCard.css';

/**
 * PineCodeCard — view + deploy Pine source for a selected strategy.
 *
 * Loads source from GET /api/v2/strategies/:code/pine.
 * Deploys via legacy POST /api/pine/deploy (which auto-fixes capital, etc.).
 *
 * Props:
 *   strategyCode: string (strategy code from registry, e.g. 'ibs_india_tuned_v2')
 *   strategyName: string (display name)
 */
export default function PineCodeCard({ strategyCode, strategyName }) {
  const api = useV2Api();
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(false);
  const [deployStatus, setDeployStatus] = useState(null);
  const [showCode, setShowCode] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!strategyCode) { setSource(''); setError(null); return; }
    setLoading(true);
    setError(null);
    setDeployStatus(null);
    api.getStrategyPine(strategyCode).then(res => {
      if (res.success) {
        setSource(res.source || '');
      } else {
        setSource('');
        setError(res.error || 'Failed to load Pine source');
      }
      setLoading(false);
    });
  }, [strategyCode, api]);

  const deploy = async () => {
    if (!source) return;
    setLoading(true);
    setDeployStatus({ kind: 'pending', msg: 'Deploying to TradingView…' });
    try {
      const res = await fetch('/api/pine/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: source }),
      });
      const data = await res.json();
      if (data.success) {
        setDeployStatus({
          kind: 'success',
          msg: data.message || 'Deployed',
          steps: data.steps || [],
        });
      } else {
        setDeployStatus({
          kind: 'error',
          msg: data.error || 'Deploy failed',
          steps: data.steps || [],
        });
      }
    } catch (e) {
      setDeployStatus({ kind: 'error', msg: 'Network error: ' + e.message });
    }
    setLoading(false);
  };

  const copy = () => {
    if (!source) return;
    navigator.clipboard.writeText(source).then(() => {
      setDeployStatus({ kind: 'success', msg: 'Copied to clipboard' });
      setTimeout(() => setDeployStatus(null), 2000);
    });
  };

  if (!strategyCode) {
    return (
      <div className="pl-code-card pl-code-empty">
        <span className="pl-code-empty-icon">📜</span>
        <span>Select a strategy to view its Pine Script</span>
      </div>
    );
  }

  return (
    <div className="pl-code-card">
      <div className="pl-code-head">
        <div className="pl-code-head-left">
          <h3>Pine Script</h3>
          <span className="pl-code-strategy">{strategyName || strategyCode}</span>
        </div>
        <div className="pl-code-actions">
          <button
            type="button"
            className="pl-code-btn pl-code-btn-secondary"
            onClick={() => setShowCode(s => !s)}
            disabled={!source}
          >
            {showCode ? 'Hide code' : 'View code'}
          </button>
          <button
            type="button"
            className="pl-code-btn pl-code-btn-secondary"
            onClick={copy}
            disabled={!source}
          >
            Copy
          </button>
          <button
            type="button"
            className="pl-code-btn pl-code-btn-primary"
            onClick={deploy}
            disabled={!source || loading}
          >
            {loading ? 'Working…' : 'Deploy to TradingView'}
          </button>
        </div>
      </div>

      {loading && !source && <div className="pl-code-loading">Loading Pine source…</div>}

      {error && (
        <div className="pl-code-error">
          <strong>Cannot load Pine source for this strategy</strong>
          <div className="pl-code-error-detail">{error}</div>
          <div className="pl-code-error-hint">
            Some strategies have a JS engine for backtesting but no .pine file on disk. You can still see signals & metrics above.
          </div>
        </div>
      )}

      {deployStatus && (
        <div className={`pl-code-status pl-code-status-${deployStatus.kind}`}>
          <div className="pl-code-status-msg">{deployStatus.msg}</div>
          {deployStatus.steps && deployStatus.steps.length > 0 && (
            <ul className="pl-code-status-steps">
              {deployStatus.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          )}
        </div>
      )}

      {showCode && source && (
        <pre className="pl-code-block"><code>{source}</code></pre>
      )}
    </div>
  );
}
