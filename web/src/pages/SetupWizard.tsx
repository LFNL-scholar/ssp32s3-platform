import { useState } from 'preact/hooks';
import { api, WifiAp } from '../api/client';

interface Props {
  onComplete: () => void;
}

export function SetupWizard({ onComplete }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [aps, setAps] = useState<WifiAp[]>([]);
  const [ssid, setSsid] = useState('');
  const [wifiPw, setWifiPw] = useState('');
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const handleInitPw = async (e: Event) => {
    e.preventDefault();
    setErr('');
    if (pw.length < 4) return setErr('密码长度至少 4 位');
    if (pw !== pw2) return setErr('两次输入的密码不一致');
    setBusy(true);
    try {
      await api.setupInit(pw);
      setStep(2);
      scanWifi();
    } catch (ex: any) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  const scanWifi = async () => {
    setScanning(true);
    setErr('');
    try {
      const res = await api.wifiScan();
      setAps(res.aps || []);
    } catch (ex: any) {
      setErr(ex.message);
    } finally {
      setScanning(false);
    }
  };

  const handleConnect = async (e: Event) => {
    e.preventDefault();
    if (!ssid.trim()) return setErr('请选择或输入 Wi-Fi 名称');
    setBusy(true);
    setErr('');
    try {
      const res = await api.wifiConnect(ssid.trim(), wifiPw);
      setMsg(`连接成功！设备 IP: ${res.ip}，稍后可通过 http://${res.hostname}.local 访问`);
      window.setTimeout(onComplete, 2500);
    } catch (ex: any) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="auth-wrap">
      <div class="card auth-card" style={{ maxWidth: '460px' }}>
        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <img src="/logo.png" alt="LFNL Logo" class="logo-light" style={{ height: '24px', width: 'auto', margin: '0 auto 12px' }} />
          <img src="/logo-dark.png" alt="LFNL Logo" class="logo-dark" style={{ height: '24px', width: 'auto', margin: '0 auto 12px' }} />
          <div class="eyebrow" style={{ justifyContent: 'center' }}>INITIAL SETUP · STEP {step}/2</div>
          <h2 style={{ fontSize: '19px', fontWeight: 700, marginTop: '4px' }}>S3控制系统 · 初始化向导</h2>
        </div>

        {err && <div class="alert alert-err" style={{ marginBottom: '12px' }}>{err}</div>}
        {msg && <div class="alert alert-ok" style={{ marginBottom: '12px' }}>{msg}</div>}

        {step === 1 ? (
          <form onSubmit={handleInitPw}>
            <div class="field">
              <label>设置管理员密码（至少 4 位）</label>
              <input class="input" type="password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} required />
            </div>
            <div class="field">
              <label>确认管理员密码</label>
              <input class="input" type="password" value={pw2} onInput={(e) => setPw2((e.target as HTMLInputElement).value)} required />
            </div>
            <button class="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
              {busy ? '保存中...' : '下一步：配置 Wi-Fi'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleConnect}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <span class="sec" style={{ fontSize: '12.5px' }}>选择家庭 Wi-Fi</span>
              <button type="button" class="btn btn-sm" onClick={scanWifi} disabled={scanning}>
                {scanning ? '扫描中...' : '重新扫描'}
              </button>
            </div>
            {aps.length > 0 && (
              <div style={{ maxHeight: '160px', overflowY: 'auto', marginBottom: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {aps.map((ap) => (
                  <div
                    key={ap.ssid}
                    class={`dev-row ${ssid === ap.ssid ? 'selected' : ''}`}
                    onClick={() => setSsid(ap.ssid)}
                  >
                    <span style={{ fontWeight: 500 }}>{ap.ssid}</span>
                    <span class="num dim" style={{ fontSize: '12px' }}>{ap.rssi} dBm · {ap.auth}</span>
                  </div>
                ))}
              </div>
            )}
            <div class="field">
              <label>Wi-Fi 名称 (SSID)</label>
              <input class="input" value={ssid} onInput={(e) => setSsid((e.target as HTMLInputElement).value)} required />
            </div>
            <div class="field">
              <label>Wi-Fi 密码（开放网络留空）</label>
              <input class="input" type="password" value={wifiPw} onInput={(e) => setWifiPw((e.target as HTMLInputElement).value)} />
            </div>
            <div class="btn-row">
              <button type="submit" class="btn btn-primary" style={{ flex: 1 }} disabled={busy}>
                {busy ? '正在连接...' : '连接并完成'}
              </button>
              <button type="button" class="btn" onClick={onComplete}>暂不配网</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
