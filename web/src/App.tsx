import { useEffect, useState } from 'preact/hooks';
import { api, AuthStatus, setUnauthorizedHandler, wsClient } from './api/client';
import { SetupWizard } from './pages/SetupWizard';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Presence } from './pages/Presence';
import { Settings } from './pages/Settings';

type Tab = 'dashboard' | 'presence' | 'settings';

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [wsOk, setWsOk] = useState(false);

  const refreshAuth = async () => {
    try {
      const s = await api.authStatus();
      setAuth(s);
    } catch {
      setAuth({ setup_required: false, authenticated: false, ap_mode: false, hostname: 'ssp32s3' });
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

  if (!auth) {
    return <div class="container dim" style={{ textAlign: 'center', marginTop: '60px' }}>正在连接设备...</div>;
  }

  if (auth.setup_required) {
    return <SetupWizard onComplete={refreshAuth} />;
  }

  if (!auth.authenticated) {
    return <Login onSuccess={refreshAuth} />;
  }

  return (
    <div>
      <header class="navbar">
        <div class="brand">
          <span class={`dot ${wsOk ? 'ok' : 'err'}`} title={wsOk ? 'WebSocket 实时连接正常' : 'WebSocket 断开'} />
          <span>SSP32S3 控制台</span>
          {auth.ap_mode && <span class="badge badge-amber">AP 配网模式</span>}
        </div>
        <nav class="nav-links">
          <button class={`tab ${tab === 'dashboard' ? 'active' : ''}`} onClick={() => setTab('dashboard')}>硬件仪表盘</button>
          <button class={`tab ${tab === 'presence' ? 'active' : ''}`} onClick={() => setTab('presence')}>蓝牙在家检测</button>
          <button class={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>系统设置</button>
          <button class="tab" onClick={async () => { await api.logout(); wsClient.stop(); refreshAuth(); }}>退出</button>
        </nav>
      </header>
      <main class="container">
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'presence' && <Presence />}
        {tab === 'settings' && <Settings />}
      </main>
    </div>
  );
}
