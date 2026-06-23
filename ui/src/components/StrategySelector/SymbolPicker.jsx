import { useState, useRef, useEffect, useCallback } from 'react';
import { useV2Api } from '../../hooks/useV2Api.js';
import './SymbolPicker.css';

/**
 * SymbolPicker — replaces SymbolSearch for v2 flows.
 *
 * Modes:
 *   - 'single': single-symbol input + autocomplete
 *   - 'multi':  N-symbol chip input + autocomplete
 *
 * Props:
 *   mode: 'single' | 'multi' (default: 'single')
 *   value: string | string[]
 *   onChange: (value) => void
 *   placeholder: string
 *   disabled: boolean
 *   max: number  (multi mode only; default: 50)
 */
export default function SymbolPicker({
  mode = 'single',
  value,
  onChange,
  placeholder = 'Symbol (AAPL, NSE:RELIANCE, BTC-USD)',
  disabled = false,
  max = 50,
}) {
  const api = useV2Api();
  const [query, setQuery] = useState(mode === 'single' ? (value || '') : '');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const debounceRef = useRef(null);
  const wrapperRef = useRef(null);

  const selected = mode === 'multi' ? (Array.isArray(value) ? value : []) : [];

  // Sync single-mode input with external value
  useEffect(() => {
    if (mode === 'single') setQuery(value || '');
  }, [mode, value]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const search = useCallback(async (text) => {
    if (!text || text.length < 1) { setResults([]); setOpen(false); return; }
    const data = await api.searchSymbols(text, 10);
    if (data.success && Array.isArray(data.matches)) {
      setResults(data.matches);
      setOpen(data.matches.length > 0);
      setActiveIdx(-1);
    }
  }, [api]);

  const handleInput = (e) => {
    const val = e.target.value.toUpperCase();
    setQuery(val);
    if (mode === 'single') onChange?.(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 250);
  };

  const handleSelect = (item) => {
    const sym = item.symbol || item.full_name || item;
    if (mode === 'single') {
      setQuery(sym);
      onChange?.(sym);
    } else {
      if (selected.includes(sym)) {
        // dedupe
      } else if (selected.length < max) {
        onChange?.([...selected, sym]);
      }
      setQuery('');
    }
    setOpen(false);
    setResults([]);
  };

  const handleRemove = (sym) => {
    onChange?.(selected.filter(s => s !== sym));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown' && open) {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && results.length > 0) {
        handleSelect(results[Math.max(0, activeIdx)]);
      } else if (query.trim()) {
        handleSelect(query.trim().toUpperCase());
      }
    } else if (e.key === 'Backspace' && mode === 'multi' && !query && selected.length > 0) {
      handleRemove(selected[selected.length - 1]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className={`symbol-picker symbol-picker-${mode}`} ref={wrapperRef}>
      <div className={`sp-input-row ${disabled ? 'sp-disabled' : ''}`}>
        {mode === 'multi' && selected.map(sym => (
          <span key={sym} className="sp-chip">
            {sym}
            <button
              type="button"
              className="sp-chip-x"
              onClick={() => handleRemove(sym)}
              aria-label={`Remove ${sym}`}
            >×</button>
          </span>
        ))}
        <input
          type="text"
          className="sp-input"
          value={query}
          onChange={handleInput}
          onFocus={() => results.length > 0 && setOpen(true)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={mode === 'multi' && selected.length > 0 ? 'Add symbol...' : placeholder}
          autoComplete="off"
        />
        {mode === 'multi' && selected.length > 0 && (
          <span className="sp-count">{selected.length}/{max}</span>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="sp-dropdown">
          {results.map((item, idx) => (
            <div
              key={`${item.symbol}-${idx}`}
              className={`sp-result ${idx === activeIdx ? 'sp-active' : ''} ${selected.includes(item.symbol) ? 'sp-already' : ''}`}
              onMouseDown={() => handleSelect(item)}
              onMouseEnter={() => setActiveIdx(idx)}
            >
              <span className="sp-result-icon">{providerIcon(item.provider)}</span>
              <div className="sp-result-body">
                <span className="sp-result-symbol">{item.symbol}</span>
                {item.description && <span className="sp-result-desc">{item.description}</span>}
              </div>
              {item.exchange && <span className="sp-result-exchange">{item.exchange}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function providerIcon(p) {
  if (p === 'upstox') return '🇮🇳';
  if (p === 'yahoo') return '🌐';
  return '•';
}
