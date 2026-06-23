import './Header.css';

export default function Header({ connected, monitoring, activeTab, onTabChange }) {
  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'watchlist', label: 'Watchlist', icon: '👁' },
    { id: 'matrix', label: 'Strategy Matrix', icon: '🎯' },
    { id: 'alerts', label: 'Price Alerts', icon: '🔔' },
    { id: 'history', label: 'Trade History', icon: '📋' },
    { id: 'pine-lab', label: 'Pine Lab', icon: '🧪' },
    { id: 'ai-agent', label: 'AI Agent', icon: '🤖' },
    { id: 'settings', label: 'Settings', icon: '⚙️' }
  ];

  return (
    <header className="header">
      <div className="header-left">
        <h1 className="header-title">
          <span className="header-icon">📈</span>
          Trading Dashboard
        </h1>
        <div className={`connection-badge ${connected ? 'connected' : 'disconnected'}`}>
          <span className="connection-dot"></span>
          {connected ? (monitoring ? 'LIVE' : 'CONNECTED') : 'OFFLINE'}
        </div>
      </div>

      <nav className="header-nav">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`nav-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            <span className="nav-icon">{tab.icon}</span>
            <span className="nav-label">{tab.label}</span>
          </button>
        ))}
      </nav>

      <div className="header-right">
        <span className="time-display">
          {new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })}
        </span>
      </div>
    </header>
  );
}
