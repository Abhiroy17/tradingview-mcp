import { useState, useMemo } from 'react';
import './ScanResultGrid.css';

/**
 * ScanResultGrid — renders the response from POST /api/v2/scan.
 *
 * Props:
 *   results: array from `scan` response (each item: {ok, code, symbol, timeframe, mode, result|error})
 *   loading: boolean
 *   onSelect: optional (item) => void — clicked row
 *   groupBy: 'none' | 'symbol' | 'strategy' (default: 'none')
 *   actionableOnly: boolean — hide WAIT signals (default: false)
 */
export default function ScanResultGrid({
  results = [],
  loading = false,
  onSelect,
  groupBy = 'none',
  actionableOnly: actionableOnlyDefault = false,
}) {
  const [sortBy, setSortBy] = useState('signal');
  const [sortDir, setSortDir] = useState('desc');
  const [actionableOnly, setActionableOnly] = useState(actionableOnlyDefault);
  const [filterText, setFilterText] = useState('');

  const filtered = useMemo(() => {
    let arr = results.filter(r => r.ok);
    if (actionableOnly) {
      arr = arr.filter(r => {
        const sig = r.result?.currentSignal?.type;
        return sig && sig !== 'WAIT' && sig !== 'NONE';
      });
    }
    if (filterText) {
      const q = filterText.toLowerCase();
      arr = arr.filter(r =>
        (r.symbol || '').toLowerCase().includes(q) ||
        (r.code || '').toLowerCase().includes(q) ||
        (r.result?.name || '').toLowerCase().includes(q)
      );
    }
    return arr;
  }, [results, actionableOnly, filterText]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let av, bv;
      switch (sortBy) {
        case 'symbol': av = a.symbol; bv = b.symbol; break;
        case 'strategy': av = a.code; bv = b.code; break;
        case 'signal':
          av = signalRank(a.result?.currentSignal?.type);
          bv = signalRank(b.result?.currentSignal?.type);
          break;
        case 'rank':
          av = a.rank ?? 999;
          bv = b.rank ?? 999;
          break;
        case 'score':
          av = a.score ?? -1;
          bv = b.score ?? -1;
          break;
        case 'winRate':
          av = a.result?.winRate ?? -1;
          bv = b.result?.winRate ?? -1;
          break;
        case 'profitFactor':
          av = a.result?.profitFactor ?? -1;
          bv = b.result?.profitFactor ?? -1;
          break;
        case 'sharpe':
          av = a.result?.sharpe ?? -999;
          bv = b.result?.sharpe ?? -999;
          break;
        case 'trades':
          av = a.result?.totalTrades ?? 0;
          bv = b.result?.totalTrades ?? 0;
          break;
        case 'pnl':
          av = a.result?.totalPnl ?? -999;
          bv = b.result?.totalPnl ?? -999;
          break;
        default: av = 0; bv = 0;
      }
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  }, [filtered, sortBy, sortDir]);

  const grouped = useMemo(() => {
    if (groupBy === 'none') return null;
    const key = groupBy === 'symbol' ? 'symbol' : 'code';
    const map = new Map();
    for (const r of sorted) {
      const k = r[key];
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    return map;
  }, [sorted, groupBy]);

  const handleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir(col === 'symbol' || col === 'strategy' ? 'asc' : 'desc'); }
  };

  const sortIcon = (col) => sortBy === col ? (sortDir === 'asc' ? '▲' : '▼') : '';

  const errorCount = results.length - filtered.length;
  const okCount = results.filter(r => r.ok).length;

  return (
    <div className="scan-grid">
      <div className="sg-toolbar">
        <input
          type="text"
          placeholder="Filter results..."
          className="sg-filter-input"
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
        />
        <label className="sg-checkbox">
          <input
            type="checkbox"
            checked={actionableOnly}
            onChange={e => setActionableOnly(e.target.checked)}
          />
          <span>Actionable only</span>
        </label>
        <div className="sg-stats">
          <span>{sorted.length} / {results.length}</span>
          {okCount > 0 && <span className="sg-ok">{okCount} OK</span>}
          {errorCount > 0 && actionableOnly && <span className="sg-muted">{errorCount} hidden</span>}
        </div>
      </div>

      {loading && <div className="sg-loading">Scanning…</div>}
      {!loading && sorted.length === 0 && (
        <div className="sg-empty">{results.length === 0 ? 'No results yet.' : 'No actionable signals.'}</div>
      )}

      {!loading && sorted.length > 0 && (
        <div className="sg-table-wrap">
          {groupBy === 'none' ? (
            <ResultTable rows={sorted} onSelect={onSelect} sortBy={sortBy} sortIcon={sortIcon} onSort={handleSort} />
          ) : (
            <div className="sg-groups">
              {Array.from(grouped.entries()).map(([key, rows]) => (
                <div key={key} className="sg-group">
                  <div className="sg-group-head">
                    <span className="sg-group-key">{key}</span>
                    <span className="sg-group-count">{rows.length}</span>
                  </div>
                  <ResultTable rows={rows} onSelect={onSelect} sortBy={sortBy} sortIcon={sortIcon} onSort={handleSort} hideCol={groupBy === 'symbol' ? 'symbol' : 'strategy'} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {results.some(r => !r.ok) && (
        <details className="sg-errors">
          <summary>{results.filter(r => !r.ok).length} errors</summary>
          {results.filter(r => !r.ok).map((r, i) => (
            <div key={i} className="sg-error-row">
              <span className="sg-error-key">{r.code} × {r.symbol}</span>
              <span className="sg-error-msg">{r.error}</span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function ResultTable({ rows, onSelect, sortBy, sortIcon, onSort, hideCol }) {
  const hasRanks = rows.some(r => r.rank != null);
  return (
    <table className="sg-table">
      <thead>
        <tr>
          {hasRanks && <Th label="#" col="rank" sortIcon={sortIcon} onSort={onSort} />}
          {hideCol !== 'symbol' && <Th label="Symbol" col="symbol" sortIcon={sortIcon} onSort={onSort} />}
          {hideCol !== 'strategy' && <Th label="Strategy" col="strategy" sortIcon={sortIcon} onSort={onSort} />}
          <Th label="Signal" col="signal" sortIcon={sortIcon} onSort={onSort} />
          <Th label="Price" />
          {hasRanks && <Th label="Score" col="score" sortIcon={sortIcon} onSort={onSort} />}
          <Th label="WR%" col="winRate" sortIcon={sortIcon} onSort={onSort} />
          <Th label="PF" col="profitFactor" sortIcon={sortIcon} onSort={onSort} />
          <Th label="DD%" />
          <Th label="P&L%" col="pnl" sortIcon={sortIcon} onSort={onSort} />
          <Th label="Trades" col="trades" sortIcon={sortIcon} onSort={onSort} />
          <Th label="Regime" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const sig = r.result?.currentSignal?.type || 'WAIT';
          const price = r.result?.currentSignal?.price;
          const regime = r.result?.regime || dominantRegime(r.result?.regimePerformance);
          const wr = r.result?.winRate;
          const pf = r.result?.profitFactor;
          const dd = r.result?.maxDrawdown;
          const pnl = r.result?.totalPnl;
          const trades = r.result?.totalTrades ?? 0;
          return (
            <tr
              key={`${r.code}-${r.symbol}-${i}`}
              className={onSelect ? 'sg-row-click' : ''}
              onClick={() => onSelect?.(r)}
            >
              {hasRanks && (
                <td className="sg-rank">
                  <span className={`sg-rank-pill sg-tier-${r.tier || 'neutral'}`}>{r.rank ?? '—'}</span>
                </td>
              )}
              {hideCol !== 'symbol' && <td className="sg-symbol">{r.symbol}</td>}
              {hideCol !== 'strategy' && <td className="sg-strategy">{r.result?.name || r.code}</td>}
              <td><span className={`sg-signal sg-signal-${sig.toLowerCase()}`}>{sig}</span></td>
              <td className="sg-price">{price != null ? fmtPrice(price) : '—'}</td>
              {hasRanks && (
                <td className="sg-score">
                  <span className={`sg-score-val sg-tier-${r.tier || 'neutral'}`}>{r.score ?? '—'}</span>
                </td>
              )}
              <td className="sg-num">{wr != null ? `${wr}%` : '—'}</td>
              <td className="sg-num">{pf != null ? pf.toFixed(2) : '—'}</td>
              <td className="sg-num">{dd != null ? `${dd}%` : '—'}</td>
              <td className={`sg-num ${pnl > 0 ? 'sg-good' : pnl < 0 ? 'sg-bad' : ''}`}>
                {pnl != null ? `${pnl > 0 ? '+' : ''}${pnl}%` : '—'}
              </td>
              <td className="sg-num">{trades}</td>
              <td>{regime ? <span className={`sg-regime sg-regime-${regime}`}>{regime}</span> : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function dominantRegime(regimePerf) {
  if (!regimePerf || typeof regimePerf !== 'object') return null;
  const entries = Object.entries(regimePerf);
  if (!entries.length) return null;
  entries.sort((a, b) => (b[1]?.count ?? 0) - (a[1]?.count ?? 0));
  return entries[0][1]?.count > 0 ? entries[0][0] : null;
}

function Th({ label, col, sortIcon, onSort }) {
  return (
    <th onClick={col ? () => onSort?.(col) : undefined} className={col ? 'sg-th-sort' : ''}>
      {label} {col && <span className="sg-sort-icon">{sortIcon(col)}</span>}
    </th>
  );
}

function signalRank(s) {
  switch (s) {
    case 'BUY': return 4;
    case 'SELL': return 3;
    case 'IN_TRADE': return 2;
    case 'WAIT': return 1;
    default: return 0;
  }
}

function fmtPrice(p) {
  return p >= 1000 ? p.toFixed(0) : p.toFixed(2);
}
