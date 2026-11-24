import { useEffect, useState } from 'preact/hooks';
import { api, SystemSettings, WifiAp } from '../api/client';

export function Settings() {
  const [cfg, setCfg] = useState<SystemSettings | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Password form
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');

  // Wi-Fi form
  const [aps, setAps] = useState<WifiAp[]>([]);
  const [ssid, setSsid] = useState('');
  const [wifiPw, setWifiPw] = useState('');
  const [wifiBusy, setWifiBusy] = useState(false);

  // OTA upload
  const [otaFile, setOtaFile] = useState<File | null>(null);
  const [otaPct, setOtaPct] = useState<number | null>(null);

  useEffect(() => {
    api.getSettings().then(setCfg).catch((ex) => setErr(ex.message));
  }, []);

  const saveSettings = async (e: Event) => {
    e.preventDefault();
    if (!cfg) return;
    setMsg(''); setErr('');
    if ([35, 36, 37].includes(cfg.led_gpio)) {
      return setErr('GPIO 35/36/37 被 Octal PSRAM 占用，严禁用于 LED');
    }
    try {
      await api.putSettings(cfg);
      setMsg('系统设置已保存并立即生效');
    } catch (ex: any) { setErr(ex.message); }
  };

  const changePassword = async (e: Event) => {
    e.preventDefault();
    setMsg(''); setErr('');
    try {
      await api.changePassword(oldPw, newPw);
      setOldPw(''); setNewPw('');
      setMsg('管理员密码已更新');
    } catch (ex: any) { setErr(ex.message); }
  };

  const scanWifi = async () => {
    setErr('');
    try {
      const res = await api.wifiScan();
      setAps(res.aps || []);
    } catch (ex: any) { setErr(ex.message); }
  };

  const connectWifi = async (e: Event) => {
    e.preventDefault();
    if (!ssid.trim()) return;
    setWifiBusy(true); setErr(''); setMsg('');
    try {
      const res = await api.wifiConnect(ssid.trim(), wifiPw);
      setMsg(`已切换到新 Wi-Fi，IP: ${res.ip}`);
    } catch (ex: any) { setErr(ex.message); }
    finally { setWifiBusy(false); }
  };

  const uploadOta = () => {
    if (!otaFile) return;
    setErr(''); setMsg(''); setOtaPct(0);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/ota');
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) setOtaPct(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      try {
        const res = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300 && res.ok) {
          setMsg('固件上传成功，设备正在重启（约 5 秒后自动刷新页面）...');
          window.setTimeout(() => location.reload(), 6000);
        } else {
          setErr(res.error || `OTA 失败 (${xhr.status})`);
          setOtaPct(null);
        }
      } catch {
        setErr('OTA 响应异常');
        setOtaPct(null);
      }
    };
    xhr.onerror = () => {
      setErr('网络中断，OTA 失败');
      setOtaPct(null);
    };
    xhr.send(otaFile);
  };

  return (
    <div class="grid" style={{ gap: '14px' }}>
      {msg && <div class="alert alert-ok">{msg}</div>}
      {err && <div class="alert alert-err">{err}</div>}

      <div class="grid grid-2">
        <div class="card">
          <div class="card-title">RGB LED、mDNS 与时间设置</div>
          {cfg ? (
            <form onSubmit={saveSettings}>
              <div class="field">
                <label>mDNS 主机名（访问地址 http://{cfg.hostname}.local）</label>
                <input class="input" value={cfg.hostname} onInput={(e) => setCfg({ ...cfg, hostname: (e.target as HTMLInputElement).value })} />
              </div>
              <div class="field">
                <label>WS2812B LED GPIO（DevKitC-1 默认 48，v1.1 为 38；禁用 35/36/37）</label>
                <input class="input" type="number" min="0" max="48" value={cfg.led_gpio} onInput={(e) => setCfg({ ...cfg, led_gpio: Number((e.target as HTMLInputElement).value) })} />
              </div>
              <div class="field">
                <label>LED 亮度 ({cfg.led_brightness}%)</label>
                <input type="range" min="0" max="100" style={{ width: '100%' }} value={cfg.led_brightness} onInput={(e) => setCfg({ ...cfg, led_brightness: Number((e.target as HTMLInputElement).value) })} />
              </div>
              <div class="field">
                <label>全部离开时 LED 状态</label>
                <select value={cfg.led_away_mode} onChange={(e) => setCfg({ ...cfg, led_away_mode: Number((e.target as HTMLSelectElement).value) })}>
                  <option value={0}>暗红色常亮指示</option>
                  <option value={1}>完全熄灭</option>
                </select>
              </div>
              <div class="field">
                <label>主 NTP 服务器</label>
                <input class="input" value={cfg.ntp_server1} onInput={(e) => setCfg({ ...cfg, ntp_server1: (e.target as HTMLInputElement).value })} />
              </div>
              <div class="field">
                <label>备用 NTP 服务器</label>
                <input class="input" value={cfg.ntp_server2} onInput={(e) => setCfg({ ...cfg, ntp_server2: (e.target as HTMLInputElement).value })} />
              </div>
              <div class="field">
                <label>POSIX 时区（北京时间 CST-8）</label>
                <input class="input" value={cfg.timezone} onInput={(e) => setCfg({ ...cfg, timezone: (e.target as HTMLInputElement).value })} />
              </div>
              <button class="btn btn-primary" type="submit">保存设置</button>
            </form>
          ) : <div class="dim">加载中...</div>}
        </div>

        <div class="grid" style={{ gap: '14px', alignContent: 'start' }}>
          <div class="card">
            <div class="card-title">
              <span>切换 Wi-Fi 网络</span>
              <button class="btn btn-sm" onClick={scanWifi}>扫描周边热点</button>
            </div>
            {aps.length > 0 && (
              <div class="field">
                <select onChange={(e) => setSsid((e.target as HTMLSelectElement).value)}>
                  <option value="">-- 从扫描结果选择 --</option>
                  {aps.map((a) => <option key={a.ssid} value={a.ssid}>{a.ssid} ({a.rssi} dBm)</option>)}
                </select>
              </div>
            )}
            <form onSubmit={connectWifi}>
              <div class="field">
                <label>SSID</label>
                <input class="input" value={ssid} onInput={(e) => setSsid((e.target as HTMLInputElement).value)} required />
              </div>
              <div class="field">
                <label>密码</label>
                <input class="input" type="password" value={wifiPw} onInput={(e) => setWifiPw((e.target as HTMLInputElement).value)} />
              </div>
              <button class="btn btn-primary" disabled={wifiBusy}>{wifiBusy ? '连接中...' : '连接新 Wi-Fi'}</button>
            </form>
          </div>

          <div class="card">
            <div class="card-title">修改管理员密码</div>
            <form onSubmit={changePassword}>
              <div class="field">
                <label>当前密码</label>
                <input class="input" type="password" value={oldPw} onInput={(e) => setOldPw((e.target as HTMLInputElement).value)} required />
              </div>
              <div class="field">
                <label>新密码（至少 4 位）</label>
                <input class="input" type="password" value={newPw} onInput={(e) => setNewPw((e.target as HTMLInputElement).value)} required />
              </div>
              <button class="btn btn-primary">更新密码</button>
            </form>
          </div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-title">Web OTA 固件升级</div>
          <div class="field">
            <label>选择编译生成的 firmware .bin 文件（双分区升级，失败自动回滚）</label>
            <input type="file" accept=".bin" onChange={(e) => setOtaFile((e.target as HTMLInputElement).files?.[0] || null)} />
          </div>
          {otaPct !== null && (
            <div style={{ marginBottom: '12px' }}>
              <div class="dim" style={{ fontSize: '12px' }}>上传进度：{otaPct}%</div>
              <div class="bar-bg"><div class="bar-fill" style={{ width: `${otaPct}%` }} /></div>
            </div>
          )}
          <button class="btn btn-primary" disabled={!otaFile || otaPct !== null} onClick={uploadOta}>
            {otaPct !== null ? '升级中，请勿断电...' : '上传并升级固件'}
          </button>
        </div>

        <div class="card">
          <div class="card-title">设备电源与维护</div>
          <p class="dim" style={{ marginTop: 0 }}>
            恢复出厂设置会清空 Wi-Fi 凭据、管理员密码、蓝牙配对密钥与所有绑定设备，并重启进入 SoftAP 配网模式。
          </p>
          <div class="row">
            <button class="btn" onClick={async () => {
              if (window.confirm('确定重启 ESP32-S3？')) {
                await api.reboot();
                setMsg('设备正在重启...');
              }
            }}>重启设备</button>
            <button class="btn btn-danger" onClick={async () => {
              if (window.confirm('警告：确定恢复出厂设置并清空所有配置？')) {
                await api.factoryReset();
                setMsg('已清除配置，设备正在重启进入配网模式');
              }
            }}>恢复出厂设置</button>
          </div>
        </div>
      </div>
    </div>
  );
}
