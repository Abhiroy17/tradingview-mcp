import { useState, useEffect } from 'react';
import './SettingsPanel.css';

export default function SettingsPanel({ api }) {
  const [notifications, setNotifications] = useState(true);
  const [browserNotif, setBrowserNotif] = useState(Notification.permission === 'granted');
  const [soundEnabled, setSoundEnabled] = useState(
    localStorage.getItem('soundEnabled') !== 'false'
  );
  const [tipsSource, setTipsSource] = useState({
    enabled: false,
    onlyMarketHours: true,
    includePremarket: true,
    autoStartScanner: true,
    autoStartMatrixScanner: true,
    includeIntradayTradingTips: true,
    includeBestIntradayTips: true,
    pollMs: 300000,
    maxSymbols: 500,
    matrixIntervalMs: 120000,
    matrixTimeframe: '1D',
    matrixMode: 'backtest',
  });
  const [tipsBusy, setTipsBusy] = useState(false);
  const [tipsMessage, setTipsMessage] = useState('');
  const [telegram, setTelegram] = useState({
    enabled: false,
    botToken: '',
    chatId: '',
    morningDigest: true,
    scanAlerts: true,
    priceAlerts: true,
    commands: true,
  });
  const [telegramStatus, setTelegramStatus] = useState(null); // { ready, enabled }
  const [telegramBusy, setTelegramBusy] = useState(false);
  const [telegramMessage, setTelegramMessage] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    const data = await api.getSettings();
    if (data.success) {
      setNotifications(data.notifications);
      if (data.tipsSource && typeof data.tipsSource === 'object') {
        setTipsSource(prev => ({ ...prev, ...data.tipsSource }));
      }
      if (data.telegram && typeof data.telegram === 'object') {
        setTelegram(prev => ({ ...prev, ...data.telegram, botToken: '' })); // never pre-fill token
      }
    }
    // Load bot status separately
    try {
      const st = await fetch('/api/telegram/status').then(r => r.json());
      setTelegramStatus(st);
    } catch {}
  };

  const toggleDesktopNotif = async () => {
    const newVal = !notifications;
    setNotifications(newVal);
    await api.updateSettings({ notifications: newVal });
  };

  const requestBrowserPermission = async () => {
    const perm = await Notification.requestPermission();
    setBrowserNotif(perm === 'granted');
  };

  const toggleSound = () => {
    const newVal = !soundEnabled;
    setSoundEnabled(newVal);
    localStorage.setItem('soundEnabled', newVal.toString());
  };

  const updateTipsSource = async (patch) => {
    const next = { ...tipsSource, ...patch };
    setTipsSource(next);
    await api.updateSettings({ tipsSource: patch });
  };

  const updateTelegram = async (patch) => {
    const next = { ...telegram, ...patch };
    setTelegram(next);
    await api.updateSettings({ telegram: next });
  };

  const saveTelegramSettings = async () => {
    setTelegramBusy(true);
    setTelegramMessage('');
    try {
      await api.updateSettings({ telegram });
      setTelegramMessage('Settings saved.');
      const st = await fetch('/api/telegram/status').then(r => r.json());
      setTelegramStatus(st);
    } catch (err) {
      setTelegramMessage('Save failed: ' + err.message);
    } finally {
      setTelegramBusy(false);
    }
  };

  const sendTelegramTest = async () => {
    setTelegramBusy(true);
    setTelegramMessage('');
    try {
      const res = await fetch('/api/telegram/test', { method: 'POST' }).then(r => r.json());
      setTelegramMessage(res.success ? '✅ Test message sent! Check your Telegram.' : '❌ ' + res.error);
    } catch (err) {
      setTelegramMessage('❌ ' + err.message);
    } finally {
      setTelegramBusy(false);
    }
  };

  const refreshTipsNow = async () => {
    setTipsBusy(true);
    setTipsMessage('');
    try {
      const res = await api.refreshTipsSource();
      if (res?.success) {
        const mergedCount = Array.isArray(res.mergedSymbols) ? res.mergedSymbols.length : (res.fetched || 0);
        setTipsMessage(`Fetched ${mergedCount} symbols from merged Munafa sources.`);
      } else {
        setTipsMessage(res?.error || 'Tips refresh skipped');
      }
    } finally {
      setTipsBusy(false);
      loadSettings();
    }
  };

  const testNotification = () => {
    // Browser notification
    if (browserNotif) {
      new Notification('Test Alert: BUY', {
        body: 'NSE:RELIANCE — BUY @ ₹1296 | RSI(2)=28.5 | TP=₹1315 SL=₹1283',
        tag: 'test-alert'
      });
    }
    // Sound
    if (soundEnabled) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.value = 0.1;
        osc.frequency.value = 800;
        osc.type = 'sine';
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.stop(ctx.currentTime + 0.3);
      } catch (e) {}
    }
  };

  return (
    <div className="settings-page">
      <div className="card">
        <div className="card-header">
          <h2>⚙️ Settings</h2>
        </div>

        <div className="settings-section">
          <h3>Notifications</h3>
          
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Windows Desktop Notifications</span>
              <span className="setting-desc">
                Show Windows toast notifications when alerts fire (works even with browser minimized)
              </span>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={notifications} onChange={toggleDesktopNotif} />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Browser Notifications</span>
              <span className="setting-desc">
                Show browser push notifications for alerts
              </span>
            </div>
            {browserNotif ? (
              <span className="setting-status enabled">✓ Enabled</span>
            ) : (
              <button className="btn-enable" onClick={requestBrowserPermission}>
                Enable
              </button>
            )}
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Sound Alerts</span>
              <span className="setting-desc">
                Play audio tone when buy/sell signals fire
              </span>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={soundEnabled} onChange={toggleSound} />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Test Notifications</span>
              <span className="setting-desc">
                Send a test notification to verify your settings work
              </span>
            </div>
            <button className="btn-test" onClick={testNotification}>
              🔔 Test
            </button>
          </div>
        </div>

        <div className="settings-section">
          <h3>Data Persistence</h3>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Storage</span>
              <span className="setting-desc">
                Alerts, trades, watchlist, and price alerts are automatically saved to disk and persist across restarts.
                Data stored in <code>.data/</code> folder.
              </span>
            </div>
            <span className="setting-status enabled">✓ Active</span>
          </div>
        </div>

        <div className="settings-section">
          <h3>Intraday Tips Source (MunafaSutra)</h3>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Enable Tips Sync + Scanner</span>
              <span className="setting-desc">
                Pulls symbols from intradayTradingTips + BestIntradayTips and keeps scans live.
              </span>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={tipsSource.enabled === true}
                onChange={() => updateTipsSource({ enabled: !(tipsSource.enabled === true) })}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Use intradayTradingTips source</span>
              <span className="setting-desc">
                Include https://munafasutra.com/nse/intradayTradingTips/ in merged tips feed.
              </span>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={tipsSource.includeIntradayTradingTips !== false}
                onChange={() => updateTipsSource({ includeIntradayTradingTips: !(tipsSource.includeIntradayTradingTips !== false) })}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Use BestIntradayTips source</span>
              <span className="setting-desc">
                Include https://munafasutra.com/nse/BestIntradayTips in merged tips feed.
              </span>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={tipsSource.includeBestIntradayTips !== false}
                onChange={() => updateTipsSource({ includeBestIntradayTips: !(tipsSource.includeBestIntradayTips !== false) })}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Only During NSE Market Hours</span>
              <span className="setting-desc">
                Restricts sync/scans to NSE session window (Mon-Fri, 09:15-15:30 IST), with optional pre-market fetch.
              </span>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={tipsSource.onlyMarketHours !== false}
                onChange={() => updateTipsSource({ onlyMarketHours: !(tipsSource.onlyMarketHours !== false) })}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Allow Pre-Market Fetch</span>
              <span className="setting-desc">
                If market-hours mode is on, also allow fetch before open (07:00-09:14 IST).
              </span>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={tipsSource.includePremarket !== false}
                onChange={() => updateTipsSource({ includePremarket: !(tipsSource.includePremarket !== false) })}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Auto-Start Scanner From Tips</span>
              <span className="setting-desc">
                Starts legacy scanner on symbols fetched from tips source.
              </span>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={tipsSource.autoStartScanner !== false}
                onChange={() => updateTipsSource({ autoStartScanner: !(tipsSource.autoStartScanner !== false) })}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Auto-Start Live Matrix Scanner</span>
              <span className="setting-desc">
                Runs live matrix scan on merged Munafa symbols × selected strategies.
              </span>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={tipsSource.autoStartMatrixScanner !== false}
                onChange={() => updateTipsSource({ autoStartMatrixScanner: !(tipsSource.autoStartMatrixScanner !== false) })}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Matrix Interval</span>
              <span className="setting-desc">Live matrix cycle interval for auto-run mode.</span>
            </div>
            <select
              className="btn-enable"
              value={tipsSource.matrixIntervalMs || 120000}
              onChange={(e) => updateTipsSource({ matrixIntervalMs: Number(e.target.value) })}
            >
              <option value={30000}>30 sec</option>
              <option value={60000}>1 min</option>
              <option value={120000}>2 min</option>
              <option value={300000}>5 min</option>
              <option value={600000}>10 min</option>
            </select>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Matrix Timeframe</span>
              <span className="setting-desc">Timeframe used by auto matrix scan.</span>
            </div>
            <select
              className="btn-enable"
              value={tipsSource.matrixTimeframe || '1D'}
              onChange={(e) => updateTipsSource({ matrixTimeframe: e.target.value })}
            >
              <option value="1D">Daily</option>
              <option value="1W">Weekly</option>
              <option value="60">1H</option>
              <option value="15">15m</option>
            </select>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Matrix Mode</span>
              <span className="setting-desc">Backtest gives richer metrics; Live is faster.</span>
            </div>
            <select
              className="btn-enable"
              value={tipsSource.matrixMode || 'backtest'}
              onChange={(e) => updateTipsSource({ matrixMode: e.target.value })}
            >
              <option value="backtest">Backtest</option>
              <option value="live">Live</option>
            </select>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Sync Frequency</span>
              <span className="setting-desc">
                Refresh every {Math.max(1, Math.round((tipsSource.pollMs || 300000) / 60000))} minute(s).
              </span>
            </div>
            <select
              className="btn-enable"
              value={tipsSource.pollMs || 300000}
              onChange={(e) => updateTipsSource({ pollMs: Number(e.target.value) })}
            >
              <option value={60000}>1 min</option>
              <option value={300000}>5 min</option>
              <option value={600000}>10 min</option>
            </select>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Manual Refresh</span>
              <span className="setting-desc">
                Fetch latest merged Munafa tips now and update dropdown/scanner targets.
              </span>
            </div>
            <button className="btn-test" onClick={refreshTipsNow} disabled={tipsBusy}>
              {tipsBusy ? 'Fetching...' : 'Fetch Munafa Tips'}
            </button>
          </div>
          {tipsMessage ? <p className="setting-desc" style={{ marginTop: 8 }}>{tipsMessage}</p> : null}
        </div>

        {/* ── Telegram Bot ── */}
        <div className="settings-section">
          <h3>📱 Telegram Bot</h3>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Enable Telegram Bot</span>
              <span className="setting-desc">
                Send morning digest, scan alerts, and price alerts to your Telegram chat.
                {telegramStatus?.ready && <span style={{ color: '#4caf50', marginLeft: 8 }}>● Connected</span>}
                {telegramStatus && !telegramStatus.ready && <span style={{ color: '#f44336', marginLeft: 8 }}>● Disconnected</span>}
              </span>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={telegram.enabled} onChange={() => updateTelegram({ enabled: !telegram.enabled })} />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Bot Token</span>
              <span className="setting-desc">From @BotFather on Telegram. Starts with a number. Stored securely, never logged.</span>
            </div>
            <input
              type="password"
              placeholder="123456789:ABC..."
              value={telegram.botToken}
              onChange={e => setTelegram(prev => ({ ...prev, botToken: e.target.value }))}
              style={{ width: 260, padding: '6px 10px', borderRadius: 6, border: '1px solid #444', background: '#1e1e2e', color: '#fff', fontSize: 13 }}
            />
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Chat ID</span>
              <span className="setting-desc">Your personal chat ID or group ID. Get it from @userinfobot.</span>
            </div>
            <input
              type="text"
              placeholder="-100123456789"
              value={telegram.chatId}
              onChange={e => setTelegram(prev => ({ ...prev, chatId: e.target.value }))}
              style={{ width: 180, padding: '6px 10px', borderRadius: 6, border: '1px solid #444', background: '#1e1e2e', color: '#fff', fontSize: 13 }}
            />
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Morning Digest (8:00 AM)</span>
              <span className="setting-desc">Send Munafasutra symbol list every morning Mon–Fri</span>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={telegram.morningDigest} onChange={() => setTelegram(prev => ({ ...prev, morningDigest: !prev.morningDigest }))} />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Scan Alerts (live + 8:30 AM)</span>
              <span className="setting-desc">Send BUY/SELL alerts from scanner and scheduled 8:30 AM scan</span>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={telegram.scanAlerts} onChange={() => setTelegram(prev => ({ ...prev, scanAlerts: !prev.scanAlerts }))} />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Price Level Alerts</span>
              <span className="setting-desc">Send notification when price crosses a configured level</span>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={telegram.priceAlerts} onChange={() => setTelegram(prev => ({ ...prev, priceAlerts: !prev.priceAlerts }))} />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Interactive Commands</span>
              <span className="setting-desc">Enable /scan, /status, /report, /help bot commands</span>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={telegram.commands} onChange={() => setTelegram(prev => ({ ...prev, commands: !prev.commands }))} />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="setting-row" style={{ gap: 8 }}>
            <div className="setting-info">
              <span className="setting-label">Actions</span>
              <span className="setting-desc">Save settings, then send a test message to verify connection</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-test" onClick={saveTelegramSettings} disabled={telegramBusy}>
                {telegramBusy ? 'Saving…' : '💾 Save'}
              </button>
              <button className="btn-test" onClick={sendTelegramTest} disabled={telegramBusy || !telegram.enabled}>
                {telegramBusy ? '…' : '📨 Test'}
              </button>
            </div>
          </div>
          {telegramMessage && <p className="setting-desc" style={{ marginTop: 8, color: telegramMessage.startsWith('✅') ? '#4caf50' : telegramMessage.startsWith('❌') ? '#f44336' : undefined }}>{telegramMessage}</p>}
        </div>

        <div className="settings-section">
          <h3>Danger Zone</h3>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Clear All Alerts</span>
              <span className="setting-desc">Remove all alert history from memory and disk</span>
            </div>
            <button className="btn-danger" onClick={async () => {
              if (confirm('Clear all alert history?')) {
                await api.clearAlerts();
                window.location.reload();
              }
            }}>Clear Alerts</button>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">Clear Trade History</span>
              <span className="setting-desc">Remove all trade records from memory and disk</span>
            </div>
            <button className="btn-danger" onClick={async () => {
              if (confirm('Clear all trade history?')) {
                await api.clearTrades();
                window.location.reload();
              }
            }}>Clear Trades</button>
          </div>
        </div>
      </div>
    </div>
  );
}
