import { useState, useEffect, useMemo, useRef } from 'react';
import { useV2Api } from '../../hooks/useV2Api.js';
import './StrategySelector.css';

/**
 * StrategySelector — reusable across PineLab, ControlPanel, Watchlist.
 *
 * Props:
 *   mode: 'single' | 'multi' | 'all'         (default: 'single')
 *     - single = pick exactly one strategy (radio)
 *     - multi  = pick N strategies (checkboxes)
 *     - all    = no UI; expose all backtestable strategies
 *   value: string | string[]                  (controlled: code or array of codes)
 *   onChange: (value, strategies) => void
 *   filter: { family?, style?, source?, backtestableOnly?, timeframe?, regimeAffinity? }
 *   showMeta: boolean (default: true)          show family/style/regime tags
 *   showSearch: boolean (default: true)        show text filter
 *   className: string
 *
 * Notes:
 *   - Loads strategies via /api/v2/strategies (cached for the component lifetime).
 *   - `filter.timeframe` filters to strategies that support a given TF ("1D", "5", etc.).
 *   - `filter.regimeAffinity` filters to strategies that affinity-match a regime label.
 */
export default function StrategySelector({
  mode = 'single',
  value,
  onChange,
  filter = {},
  showMeta = true,
  showSearch = true,
  disabled = false,
  className = '',
}) {
  const api = useV2Api();
  const [strategies, setStrategies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [familyFilter, setFamilyFilter] = useState(filter.family || 'all');

  // Load strategy list once per filter change.
  // IMPORTANT: depend on the stable callback (api.listStrategies is useCallback'd) and
  // PRIMITIVE filter fields only — never the `filter` object itself or the `api` object,
  // because parents often pass fresh literals each render → infinite fetch loop.
  const listStrategies = api.listStrategies;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listStrategies({
      family: filter.family,
      style: filter.style,
      source: filter.source,
      backtestableOnly: filter.backtestableOnly,
    }).then(res => {
      if (cancelled) return;
      if (res?.success) setStrategies(res.strategies || []);
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [listStrategies, filter.family, filter.style, filter.source, filter.backtestableOnly]);

  // Client-side filtering (search + timeframe + regimeAffinity + familyFilter)
  const visibleStrategies = useMemo(() => {
    return strategies.filter(s => {
      if (familyFilter !== 'all' && s.family !== familyFilter) return false;
      if (filter.timeframe && !s.timeframes?.includes(filter.timeframe)) return false;
      if (filter.regimeAffinity && !(Array.isArray(s.regimeAffinity)
        ? s.regimeAffinity.includes(filter.regimeAffinity)
        : s.regimeAffinity && (filter.regimeAffinity in s.regimeAffinity || (Array.isArray(s.regimeAffinity?.trend) && s.regimeAffinity.trend.includes(filter.regimeAffinity))))) return false;
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        if (!s.code.toLowerCase().includes(q) &&
            !s.name.toLowerCase().includes(q) &&
            !(s.description || '').toLowerCase().includes(q) &&
            !(s.tags || []).some(t => t.toLowerCase().includes(q))) return false;
      }
      return true;
    });
  }, [strategies, searchTerm, familyFilter, filter.timeframe, filter.regimeAffinity]);

  // List of unique families across loaded strategies (for the family dropdown)
  const availableFamilies = useMemo(() => {
    const set = new Set(strategies.map(s => s.family));
    return ['all', ...Array.from(set).sort()];
  }, [strategies]);

  // Compute current selection set
  const selectedSet = useMemo(() => {
    if (mode === 'all') return new Set(visibleStrategies.map(s => s.code));
    if (mode === 'multi') return new Set(Array.isArray(value) ? value : []);
    if (typeof value === 'string' && value) return new Set([value]);
    return new Set();
  }, [mode, value, visibleStrategies]);

  // Notify parent when 'all' mode strategies list changes.
  // Guard with prevCodesRef so unrelated onChange identity changes (parent inline fn) do not
  // re-fire this effect into an infinite loop.
  const prevCodesKeyRef = useRef('');
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    if (mode !== 'all') return;
    const codes = visibleStrategies.map(s => s.code);
    const key = codes.join('|');
    if (key === prevCodesKeyRef.current) return;
    prevCodesKeyRef.current = key;
    onChangeRef.current?.(codes, visibleStrategies);
  }, [mode, visibleStrategies]);

  const handleToggle = (code) => {
    if (disabled) return;
    const strat = strategies.find(s => s.code === code);
    if (mode === 'single') {
      onChange?.(code, strat ? [strat] : []);
    } else if (mode === 'multi') {
      const next = new Set(selectedSet);
      if (next.has(code)) next.delete(code); else next.add(code);
      const arr = Array.from(next);
      const selStrats = arr.map(c => strategies.find(s => s.code === c)).filter(Boolean);
      onChange?.(arr, selStrats);
    }
  };

  const handleSelectAll = () => {
    if (disabled) return;
    const arr = visibleStrategies.map(s => s.code);
    onChange?.(arr, visibleStrategies);
  };

  const handleClear = () => {
    if (disabled) return;
    onChange?.(mode === 'multi' ? [] : '', []);
  };

  // ── Render ──
  if (mode === 'all') {
    // Compact summary view
    return (
      <div className={`strategy-selector strategy-selector-all ${className}`}>
        <div className="ss-all-summary">
          <span className="ss-all-count">{visibleStrategies.length}</span>
          <span className="ss-all-label">strategies will be evaluated</span>
        </div>
        {showSearch && (
          <input
            type="text"
            className="ss-search-input"
            placeholder="Filter (e.g. ibs, rsi, trend)"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        )}
        {showMeta && (
          <div className="ss-tags-row">
            {Array.from(new Set(visibleStrategies.map(s => s.family))).map(f => (
              <span key={f} className={`ss-tag ss-tag-${f}`}>{familyLabel(f)}</span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`strategy-selector ${disabled ? 'strategy-selector-disabled' : ''} ${className}`}>
      {(showSearch || availableFamilies.length > 2) && (
        <div className="ss-toolbar">
          {showSearch && (
            <input
              type="text"
              className="ss-search-input"
              placeholder="Filter strategies..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          )}
          {availableFamilies.length > 2 && (
            <select
              className="ss-family-select"
              value={familyFilter}
              onChange={e => setFamilyFilter(e.target.value)}
            >
              {availableFamilies.map(f => (
                <option key={f} value={f}>{f === 'all' ? 'All families' : familyLabel(f)}</option>
              ))}
            </select>
          )}
          {mode === 'multi' && (
            <div className="ss-multi-actions">
              <button type="button" className="ss-btn-mini" onClick={handleSelectAll}>All visible</button>
              <button type="button" className="ss-btn-mini" onClick={handleClear}>Clear</button>
            </div>
          )}
        </div>
      )}

      {loading && <div className="ss-loading">Loading strategies…</div>}
      {!loading && visibleStrategies.length === 0 && (
        <div className="ss-empty">No strategies match the current filter.</div>
      )}

      <div className="ss-list">
        {visibleStrategies.map(s => {
          const selected = selectedSet.has(s.code);
          return (
            <label
              key={s.code}
              className={`ss-item ${selected ? 'ss-item-selected' : ''}`}
            >
              <input
                type={mode === 'single' ? 'radio' : 'checkbox'}
                name="strategy-selector"
                checked={selected}
                onChange={() => handleToggle(s.code)}
                disabled={disabled}
                className="ss-input"
              />
              <div className="ss-item-body">
                <div className="ss-item-head">
                  <span className="ss-item-name">{s.name}</span>
                  <span className="ss-item-code">{s.code}</span>
                </div>
                {showMeta && (
                  <>
                    {s.description && <div className="ss-item-desc">{s.description}</div>}
                    <div className="ss-item-tags">
                      <span className={`ss-tag ss-tag-${s.family}`}>{familyLabel(s.family)}</span>
                      {s.style && <span className="ss-tag ss-tag-style">{s.style}</span>}
                      {(s.timeframes || []).slice(0, 4).map(tf => (
                        <span key={tf} className="ss-tag ss-tag-tf">{tfLabel(tf)}</span>
                      ))}
                      {(() => {
                        const aff = s.regimeAffinity;
                        const labels = Array.isArray(aff) ? aff
                          : aff && typeof aff === 'object' && Array.isArray(aff.trend) ? aff.trend
                          : aff && typeof aff === 'object' ? Object.keys(aff)
                          : [];
                        return labels.slice(0, 4).map(r => (
                          <span key={r} className={`ss-tag ss-tag-regime ss-regime-${r}`}>{r}</span>
                        ));
                      })()}
                    </div>
                  </>
                )}
              </div>
            </label>
          );
        })}
      </div>

      {mode === 'multi' && (
        <div className="ss-footer">
          <span className="ss-footer-count">{selectedSet.size} selected</span>
        </div>
      )}
    </div>
  );
}

function familyLabel(f) {
  switch (f) {
    case 'mean_reversion': return 'Mean Reversion';
    case 'trend_following': return 'Trend Following';
    case 'momentum': return 'Momentum';
    case 'gap': return 'Gap';
    case 'calendar': return 'Calendar';
    default: return f || '—';
  }
}

function tfLabel(tf) {
  if (tf === '1D') return 'Daily';
  if (tf === '1W') return 'Weekly';
  if (/^\d+$/.test(tf)) return `${tf}m`;
  return tf;
}
