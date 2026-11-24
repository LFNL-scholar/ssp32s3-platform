import { useState } from 'preact/hooks';
import { api, WifiAp } from '../api/client';

interface Props {
  onComplete: () => void;
}

export function SetupWizard({ onComplete }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [aps, setAps] = useState<WifiAp[]>([]);
  const [scanning, setScanning] = useState(false);
  const [ssid, setSsid] = useState('');
  const [wifiPw, setWifiPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<{ ip: string; hostname: string } | null>(null);

  const submitPassword = async (e: Event) => {
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
      setErr(ex.message || '初始化失败');
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
      setErr(ex.message || '扫描 Wi-Fi 失败');
    } finally {
      setScanning(false);
    }
  };

  const connectWifi = async (e: Event) => {
    e.preventDefault();
    if (!ssid.trim()) return setErr('请选择或输入 Wi-Fi 名称 (SSID)');
    setBusy(true);
    setErr('');
    try {
      const res = await api.wifiConnect(ssid.trim(), wifiPw);
      setResult({ ip: res.ip, hostname: res.hostname || 'ssp32s3' });
      setStep(3);
    } catch (ex: any) {
      setErr(ex.message || '连接失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="container">
      <div class="card auth-box">
        <div class="card-title">
          <span>SSP32S3 首次配网向导</span>
          <span class="badge badge-blue">步骤 {step} / 3</span>
        </div>

        {err && <div class="alert alert-err">{err}</div>}

        {step === 1 && (
          <form onSubmit={submitPassword}>
            <div class="alert alert-info">
              请先设置设备网页管理密码（至少 4 位），用于保护配网、蓝牙配对与 OTA 升级功能。
            </div>
            <div class="field">
              <label>管理密码</label>
              <input class="input" type="password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} placeholder="至少 4 位字符" required />
            </div>
            <div class="field">
              <label>确认密码</label>
              <input class="input" type="password" value={pw2} onInput={(e) => setPw2((e.target as HTMLInputElement).value)} placeholder="再次输入密码" required />
            </div>
            <button class="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
              {busy ? '保存中...' : '下一步：配置 Wi-Fi'}
            </button>
          </form>
        )}

        {step === 2 && (
          <div>
            <div class="row" style={{ justifyContent: 'space-between', marginBottom: '10px' }}>
              <span class="dim">选择要连接的 2.4GHz Wi-Fi 网络</span>
              <button class="btn btn-sm" onClick={scanWifi} disabled={scanning}>
                {scanning ? '扫描中...' : '重新扫描'}
              </button>
            </div>

            {aps.length > 0 && (
              <div style={{ maxHeight: '180px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '12px' }}>
                {aps.map((ap) => (
                  <div
                    key={ap.ssid}
                    onClick={() => setSsid(ap.ssid)}
                    style={{
                      padding: '8px 12px',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      background: ssid === ap.ssid ? 'rgba(56,189,248,0.15)' : 'transparent',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <span>{ap.ssid}</span>
                    <span class="dim" style={{ fontSize: '12px' }}>{ap.rssi} dBm · {ap.auth}</span>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={connectWifi}>
              <div class="field">
                <label>Wi-Fi 名称 (SSID)</label>
                <input class="input" value={ssid} onInput={(e) => setSsid((e.target as HTMLInputElement).value)} placeholder="输入或从上方列表选择" required />
              </div>
              <div class="field">
                <label>Wi-Fi 密码（开放网络可留空）</label>
                <input class="input" type="password" value={wifiPw} onInput={(e) => setWifiPw((e.target as HTMLInputElement).value)} placeholder="输入 Wi-Fi 密码" />
              </div>
              <div class="row">
                <button class="btn btn-primary" style={{ flex: 1 }} disabled={busy}>
                  {busy ? '正在试连路由器（最多 15 秒）...' : '连接 Wi-Fi'}
                </button>
                <button type="button" class="btn" onClick={onComplete}>先跳过</button>
              </div>
            </form>
          </div>
        )}

        {step === 3 && result && (
          <div>
            <div class="alert alert-ok">
              Wi-Fi 已连接成功！板子将在 5 秒后关闭配网热点，请将手机/电脑切回家庭 Wi-Fi 后通过下方地址访问：
            </div>
            <div class="card" style={{ background: '#0f172a', marginBottom: '14px' }}>
              <div style={{ marginBottom: '8px' }}>
                <span class="dim">mDNS 域名：</span>
                <a class="mono" href={`http://${result.hostname}.local`}>http://{result.hostname}.local</a>
              </div>
              <div>
                <span class="dim">局域网 IP：</span>
                <a class="mono" href={`http://${result.ip}`}>http://{result.ip}</a>
              </div>
            </div>
            <button class="btn btn-primary" style={{ width: '100%' }} onClick={onComplete}>
              进入控制台
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
