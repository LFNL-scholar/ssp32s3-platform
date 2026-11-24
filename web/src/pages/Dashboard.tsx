import { useEffect, useState } from 'preact/hooks';
import { api, SystemInfo, TelemetryMsg, wsClient } from '../api/client';
import { LineChart } from '../components/LineChart';

function fmtBytes(b: number) {
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / 1024).toFixed(1)} KB`;
}

function fmtUptime(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${d > 0 ? d + '天 ' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function Dashboard() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [tel, setTel] = useState<TelemetryMsg | null>(null);
  const [sramHist, setSramHist] = useState<number[]>([]);
  const [psramHist, setPsramHist] = useState<number[]>([]);
  const [tempHist, setTempHist] = useState<number[]>([]);
  const [rssiHist, setRssiHist] = useState<number[]>([]);

  const pushTel = (t: TelemetryMsg) => {
    setTel(t);
    const sramUsedPct = t.sram.total > 0 ? Math.round(((t.sram.total - t.sram.free) / t.sram.total) * 1000) / 10 : 0;
    const psramUsedPct = t.psram.total > 0 ? Math.round(((t.psram.total - t.psram.free) / t.psram.total) * 1000) / 10 : 0;
    setSramHist((p) => [...p.slice(-59), sramUsedPct]);
    setPsramHist((p) => [...p.slice(-59), psramUsedPct]);
    if (t.temp_c !== null) setTempHist((p) => [...p.slice(-59), t.temp_c!]);
    if (t.wifi.sta_connected) setRssiHist((p) => [...p.slice(-59), t.wifi.rssi]);
  };

  useEffect(() => {
    api.systemInfo().then(setInfo).catch(() => {});
    api.systemStatus().then(pushTel).catch(() => {});
    return wsClient.subscribe((msg) => {
      if (msg.type === 'telemetry') pushTel(msg);
    });
  }, []);

  const sramUsed = tel ? tel.sram.total - tel.sram.free : 0;
  const psramUsed = tel ? tel.psram.total - tel.psram.free : 0;

  return (
    <div class="grid" style={{ gap: '14px' }}>
      <div class="grid grid-4">
        <div class="card">
          <div class="stat-sub">内部 SRAM 使用</div>
          <div class="stat-val">{tel ? fmtBytes(sramUsed) : '--'}</div>
          <div class="stat-sub">剩余 {tel ? fmtBytes(tel.sram.free) : '--'} / {tel ? fmtBytes(tel.sram.total) : '--'} (最小 {tel ? fmtBytes(tel.sram.min_free) : '--'})</div>
          <div class="bar-bg"><div class="bar-fill" style={{ width: tel && tel.sram.total ? `${(sramUsed / tel.sram.total) * 100}%` : '0%' }} /></div>
        </div>

        <div class="card">
          <div class="stat-sub">8MB Octal PSRAM 使用</div>
          <div class="stat-val">{tel ? fmtBytes(psramUsed) : '--'}</div>
          <div class="stat-sub">剩余 {tel ? fmtBytes(tel.psram.free) : '--'} / {tel ? fmtBytes(tel.psram.total) : '--'} (最小 {tel ? fmtBytes(tel.psram.min_free) : '--'})</div>
          <div class="bar-bg"><div class="bar-fill" style={{ width: tel && tel.psram.total ? `${(psramUsed / tel.psram.total) * 100}%` : '0%', background: 'var(--purple)' }} /></div>
        </div>

        <div class="card">
          <div class="stat-sub">芯片温度 & 运行时间</div>
          <div class="stat-val">{tel && tel.temp_c !== null ? `${tel.temp_c.toFixed(1)} °C` : '--'}</div>
          <div class="stat-sub">已运行：{tel ? fmtUptime(tel.uptime_s) : '--'}</div>
          <div class="stat-sub">时间同步：{tel?.time_synced ? 'SNTP 已对时' : '未对时'}</div>
        </div>

        <div class="card">
          <div class="stat-sub">Wi-Fi & 蓝牙状态</div>
          <div class="stat-val">{tel ? `${tel.wifi.mode}` : '--'}</div>
          <div class="stat-sub">{tel?.wifi.ssid || '--'} · IP: <span class="mono">{tel?.wifi.ip || '--'}</span></div>
          <div class="stat-sub">BLE: {tel?.ble.state || '--'} · 在家 {tel?.ble.home_persons ?? 0} 人 / {tel?.ble.tracked ?? 0} 设备</div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-title">内存占用趋势 (60s)</div>
          <LineChart
            min={0}
            max={100}
            unit="%"
            series={[
              { label: 'SRAM', color: '#38bdf8', data: sramHist },
              { label: 'PSRAM', color: '#a855f7', data: psramHist },
            ]}
          />
        </div>

        <div class="card">
          <div class="card-title">芯片温度 & Wi-Fi 信号趋势 (60s)</div>
          <LineChart
            unit=""
            series={[
              { label: '温度(°C)', color: '#f59e0b', data: tempHist },
              { label: 'Wi-Fi(dBm)', color: '#22c55e', data: rssiHist },
            ]}
          />
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-title">芯片与固件信息</div>
          {info ? (
            <table>
              <tbody>
                <tr><td class="dim">芯片型号</td><td>{info.chip} (rev {info.revision}, {info.cores} 核 @ {info.cpu_mhz} MHz)</td></tr>
                <tr><td class="dim">STA MAC</td><td class="mono">{info.mac}</td></tr>
                <tr><td class="dim">ESP-IDF</td><td class="mono">{info.idf_version}</td></tr>
                <tr><td class="dim">固件版本</td><td class="mono">{info.project_name} v{info.fw_version} ({info.running_partition})</td></tr>
                <tr><td class="dim">编译时间</td><td class="mono">{info.compile_date} {info.compile_time}</td></tr>
                <tr><td class="dim">上次重启原因</td><td><span class="badge badge-gray">{info.reset_reason}</span></td></tr>
                {tel?.wifi.sta_connected && (
                  <tr><td class="dim">网络详情</td><td class="mono">GW {tel.wifi.gateway} · DNS {tel.wifi.dns} · CH {tel.wifi.channel}</td></tr>
                )}
              </tbody>
            </table>
          ) : <div class="dim">加载中...</div>}
        </div>

        <div class="card">
          <div class="card-title">16MB Flash 分区与存储</div>
          {info ? (
            <div>
              {(['www', 'data'] as const).map((lbl) => {
                const fs = info.littlefs[lbl];
                if (!fs) return null;
                const pct = fs.total > 0 ? Math.round((fs.used / fs.total) * 100) : 0;
                return (
                  <div key={lbl} style={{ marginBottom: '10px' }}>
                    <div class="row" style={{ justifyContent: 'space-between', fontSize: '12px' }}>
                      <span>LittleFS /{lbl}</span>
                      <span class="mono">{fmtBytes(fs.used)} / {fmtBytes(fs.total)} ({pct}%)</span>
                    </div>
                    <div class="bar-bg"><div class="bar-fill" style={{ width: `${pct}%`, background: 'var(--green)' }} /></div>
                  </div>
                );
              })}
              <div class="table-wrap" style={{ marginTop: '10px' }}>
                <table>
                  <thead><tr><th>分区</th><th>偏移</th><th>大小</th></tr></thead>
                  <tbody>
                    {info.partitions.map((p) => (
                      <tr key={p.label}>
                        <td class="mono">{p.label}</td>
                        <td class="mono">0x{p.offset.toString(16)}</td>
                        <td class="mono">{fmtBytes(p.size)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : <div class="dim">加载中...</div>}
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>FreeRTOS 任务运行状态</span>
          <span class="dim" style={{ fontSize: '12px' }}>{tel?.tasks.length || 0} 个任务</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>任务名</th><th>CPU 占比</th><th>绑定核心</th><th>剩余栈高水位 (Bytes)</th></tr>
            </thead>
            <tbody>
              {(tel?.tasks || []).slice().sort((a, b) => b.cpu - a.cpu).map((t) => (
                <tr key={t.name}>
                  <td class="mono">{t.name}</td>
                  <td>
                    <div class="row" style={{ gap: '8px' }}>
                      <span class="mono" style={{ width: '50px' }}>{t.cpu.toFixed(1)}%</span>
                      <div class="bar-bg" style={{ width: '90px', marginTop: 0 }}>
                        <div class="bar-fill" style={{ width: `${Math.min(100, t.cpu)}%` }} />
                      </div>
                    </div>
                  </td>
                  <td>{t.core < 0 ? 'Any' : `Core ${t.core}`}</td>
                  <td class="mono">{t.stack_hwm}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
