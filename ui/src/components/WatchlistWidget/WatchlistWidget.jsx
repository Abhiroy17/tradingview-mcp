import { useState, useMemo, useCallback } from 'react';
import SymbolSearch from '../SymbolSearch';
import './WatchlistWidget.css';

const SORT_OPTIONS = [
  { value: 'custom', label: 'Custom' },
  { value: 'name-asc', label: 'A → Z' },
  { value: 'name-desc', label: 'Z → A' },
  { value: 'change-desc', label: '% Change ↓' },
  { value: 'change-asc', label: '% Change ↑' },
  { value: 'price-desc', label: 'Price ↓' },
  { value: 'price-asc', label: 'Price ↑' },
];

/**
 * Professional WatchlistWidget — trading-app standard UI.
 * Supports: Add/Remove/Edit mode, Sort, Bulk delete, Search filter, Multi-select for scanner.
 */
export function WatchlistWidget({
  symbols = [],
  onAdd,
  onRemove,
  onSelect,
  selectedSymbols = [],
  onSelectionChange,
  selectable = false,
  showSearch = true,
  showFilter = true,
  showPrices = true,
  api,
  placeholder,
  maxHeight = '500px',
  title,
  emptyMessage = 'No symbols in watchlist',
  quickAddSymbols,
}) {
  const [filter, setFilter] = useState('');
  const [addValue, setAddValue] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [sortBy, setSortBy] = useState('custom');
  const [bulkSelected, setBulkSelected] = useState(new Set());
  const [showAddPanel, setShowAddPanel] = useState(false);

  const sortedSymbols = useMemo(() => {
    let list = [...symbols];
    if (filter) {
      const q = filter.toUpperCase();
      list = list.filter(item => item.symbol.toUpperCase().includes(q));
    }
    switch (sortBy) {
      case 'name-asc': list.sort((a, b) => a.symbol.localeCompare(b.symbol)); break;
      case 'name-desc': list.sort((a, b) => b.symbol.localeCompare(a.symbol)); break;
      case 'change-desc': list.sort((a, b) => (b.change || 0) - (a.change || 0)); break;
      case 'change-asc': list.sort((a, b) => (a.change || 0) - (b.change || 0)); break;
      case 'price-desc': list.sort((a, b) => (b.price || 0) - (a.price || 0)); break;
      case 'price-asc': list.sort((a, b) => (a.price || 0) - (b.price || 0)); break;
      default: break;
    }
    return list;
  }, [symbols, filter, sortBy]);

  const handleAdd = async (symbolStr) => {
    if (!symbolStr || !onAdd) return;
    setAddLoading(true);
    try {
      await onAdd(symbolStr.trim().toUpperCase());
      setAddValue('');
    } finally {
      setAddLoading(false);
    }
  };

  const handleToggleSelect = useCallback((symbol) => {
    if (!onSelectionChange) return;
    const next = selectedSymbols.includes(symbol)
      ? selectedSymbols.filter(s => s !== symbol)
      : [...selectedSymbols, symbol];
    onSelectionChange(next);
  }, [onSelectionChange, selectedSymbols]);

  const handleSelectAll = () => {
    if (!onSelectionChange) return;
    onSelectionChange(
      selectedSymbols.length === symbols.length ? [] : symbols.map(s => s.symbol)
    );
  };

  const toggleBulkSelect = (symbol) => {
    setBulkSelected(prev => {
      const next = new Set(prev);
      next.has(symbol) ? next.delete(symbol) : next.add(symbol);
      return next;
    });
  };

  const bulkSelectAll = () => {
    setBulkSelected(prev =>
      prev.size === sortedSymbols.length
        ? new Set()
        : new Set(sortedSymbols.map(s => s.symbol))
    );
  };

  const handleBulkDelete = async () => {
    if (!onRemove || bulkSelected.size === 0) return;
    for (const sym of bulkSelected) {
      await onRemove(sym);
    }
    setBulkSelected(new Set());
  };

  const exitEditMode = () => {
    setEditMode(false);
    setBulkSelected(new Set());
  };

  return (
    <div className="ww-container">
      {/* Header */}
      <div className="ww-header">
        <div className="ww-header-left">
          {title && <h3 className="ww-title">{title}</h3>}
          <span className="ww-count">{symbols.length}</span>
        </div>
        <div className="ww-header-actions">
          {onAdd && (
            <button
              className={`ww-action-btn ${showAddPanel ? 'active' : ''}`}
              onClick={() => setShowAddPanel(!showAddPanel)}
              title="Add symbol"
              aria-label="Add symbol"
            >
              +
            </button>
          )}
          {onRemove && (
            <button
              className={`ww-action-btn ${editMode ? 'active' : ''}`}
              onClick={() => editMode ? exitEditMode() : setEditMode(true)}
              title={editMode ? 'Done editing' : 'Edit watchlist'}
            >
              {editMode ? '✓ Done' : '✎ Edit'}
            </button>
          )}
        </div>
      </div>

      {/* Add Panel */}
      {showAddPanel && showSearch && onAdd && (
        <div className="ww-add-panel">
          <div className="ww-add-bar">
            {api ? (
              <SymbolSearch
                value={addValue}
                onChange={setAddValue}
                onSelect={(item) => handleAdd(item.full_name || addValue)}
                api={api}
                disabled={addLoading}
                placeholder={placeholder || 'Search symbol (e.g. RELIANCE, TCS)...'}
              />
            ) : (
              <input
                type="text"
                className="ww-add-input"
                value={addValue}
                onChange={(e) => setAddValue(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd(addValue)}
                placeholder={placeholder || 'Type NSE:SYMBOL and press Enter'}
                disabled={addLoading}
              />
            )}
            <button
              className="ww-add-btn"
              onClick={() => handleAdd(addValue)}
              disabled={addLoading || !addValue.trim()}
            >
              {addLoading ? '…' : 'Add'}
            </button>
          </div>
          {quickAddSymbols && quickAddSymbols.length > 0 && (
            <div className="ww-quick-add">
              <span className="ww-quick-label">Popular:</span>
              <div className="ww-quick-chips">
                {quickAddSymbols.slice(0, 12).map(sym => (
                  <button
                    key={sym}
                    className="ww-quick-chip"
                    onClick={() => handleAdd(sym)}
                    disabled={symbols.some(s => s.symbol === sym)}
                  >
                    {sym.replace(/^NSE:|^BSE:/, '')}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Toolbar: filter + sort */}
      <div className="ww-toolbar">
        {showFilter && (
          <div className="ww-search-box">
            <span className="ww-search-icon">🔍</span>
            <input
              type="text"
              className="ww-filter-input"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search..."
            />
            {filter && (
              <button className="ww-filter-clear" onClick={() => setFilter('')}>✕</button>
            )}
          </div>
        )}
        <select className="ww-sort-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {selectable && !editMode && (
          <button className="ww-toolbar-btn" onClick={handleSelectAll}>
            {selectedSymbols.length === symbols.length ? '☑' : '☐'} All
          </button>
        )}
      </div>

      {/* Edit mode bulk actions */}
      {editMode && (
        <div className="ww-bulk-bar">
          <button className="ww-bulk-btn" onClick={bulkSelectAll}>
            {bulkSelected.size === sortedSymbols.length ? 'Deselect All' : 'Select All'}
          </button>
          <button
            className="ww-bulk-btn danger"
            onClick={handleBulkDelete}
            disabled={bulkSelected.size === 0}
          >
            🗑 Delete ({bulkSelected.size})
          </button>
        </div>
      )}

      {/* Selection summary */}
      {selectable && selectedSymbols.length > 0 && !editMode && (
        <div className="ww-selection-info">
          {selectedSymbols.length} / {symbols.length} selected for scanning
        </div>
      )}

      {/* Symbol List */}
      <div className="ww-list" style={{ maxHeight }}>
        {sortedSymbols.length === 0 ? (
          <div className="ww-empty">
            <div className="ww-empty-icon">📋</div>
            <p>{filter ? 'No symbols match your search' : emptyMessage}</p>
            {!filter && onAdd && (
              <button className="ww-empty-add" onClick={() => setShowAddPanel(true)}>
                + Add your first symbol
              </button>
            )}
          </div>
        ) : (
          sortedSymbols.map((item) => {
            const isSelected = selectedSymbols.includes(item.symbol);
            const isBulkSel = bulkSelected.has(item.symbol);
            const name = item.symbol.replace(/^NSE:|^BSE:/, '');
            const price = item.price ? Number(item.price) : null;
            const change = item.change != null ? Number(item.change) : null;
            const up = change != null && change >= 0;

            return (
              <div
                key={item.symbol}
                className={`ww-row ${isSelected ? 'selected' : ''} ${isBulkSel ? 'bulk-sel' : ''} ${item.signal ? `sig-${item.signal.toLowerCase()}` : ''}`}
                onClick={() => {
                  if (editMode) toggleBulkSelect(item.symbol);
                  else if (selectable) handleToggleSelect(item.symbol);
                  else if (onSelect) onSelect(item.symbol);
                }}
              >
                {/* Checkbox */}
                {(editMode || selectable) && (
                  <input
                    type="checkbox"
                    className="ww-chk"
                    checked={editMode ? isBulkSel : isSelected}
                    onChange={() => editMode ? toggleBulkSelect(item.symbol) : handleToggleSelect(item.symbol)}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}

                {/* Left: symbol + tags */}
                <div className="ww-row-info">
                  <span className="ww-sym">{name}</span>
                  {item.source && <span className="ww-tag source">{item.source}</span>}
                  {item.optimalStrategy && <span className="ww-tag strat">{item.optimalStrategy}</span>}
                </div>

                {/* Right: LTP + change */}
                {showPrices && !editMode && (
                  <div className="ww-row-price">
                    {price ? (
                      <>
                        <span className={`ww-ltp ${up ? 'up' : change != null ? 'down' : ''}`}>
                          {price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </span>
                        {change != null && (
                          <span className={`ww-pct ${up ? 'up' : 'down'}`}>
                            {up ? '+' : ''}{change.toFixed(2)}%
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="ww-ltp muted">—</span>
                    )}
                  </div>
                )}

                {/* Signal */}
                {item.signal && !editMode && (
                  <span className={`ww-signal ${item.signal.toLowerCase()}`}>{item.signal}</span>
                )}

                {/* Delete */}
                {editMode && onRemove && (
                  <button
                    className="ww-del-btn"
                    onClick={(e) => { e.stopPropagation(); onRemove(item.symbol); }}
                  >✕</button>
                )}
                {!editMode && onRemove && (
                  <button
                    className="ww-del-hover"
                    onClick={(e) => { e.stopPropagation(); onRemove(item.symbol); }}
                    title="Remove"
                  >✕</button>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      {symbols.length > 0 && (
        <div className="ww-footer">
          <span className="ww-ft up">{symbols.filter(s => s.change > 0).length} ↑</span>
          <span className="ww-ft down">{symbols.filter(s => s.change < 0).length} ↓</span>
          <span className="ww-ft flat">{symbols.filter(s => !s.change).length} —</span>
        </div>
      )}
    </div>
  );
}

export default WatchlistWidget;
