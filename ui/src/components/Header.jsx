import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { ChartLineUp, Eye, Rocket, Target, Bell, ClockCounterClockwise, Flask, Robot, Gear, ChartBar } from 'phosphor-react';
import './Header.css';

export default function Header({ connected, monitoring }) {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }));

  useEffect(() => {
    const id = setInterval(() => {
      setTime(new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const tabs = [
    { to: '/', label: 'Dashboard', Icon: ChartLineUp },
    { to: '/watchlist', label: 'Watchlist', Icon: Eye },
    { to: '/multibagger', label: 'Multibagger', Icon: Rocket },
    { to: '/earnings', label: 'Earnings', Icon: ChartBar },
    { to: '/matrix', label: 'Strategy Matrix', Icon: Target },
    { to: '/alerts', label: 'Price Alerts', Icon: Bell },
    { to: '/history', label: 'Trade History', Icon: ClockCounterClockwise },
    { to: '/pine-lab', label: 'Pine Lab', Icon: Flask },
    { to: '/ai-agent', label: 'AI Agent', Icon: Robot },
    { to: '/settings', label: 'Settings', Icon: Gear }
  ];

  return (
    <header className="header">
      <div className="header-left">
        <h1 className="header-title">
          <ChartLineUp size={22} weight="bold" className="header-icon" />
          <span className="header-title-text">Trading Dashboard</span>
        </h1>
        <div className={`connection-badge ${connected ? 'connected' : 'disconnected'}`}>
          <span className="connection-dot"></span>
          {connected ? (monitoring ? 'LIVE' : 'CONNECTED') : 'OFFLINE'}
        </div>
      </div>

      <nav className="header-nav">
        {tabs.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) => `nav-tab ${isActive ? 'active' : ''}`}
            title={label}
          >
            <Icon size={18} weight="regular" className="nav-icon" />
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="header-right">
        <span className="time-display">{time}</span>
      </div>
    </header>
  );
}
