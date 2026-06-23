import { useState, useRef, useEffect } from 'react';
import './SymbolSearch.css';

export default function SymbolSearch({ value, onChange, onSelect, api, disabled, placeholder }) {
  const [query, setQuery] = useState(value || '');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const debounceRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => { setQuery(value || ''); }, [value]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const search = async (text) => {
    if (!text || text.length < 1) { setResults([]); setOpen(false); return; }
    const data = await api.symbolSearch(text);
    if (data.success && data.results) {
      setResults(data.results);
      setOpen(data.results.length > 0);
      setActiveIdx(-1);
    }
  };

  const handleInput = (e) => {
    const val = e.target.value.toUpperCase();
    setQuery(val);
    onChange(val);
    // Debounce search
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 250);
  };

  const handleSelect = (item) => {
    setQuery(item.full_name);
    onChange(item.full_name);
    onSelect(item);
    setOpen(false);
    setResults([]);
  };

  const handleKeyDown = (e) => {
    if (!open || results.length === 0) {
      if (e.key === 'Enter') { e.preventDefault(); onSelect({ full_name: query, symbol: query, exchange: '', description: '' }); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0) handleSelect(results[activeIdx]);
      else if (results.length > 0) handleSelect(results[0]);
      else onSelect({ full_name: query, symbol: query, exchange: '', description: '' });
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const typeIcon = (type) => {
    switch (type) {
      case 'stock': return '📈';
      case 'futures': return '📊';
      case 'crypto': return '₿';
      case 'forex': return '💱';
      case 'index': return '📉';
      case 'bond': return '🏛';
      default: return '•';
    }
  };

  return (
    <div className="symbol-search-wrapper" ref={wrapperRef}>
      <input
        type="text"
        value={query}
        onChange={handleInput}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder || 'Search symbol... (RELIANCE, AAPL, BTC)'}
        className="symbol-search-input"
        autoComplete="off"
      />
      {open && results.length > 0 && (
        <div className="symbol-search-dropdown">
          {results.map((item, idx) => (
            <div
              key={`${item.full_name}-${idx}`}
              className={`symbol-search-item ${idx === activeIdx ? 'active' : ''}`}
              onMouseDown={() => handleSelect(item)}
              onMouseEnter={() => setActiveIdx(idx)}
            >
              <span className="ss-icon">{typeIcon(item.type)}</span>
              <div className="ss-info">
                <span className="ss-name">{item.full_name}</span>
                <span className="ss-desc">{item.description}{item.exchange && item.exchange !== item.prefix ? ` · ${item.exchange}` : ''}</span>
              </div>
              <span className="ss-type">{item.type}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
