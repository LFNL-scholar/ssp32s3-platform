import { useEffect, useState } from 'preact/hooks';
import { api, AuthStatus, setUnauthorizedHandler, wsClient } from './api/client';
import { SetupWizard } from './pages/SetupWizard';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Lamp } from './pages/Lamp';
import { Wol } from './pages/Wol';
import { Presence } from './pages/Presence';
import { Topology } from './pages/Topology';
import { Blueprint } from './pages/Blueprint';
import { Hardware } from './pages/Hardware';
import { applyThemeMode, getSavedThemeMode, resolveTheme, ThemeMode } from './utils/theme';

type Tab = 'overview' | 'lighting' | 'wol' | 'presence' | 'topology' | 'blueprint' | 'hardware';

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [wsOk, setWsOk] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getSavedThemeMode());
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => applyThemeMode(getSavedThemeMode()));

  const refreshAuth = async () => {
    try {
      const s = await api.authStatus();
      setAuth(s);
    } catch {
      setAuth({ setup_required: false, authenticated: false, ap_mode: false, hostname: 'esp32s3' });
    }
  };

  useEffect(() => {
    setUnauthorizedHandler(() => {
      wsClient.stop();
      refreshAuth();
    });
    refreshAuth();
    return wsClient.subscribeStatus(setWsOk);
  }, []);

  useEffect(() => {
    if (auth && !auth.setup_required && auth.authenticated) {
      wsClient.start();
    } else {
      wsClient.stop();
    }
  }, [auth?.setup_required, auth?.authenticated]);

  useEffect(() => {
    const sync = () => setResolvedTheme(applyThemeMode(themeMode));
    sync();
    const id = window.setInterval(sync, 30000);
    return () => window.clearInterval(id);
  }, [themeMode]);

  const switchTab = (t: Tab) => {
    setTab(t);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  };

  if (!auth) {
    return <div class="auth-wrap dim">正在连接 S3控制系统...</div>;
  }

  if (auth.setup_required) {
    return <SetupWizard onComplete={refreshAuth} />;
  }

  if (!auth.authenticated) {
    return <Login onSuccess={refreshAuth} />;
  }

  const themeTick = `${themeMode}-${resolvedTheme}`;
  const hostLabel = auth.hostname ? `${auth.hostname}.local` : 'esp32s3.local';

  return (
    <div class="console-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-row">
            <img src="/logo.png" alt="LFNL Logo" class="brand-logo logo-light" />
            <img src="/logo-dark.png" alt="LFNL Logo" class="brand-logo logo-dark" />
            <span class="brand-sep" />
            <span class="brand-title">S3控制系统</span>
          </div>
        </div>

        <div class="nav-group-label">Console</div>
        <nav class="nav-list">
          <button class={`nav-item ${tab === 'overview' ? 'active' : ''}`} onClick={() => switchTab('overview')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></svg>
            <span>总控台</span>
          </button>
          <button class={`nav-item ${tab === 'lighting' ? 'active' : ''}`} onClick={() => switchTab('lighting')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" /></svg>
            <span>照明控制</span>
          </button>
          <button class={`nav-item ${tab === 'wol' ? 'active' : ''}`} onClick={() => switchTab('wol')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2v10" /><path d="M18.36 6.64a9 9 0 1 1-12.73 0" /></svg>
            <span>远程开机</span>
          </button>
          <button class={`nav-item ${tab === 'presence' ? 'active' : ''}`} onClick={() => switchTab('presence')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="2" /><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" /></svg>
            <span>空间感知</span>
          </button>
          <button class={`nav-item ${tab === 'topology' ? 'active' : ''}`} onClick={() => switchTab('topology')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" /><line x1="9" y1="3" x2="9" y2="18" /><line x1="15" y1="6" x2="15" y2="21" /></svg>
            <span>空间拓扑</span>
          </button>
          <button class={`nav-item ${tab === 'blueprint' ? 'active' : ''}`} onClick={() => switchTab('blueprint')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="18" height="18" rx="1" /><path d="M9 3v18M15 3v18M3 9h18M3 15h18" /></svg>
            <span>硬件蓝图</span>
          </button>
          <button class={`nav-item ${tab === 'hardware' ? 'active' : ''}`} onClick={() => switchTab('hardware')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4" y="4" width="16" height="16" rx="1" /><rect x="9" y="9" width="6" height="6" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" /></svg>
            <span>硬件与系统</span>
          </button>
        </nav>

        <div class="sidebar-footer">
          <div class="theme-seg" role="group" aria-label="主题模式">
            <button class={`theme-btn ${themeMode === 'light' ? 'active' : ''}`} onClick={() => setThemeMode('light')}>浅色</button>
            <button class={`theme-btn ${themeMode === 'dark' ? 'active' : ''}`} onClick={() => setThemeMode('dark')}>深色</button>
            <button class={`theme-btn ${themeMode === 'auto' ? 'active' : ''}`} onClick={() => setThemeMode('auto')}>自动</button>
          </div>
          <div class="theme-hint">
            {themeMode === 'auto'
              ? `自动 · 09:00 浅 / 18:00 深 (${resolveTheme('auto') === 'dark' ? '深色' : '浅色'})`
              : `手动 · ${resolvedTheme === 'dark' ? '深色模式' : '浅色模式'}`}
          </div>
          <div class="link-status">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <span class={`live-dot ${wsOk ? '' : 'off'}`} />
              <span class="num">{auth.ap_mode ? 'AP 配网模式' : hostLabel}</span>
            </span>
            <span style={{ color: 'var(--black)', fontWeight: 600 }}>{wsOk ? '1.0 Hz' : '离线'}</span>
          </div>
          <button
            class="btn"
            style={{ width: '100%' }}
            onClick={async () => {
              await api.logout();
              wsClient.stop();
              refreshAuth();
            }}
          >
            退出登录
          </button>
        </div>
      </aside>

      <main class={`workspace ${tab === 'overview' || tab === 'lighting' || tab === 'topology' || tab === 'blueprint' ? 'fit-screen' : ''}`}>
        {tab === 'overview' && <Overview onGoHardware={() => switchTab('hardware')} onGoLighting={() => switchTab('lighting')} onGoWol={() => switchTab('wol')} themeTick={themeTick} />}
        {tab === 'lighting' && <Lamp themeTick={themeTick} />}
        {tab === 'wol' && <Wol hostLabel={hostLabel} />}
        {tab === 'presence' && <Presence themeTick={themeTick} />}
        {tab === 'topology' && <Topology />}
        {tab === 'blueprint' && <Blueprint />}
        {tab === 'hardware' && <Hardware themeTick={themeTick} />}
      </main>
    </div>
  );
}
