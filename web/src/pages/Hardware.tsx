import { useEffect, useState } from 'preact/hooks';
import { api, SystemInfo, SystemSettings, TelemetryMsg, WifiAp, wsClient } from '../api/client';
import { TelemetryChart } from '../components/Charts';
import { chartPalette } from '../utils/theme';

function fmtBytes(b: number) {
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / 1024).toFixed(1)} KB`;
}

function fmtUptime(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = String(Math.floor((sec % 86400) / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${d > 0 ? `${d} 天 ` : ''}${h}:${m}:${s}`;
}

export function Hardware({ themeTick }: { themeTick: string }) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [tel, setTel] = useState<TelemetryMsg | null>(null);
  const [sramHist, setSramHist] = useState<number[]>([]);
  const [psramHist, setPsramHist] = useState<number[]>([]);
  const [tempHist, setTempHist] = useState<number[]>([]);
  const [rssiHist, setRssiHist] = useState<number[]>([]);

  const [cfg, setCfg] = useState<SystemSettings | null>(null);
  const [aps, setAps] = useState<WifiAp[]>([]);
  const [ssid, setSsid] = useState('');
  const [wifiPw, setWifiPw] = useState('');
  const [wifiBusy, setWifiBusy] = useState(false);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');

  const [otaPct, setOtaPct] = useState<number | null>(null);
  const [otaTarget, setOtaTarget] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const pushTel = (t: TelemetryMsg) => {
    setTel(t);
    const sramPct = t.sram.total > 0 ? Math.round(((t.sram.total - t.sram.free) / t.sram.total) * 1000) / 10 : 0;
    const psramPct = t.psram.total > 0 ? Math.round(((t.psram.total - t.psram.free) / t.psram.total) * 1000) / 10 : 0;
    setSramHist((p) => [...p.slice(-59), sramPct]);
    setPsramHist((p) => [...p.slice(-59), psramPct]);
    if (t.temp_c !== null) setTempHist((p) => [...p.slice(-59), t.temp_c!]);
    if (t.wifi.sta_connected) setRssiHist((p) => [...p.slice(-59), t.wifi.rssi]);
  };

  useEffect(() => {
    api.systemInfo().then(setInfo).catch(() => {});
    api.systemStatus().then(pushTel).catch(() => {});
    api.getSettings().then(setCfg).catch(() => {});
    return wsClient.subscribe((m) => {
      if (m.type === 'telemetry') pushTel(m);
    });
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
      const targetHost = `${cfg.hostname}.local`;
      if (location.hostname.endsWith('.local') && location.hostname !== targetHost) {
        setMsg(`配置已保存！mDNS 已变更为 http://${targetHost}，正在跳转...`);
        window.setTimeout(() => { location.href = `${location.protocol}//${targetHost}/`; }, 1500);
      } else {
        setMsg('硬件配置已保存并立即生效');
      }
    } catch (ex: any) { setErr(ex.message); }
  };

  const uploadOtaFile = (file: File, endpoint: '/api/ota' | '/api/ota/www', label: string) => {
    setErr(''); setMsg(''); setOtaPct(0); setOtaTarget(label);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) setOtaPct(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      try {
        const res = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300 && res.ok) {
          setMsg(`${label} 成功！设备正在重启（约 5 秒后自动刷新页面）...`);
          window.setTimeout(() => location.reload(), 5500);
        } else {
          setErr(res.error || `${label} 失败 (${xhr.status})`);
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
    xhr.send(file);
  };

  const P = chartPalette();
  const sramUsed = tel ? tel.sram.total - tel.sram.free : 0;
  const psramUsed = tel ? tel.psram.total - tel.psram.free : 0;
  const sramPct = tel && tel.sram.total ? (sramUsed / tel.sram.total) * 100 : 0;
  const psramPct = tel && tel.psram.total ? (psramUsed / tel.psram.total) * 100 : 0;

  return (
    <>
      <div class="view-header">
        <div>
          <div class="eyebrow">HARDWARE &amp; SYSTEM · ESP32-S3-N16R8</div>
          <h1 class="view-title">硬件遥测与系统运维</h1>
        </div>
        <div class="btn-row">
          <button class="btn" onClick={() => window.confirm('确定重启 ESP32-S3？') && api.reboot().then(() => setMsg('设备正在重启...'))}>软重启</button>
          <button class="btn btn-danger" onClick={() => window.confirm('警告：确定恢复出厂设置并清空所有配置？') && api.factoryReset().then(() => setMsg('已恢复出厂设置，正在重启...'))}>恢复出厂</button>
        </div>
      </div>

      {msg && <div class="alert alert-ok">{msg}</div>}
      {err && <div class="alert alert-err">{err}</div>}

      <div class="section-divider"><span>01 / 实时硬件遥测与拓扑</span></div>

      <div class="grid g-4">
        <div class="card">
          <div class="card-head"><span class="card-title">内部 SRAM</span><span class="tag dark num">{sramPct.toFixed(1)}%</span></div>
          <div class="kpi-val num">{tel ? fmtBytes(sramUsed) : '--'}</div>
          <div class="kpi-sub num">剩余 {tel ? fmtBytes(tel.sram.free) : '--'} / {tel ? fmtBytes(tel.sram.total) : '--'}</div>
          <div class="meter"><div class="meter-fill" style={{ width: `${sramPct}%` }} /></div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">8MB Octal PSRAM</span><span class="tag num">{psramPct.toFixed(1)}%</span></div>
          <div class="kpi-val num">{tel ? fmtBytes(psramUsed) : '--'}</div>
          <div class="kpi-sub num">剩余 {tel ? fmtBytes(tel.psram.free) : '--'} / {tel ? fmtBytes(tel.psram.total) : '--'}</div>
          <div class="meter"><div class="meter-fill gray" style={{ width: `${psramPct}%` }} /></div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">芯片温度与运行时间</span><span class="tag red">正常</span></div>
          <div class="kpi-val num">{tel && tel.temp_c !== null ? tel.temp_c.toFixed(1) : '--'}<span class="kpi-unit">°C</span></div>
          <div class="kpi-sub num">已运行 {tel ? fmtUptime(tel.uptime_s) : '--'}</div>
          <div class="meter"><div class="meter-fill red" style={{ width: tel?.temp_c ? `${Math.min(100, Math.max(10, tel.temp_c))}%` : '0%' }} /></div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">Wi-Fi 与蓝牙状态</span><span class="tag num">{tel?.wifi.sta_connected ? `${tel.wifi.rssi} dBm` : '--'}</span></div>
          <div class="kpi-val" style={{ fontSize: '22px', paddingTop: '4px' }}>{tel?.wifi.mode || '--'} · BLE</div>
          <div class="kpi-sub num">{tel?.wifi.ip || '--'} · CH {tel?.wifi.channel ?? '--'}</div>
          <div class="meter"><div class="meter-fill" style={{ width: tel?.wifi.sta_connected ? '82%' : '15%' }} /></div>
        </div>
      </div>

      <div class="grid g-2">
        <div class="card">
          <div class="card-head">
            <span class="card-title">内存占用趋势（60 秒）</span>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-line" style={{ background: P.ink }} />SRAM %</span>
              <span class="legend-item"><span class="legend-line" style={{ background: P.sec }} />PSRAM %</span>
            </div>
          </div>
          <div class="chart-stats">
            <span class="chart-stat-item">SRAM 当前 <strong class="num">{sramPct.toFixed(1)}%</strong></span>
            <span class="chart-stat-item">SRAM 峰值 <strong class="num">{sramHist.length ? `${Math.max(...sramHist).toFixed(1)}%` : '--'}</strong></span>
            <span class="chart-stat-item">PSRAM 当前 <strong class="num">{psramPct.toFixed(1)}%</strong></span>
          </div>
          <TelemetryChart
            id="chart-mem"
            min={0}
            max={100}
            yTicks={[0, 25, 50, 75, 100]}
            unit="%"
            series={[
              { label: 'SRAM', color: P.ink, data: sramHist, w: 2, fmt: (v) => `${v.toFixed(1)}%` },
              { label: 'PSRAM', color: P.sec, data: psramHist, w: 1.5, dashed: true, fmt: (v) => `${v.toFixed(1)}%` },
            ]}
            themeTick={themeTick}
          />
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">核心温度与 Wi-Fi 信号趋势（60 秒）</span>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-line" style={{ background: P.red }} />温度 °C</span>
              <span class="legend-item"><span class="legend-line" style={{ background: P.ink }} />RSSI dBm</span>
            </div>
          </div>
          <div class="chart-stats">
            <span class="chart-stat-item">温度当前 <strong class="num red">{tel?.temp_c !== null && tel?.temp_c !== undefined ? `${tel.temp_c.toFixed(1)} °C` : '--'}</strong></span>
            <span class="chart-stat-item">温度峰值 <strong class="num">{tempHist.length ? `${Math.max(...tempHist).toFixed(1)} °C` : '--'}</strong></span>
            <span class="chart-stat-item">Wi-Fi 当前 <strong class="num">{tel?.wifi.sta_connected ? `${tel.wifi.rssi} dBm` : '--'}</strong></span>
          </div>
          <TelemetryChart
            id="chart-rf"
            min={25}
            max={65}
            yTicks={[25, 35, 45, 55, 65]}
            series={[
              { label: '核心温度', color: P.red, isRed: true, data: tempHist, w: 2, fmt: (v) => `${v.toFixed(1)} °C` },
              { label: 'Wi-Fi RSSI', color: P.ink, data: rssiHist.map((v) => v + 95), rawVal: rssiHist, w: 1.6, fmt: (v) => `${Math.round(v)} dBm` },
            ]}
            themeTick={themeTick}
          />
        </div>
      </div>

      <div class="grid g-2">
        <div class="card">
          <div class="card-head"><span class="card-title">芯片与固件规格</span><span class="tag dark">{info?.running_partition || '--'} 运行中</span></div>
          {info ? (
            <table class="kv-table">
              <tbody>
                <tr><td class="kv-key">处理器</td><td class="num">{info.chip} (rev {info.revision}) · {info.cores} 核 @ {info.cpu_mhz} MHz</td></tr>
                <tr><td class="kv-key">STA MAC</td><td class="num">{info.mac}</td></tr>
                <tr><td class="kv-key">ESP-IDF</td><td class="num">{info.idf_version}</td></tr>
                <tr><td class="kv-key">固件版本</td><td class="num">{info.project_name} v{info.fw_version}</td></tr>
                <tr><td class="kv-key">编译时间</td><td class="num">{info.compile_date} {info.compile_time}</td></tr>
                <tr><td class="kv-key">重启原因</td><td><span class="tag">{info.reset_reason}</span></td></tr>
              </tbody>
            </table>
          ) : <div class="dim">加载中...</div>}
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">16MB Flash 分区拓扑与 LittleFS</span><span class="tag">QIO 16MB</span></div>
          <div class="part-bar">
            <div class="part-seg" style={{ width: '25%', background: P.ink }} title="ota_0" />
            <div class="part-seg" style={{ width: '25%', background: P.sec }} title="ota_1" />
            <div class="part-seg" style={{ width: '12.5%', background: P.red }} title="www" />
            <div class="part-seg" style={{ width: '37.5%', background: P.lbl }} title="data" />
          </div>
          <table class="kv-table">
            <tbody>
              <tr><td class="kv-key">ota_0 / ota_1</td><td class="num">2 × 4.00 MB（双区热备）</td></tr>
              <tr><td class="kv-key">www（Web 界面）</td><td class="num">{info?.littlefs.www ? `${fmtBytes(info.littlefs.www.used)} / ${fmtBytes(info.littlefs.www.total)}` : '--'}</td></tr>
              <tr><td class="kv-key">data（日志与射频）</td><td class="num">{info?.littlefs.data ? `${fmtBytes(info.littlefs.data.used)} / ${fmtBytes(info.littlefs.data.total)}` : '--'}</td></tr>
              <tr><td class="kv-key">FreeRTOS 活跃任务</td><td class="num">{tel?.tasks.length ?? 0} 个任务运行中</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="section-divider"><span>02 / 硬件配置、网络与无线 OTA</span></div>

      <div class="grid g-3">
        <div class="card">
          <div class="card-head"><span class="card-title">主机名、LED 与时区</span><span class="tag">NVS</span></div>
          {cfg ? (
            <form onSubmit={saveSettings}>
              <div class="field">
                <label>mDNS 主机名（http://{cfg.hostname}.local）</label>
                <input class="input" value={cfg.hostname} onInput={(e) => setCfg({ ...cfg, hostname: (e.target as HTMLInputElement).value })} />
              </div>
              <div class="field">
                <label>WS2812B LED GPIO（禁用 35/36/37）</label>
                <input class="input num" type="number" min={0} max={48} value={cfg.led_gpio} onInput={(e) => setCfg({ ...cfg, led_gpio: Number((e.target as HTMLInputElement).value) })} />
              </div>
              <div class="field">
                <label>LED 亮度：<span class="num">{cfg.led_brightness}%</span></label>
                <input type="range" min={0} max={100} value={cfg.led_brightness} style={{ width: '100%', accentColor: 'var(--black)' }} onInput={(e) => setCfg({ ...cfg, led_brightness: Number((e.target as HTMLInputElement).value) })} />
              </div>
              <div class="switch-row" style={{ marginBottom: '10px' }}>
                <div>
                  <div class="switch-title">常态开启 RGB 指示</div>
                  <div class="switch-desc">关闭后平时熄灭，仅在配网/配对/OTA 时亮起</div>
                </div>
                <button
                  type="button"
                  class={`toggle ${cfg.led_idle_enabled ? 'on' : ''}`}
                  onClick={() => setCfg({ ...cfg, led_idle_enabled: !cfg.led_idle_enabled })}
                />
              </div>
              <div class="field">
                <label>全员离开时 LED 状态</label>
                <select class="input" value={cfg.led_away_mode} onChange={(e) => setCfg({ ...cfg, led_away_mode: Number((e.target as HTMLSelectElement).value) })}>
                  <option value={0}>暗红色常亮指示</option>
                  <option value={1}>完全熄灭</option>
                </select>
              </div>
              <div class="field">
                <label>POSIX 时区（北京时间 CST-8）</label>
                <input class="input" value={cfg.timezone} onInput={(e) => setCfg({ ...cfg, timezone: (e.target as HTMLInputElement).value })} />
              </div>
              <button class="btn btn-primary" type="submit">保存硬件配置</button>
            </form>
          ) : <div class="dim">加载中...</div>}
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">Wi-Fi 网络与管理员密码</span><span class="tag">安全</span></div>
          {aps.length > 0 && (
            <div class="field">
              <select class="input" onChange={(e) => setSsid((e.target as HTMLSelectElement).value)}>
                <option value="">-- 从扫描结果选择 --</option>
                {aps.map((a) => <option key={a.ssid} value={a.ssid}>{a.ssid} ({a.rssi} dBm)</option>)}
              </select>
            </div>
          )}
          <div class="field">
            <label>Wi-Fi 名称（SSID）</label>
            <input class="input" value={ssid} onInput={(e) => setSsid((e.target as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label>Wi-Fi 密码</label>
            <input class="input" type="password" value={wifiPw} onInput={(e) => setWifiPw((e.target as HTMLInputElement).value)} />
          </div>
          <div class="btn-row" style={{ marginBottom: '14px' }}>
            <button class="btn" onClick={() => api.wifiScan().then((r) => setAps(r.aps || [])).catch((ex: any) => setErr(ex.message))}>扫描网络</button>
            <button
              class="btn btn-primary"
              disabled={wifiBusy || !ssid.trim()}
              onClick={async () => {
                setWifiBusy(true); setErr(''); setMsg('');
                try {
                  const res = await api.wifiConnect(ssid.trim(), wifiPw);
                  setMsg(`已切换到新 Wi-Fi，IP: ${res.ip}`);
                } catch (ex: any) { setErr(ex.message); }
                finally { setWifiBusy(false); }
              }}
            >
              {wifiBusy ? '连接中...' : '切换连接'}
            </button>
          </div>
          <div style={{ borderTop: '1px dashed var(--line)', paddingTop: '12px' }}>
            <div class="field" style={{ marginBottom: '8px' }}>
              <label>修改控制台密码</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <input class="input" type="password" placeholder="当前密码" value={oldPw} onInput={(e) => setOldPw((e.target as HTMLInputElement).value)} />
                <input class="input" type="password" placeholder="新密码(≥4位)" value={newPw} onInput={(e) => setNewPw((e.target as HTMLInputElement).value)} />
              </div>
            </div>
            <button
              class="btn"
              onClick={async () => {
                setErr(''); setMsg('');
                try {
                  await api.changePassword(oldPw, newPw);
                  setOldPw(''); setNewPw('');
                  setMsg('管理员密码已更新');
                } catch (ex: any) { setErr(ex.message); }
              }}
            >
              更新密码
            </button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">无线 OTA 升级（免插线）</span><span class="tag red">双区热备</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <label class="dropzone">
              <div class="ota-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 12h6M12 9v6" />
                </svg>
              </div>
              <div class="ota-info">
                <div class="ota-title">固件升级（.bin → ota_0 / ota_1）</div>
                <div class="ota-desc">支持启动自检与失败自动回滚</div>
              </div>
              <span class="btn btn-sm">选择文件</span>
              <input
                type="file"
                accept=".bin"
                style={{ display: 'none' }}
                disabled={otaPct !== null}
                onChange={(e) => {
                  const f = (e.target as HTMLInputElement).files?.[0];
                  if (f) uploadOtaFile(f, '/api/ota', '固件升级');
                  (e.target as HTMLInputElement).value = '';
                }}
              />
            </label>

            <label class="dropzone">
              <div class="ota-icon red">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <div class="ota-info">
                <div class="ota-title">Web 界面升级（www.bin → LittleFS）</div>
                <div class="ota-desc">通过 /api/ota/www 纯无线更新 UI</div>
              </div>
              <span class="btn btn-sm">选择文件</span>
              <input
                type="file"
                accept=".bin"
                style={{ display: 'none' }}
                disabled={otaPct !== null}
                onChange={(e) => {
                  const f = (e.target as HTMLInputElement).files?.[0];
                  if (f) uploadOtaFile(f, '/api/ota/www', 'Web 界面升级');
                  (e.target as HTMLInputElement).value = '';
                }}
              />
            </label>
          </div>

          <div class="ota-status-box">
            <div class="ota-meta-row">
              <span>当前活动分区</span>
              <span class="tag dark num">{info?.running_partition || 'ota_0'} · 已确认有效</span>
            </div>
            <div class="ota-meta-row">
              <span>固件 / 前端占用</span>
              <span class="num" style={{ fontWeight: 600, color: 'var(--text)' }}>
                v{info?.fw_version || '--'} · {info?.littlefs.www ? fmtBytes(info.littlefs.www.used) : '--'}
              </span>
            </div>
            <div>
              <div class="ota-meta-row" style={{ marginBottom: '5px' }}>
                <span>{otaPct !== null ? `正在传输 ${otaTarget}...` : '传输就绪 · 等待固件'}</span>
                <span class="num">{otaPct ?? 0}%</span>
              </div>
              <div class="meter" style={{ marginTop: 0 }}><div class="meter-fill red" style={{ width: `${otaPct ?? 0}%` }} /></div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
