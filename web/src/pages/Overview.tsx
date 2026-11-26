import { useEffect, useState } from 'preact/hooks';
import { api, LampHistoryResp, LampState, PersonState, PresenceLogEntry, SystemSettings, TelemetryMsg, WolState, wsClient } from '../api/client';
import { BarItem, LightingBarChart } from '../components/Charts';
import { dateKey, fmtDuration, periodRange, summarize } from '../utils/lampStats';

interface Props {
  onGoHardware: () => void;
  onGoLighting: () => void;
  onGoWol: () => void;
  themeTick: string;
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const DAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function Overview({ onGoHardware, onGoLighting, onGoWol, themeTick }: Props) {
  const [now, setNow] = useState(() => new Date());
  const [tel, setTel] = useState<TelemetryMsg | null>(null);
  const [lamp, setLamp] = useState<LampState | null>(null);
  const [wol, setWol] = useState<WolState | null>(null);
  const [wolBusy, setWolBusy] = useState(false);
  const [wolRipple, setWolRipple] = useState(0);
  const [persons, setPersons] = useState<PersonState[]>([]);
  const [nearbyCount, setNearbyCount] = useState(0);
  const [logs, setLogs] = useState<PresenceLogEntry[]>([]);
  const [hist, setHist] = useState<LampHistoryResp | null>(null);
  const [cfg, setCfg] = useState<SystemSettings | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAll = () => {
    api.systemStatus().then(setTel).catch(() => {});
    api.lampState().then((s) => {
      setLamp(s);
      const anchor = dateKey(s.history.now || Math.floor(Date.now() / 1000));
      const range = periodRange(anchor, 'week');
      if (range) api.lampHistory(range.from, range.to).then(setHist).catch(() => {});
    }).catch(() => {});
    api.presenceState().then((r) => setPersons(r.persons || [])).catch(() => {});
    api.bleScan().then((r) => setNearbyCount((r.devices || []).length)).catch(() => {});
    api.logs(8, 0).then((r) => setLogs(r.logs || [])).catch(() => {});
    api.getSettings().then(setCfg).catch(() => {});
    api.wolState().then(setWol).catch(() => {});
  };

  useEffect(() => {
    loadAll();
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    const unsub = wsClient.subscribe((msg) => {
      if (msg.type === 'telemetry') setTel(msg);
      else if (msg.type === 'lamp_state') setLamp(msg);
      else if (msg.type === 'wol_state') setWol(msg);
      else if (msg.type === 'presence_tick') setPersons(msg.persons);
      else if (msg.type === 'presence_event') {
        api.logs(8, 0).then((r) => setLogs(r.logs || [])).catch(() => {});
      }
    });
    return () => {
      window.clearInterval(timer);
      unsub();
    };
  }, []);

  const doLamp = async (action: 'on' | 'off' | 'calibrate_on' | 'calibrate_off') => {
    setBusy(true);
    try {
      const res = await api.lampAction(action);
      setLamp(res);
    } catch { /* ignore */ }
    finally { setBusy(false); }
  };

  const doWolWake = async () => {
    if (wolBusy) return;
    setWolBusy(true);
    setWolRipple((k) => k + 1);
    try {
      const res = await api.wolWake();
      setWol(res);
    } catch { /* ignore */ }
    finally { setWolBusy(false); }
  };

  const toggleAuto = async (offAway: boolean, onArrive: boolean) => {
    try {
      const res = await api.lampAutomation(offAway, onArrive);
      setLamp(res);
    } catch { /* ignore */ }
  };

  const updateLed = async (patch: Partial<SystemSettings>) => {
    if (!cfg) return;
    const next = { ...cfg, ...patch };
    setCfg(next);
    try { await api.putSettings(next); } catch { /* ignore */ }
  };

  const sramPct = tel && tel.sram.total ? (((tel.sram.total - tel.sram.free) / tel.sram.total) * 100).toFixed(1) : '--';
  const uptimeText = tel
    ? `${Math.floor(tel.uptime_s / 86400)} 天 ${Math.floor((tel.uptime_s % 86400) / 3600)} 小时`
    : '--';

  const anchor = dateKey(lamp?.history.now || Math.floor(Date.now() / 1000));
  const weekRange = periodRange(anchor, 'week');
  const summary = hist && weekRange ? summarize(hist.records, weekRange.from, weekRange.to, hist.now, hist.oldest) : null;

  let peakIdx = -1;
  let maxOn = 0;
  summary?.days.forEach((d, i) => {
    if (d.on > maxOn) {
      maxOn = d.on;
      peakIdx = i;
    }
  });

  const barItems: BarItem[] = summary
    ? summary.days.map((d, i) => {
        const dt = new Date((d.start + 8 * 3600) * 1000);
        const k = dateKey(d.start);
        return {
          lbl: DAY_SHORT[dt.getUTCDay()],
          hours: d.on / 3600,
          events: d.events.length,
          isPeak: i === peakIdx && d.on > 0,
          isToday: k === anchor,
        };
      })
    : [
        { lbl: '周一', hours: 0, events: 0 },
        { lbl: '周二', hours: 0, events: 0 },
        { lbl: '周三', hours: 0, events: 0 },
        { lbl: '周四', hours: 0, events: 0 },
        { lbl: '周五', hours: 0, events: 0 },
        { lbl: '周六', hours: 0, events: 0 },
        { lbl: '周日', hours: 0, events: 0 },
      ];

  const todaySummary = summary?.days.find((d) => dateKey(d.start) === anchor);
  const activeHours = new Set<number>();
  if (todaySummary) {
    todaySummary.segments.forEach((seg) => {
      if (seg.power === 1) {
        const h1 = new Date((seg.start + 8 * 3600) * 1000).getUTCHours();
        const h2 = new Date((Math.max(seg.start, seg.end - 1) + 8 * 3600) * 1000).getUTCHours();
        for (let h = h1; h <= h2; h++) activeHours.add(h);
      }
    });
  }
  const curHour = now.getHours();

  const homeCount = persons.filter((p) => p.is_home).length;
  const lampOn = lamp?.power_on ?? false;
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');

  return (
    <>
      <div class="card hero-strip">
        <div class="clock-block">
          <div class="big-clock num">{now.toTimeString().slice(0, 8)}</div>
          <div class="clock-plate">
            <div class="clock-date num">{now.getFullYear()}-{mm}-{dd} · {WEEKDAYS[now.getDay()]}</div>
            <div class="clock-tz">{tel?.time_synced ? 'SNTP SYNC · CST+8' : 'LOCAL CLOCK · 未对时'}</div>
          </div>
        </div>

        <div class="health-summary" onClick={onGoHardware} title="点击进入「硬件与系统」查看详情">
          <div class="health-metric"><small>核心温度</small><strong class="num">{tel?.temp_c !== null && tel?.temp_c !== undefined ? `${tel.temp_c.toFixed(1)} °C` : '--'}</strong></div>
          <div class="health-sep" />
          <div class="health-metric"><small>SRAM</small><strong class="num">{sramPct === '--' ? '--' : `${sramPct}%`}</strong></div>
          <div class="health-sep" />
          <div class="health-metric"><small>Wi-Fi</small><strong class="num">{tel?.wifi.sta_connected ? `${tel.wifi.rssi} dBm` : '--'}</strong></div>
          <div class="health-sep" />
          <div class="health-metric"><small>稳定运行</small><strong class="num">{uptimeText}</strong></div>
          <span class="tag dark">硬件详情 →</span>
        </div>
      </div>

      {/* ROW 1 */}
      <div class="grid g-cockpit-top">
        <div class="card">
          <div class="card-head">
            <span class="card-title">台灯主控 · 433.92 MHz</span>
            <span class={`tag ${lampOn ? 'dark' : ''}`}>{lamp?.power_known ? (lampOn ? '已开启' : '已关闭') : '待校准'}</span>
          </div>

          <div class="power-center" style={{ padding: '6px 0' }}>
            <div
              class={`power-orb ${lampOn ? 'is-on' : ''}`}
              role="button"
              tabIndex={0}
              style={{ width: '112px', height: '112px', margin: '6px 0 14px', opacity: busy ? 0.6 : 1 }}
              onClick={() => !busy && doLamp(lampOn ? 'off' : 'on')}
            >
              <svg class="orb-svg" style={{ width: '26px', height: '26px', marginBottom: '5px' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="M12 2v10" />
                <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
              </svg>
              <div class="orb-label" style={{ fontSize: '11px', letterSpacing: '0.12em' }}>
                <span class="orb-dot" />
                <span>{lampOn ? 'POWER ON' : 'STANDBY'}</span>
              </div>
            </div>
            <div class="kpi-sub">
              今日点亮 <strong class="num" style={{ color: 'var(--text)' }}>{todaySummary ? fmtDuration(todaySummary.on) : '--'}</strong> · 累计发射 <span class="num">{lamp?.power_transmissions ?? 0}</span> 次
            </div>
          </div>

          <div style={{ marginTop: '10px', borderTop: '1px dashed var(--line)', paddingTop: '4px' }}>
            <div class="switch-row">
              <div>
                <div class="switch-title">离家自动关灯</div>
                <div class="switch-desc">全员离家后自动关闭</div>
              </div>
              <button
                type="button"
                class={`toggle ${lamp?.automation.auto_off_on_away ? 'on' : ''}`}
                onClick={() => toggleAuto(!(lamp?.automation.auto_off_on_away ?? false), lamp?.automation.auto_on_on_arrive ?? false)}
              />
            </div>
            <div class="switch-row">
              <div>
                <div class="switch-title">回家自动开灯</div>
                <div class="switch-desc">检测到回家自动点亮</div>
              </div>
              <button
                type="button"
                class={`toggle ${lamp?.automation.auto_on_on_arrive ? 'on' : ''}`}
                onClick={() => toggleAuto(lamp?.automation.auto_off_on_away ?? false, !(lamp?.automation.auto_on_on_arrive ?? false))}
              />
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">远程开机 · WOL</span>
            <span class={`tag ${wol?.waking ? 'red' : wol?.online ? 'dark' : ''}`}>
              {wol?.waking ? '唤醒中' : wol?.online ? '已开机' : '已关机'}
            </span>
          </div>

          <div class="power-center" style={{ padding: '6px 0' }}>
            <div
              class={`power-orb ${wol?.online ? 'is-on' : ''}`}
              role="button"
              tabIndex={0}
              style={{ width: '112px', height: '112px', margin: '6px 0 14px', opacity: wolBusy ? 0.6 : 1 }}
              onClick={doWolWake}
            >
              {wolRipple > 0 && <div key={wolRipple} class="rf-ripple firing" />}
              <svg class="orb-svg" style={{ width: '26px', height: '26px', marginBottom: '5px' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <rect x="3" y="4" width="18" height="12" rx="1.5" />
                <path d="M8 20h8M12 16v4" />
              </svg>
              <div class="orb-label" style={{ fontSize: '11px', letterSpacing: '0.12em' }}>
                <span class="orb-dot" />
                <span>{wol?.waking ? 'WAKING...' : wol?.online ? 'ONLINE' : 'WAKE PC'}</span>
              </div>
            </div>
            <div class="kpi-sub num">
              {wol?.host.ip || '192.168.0.106'} · {wol?.host.mac || '9C:6B:00:5F:9C:7C'}
            </div>
          </div>

          <div style={{ marginTop: '10px', borderTop: '1px dashed var(--line)', paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-sec)' }}>
              <span>MQTT 外网通道</span>
              <span class={`tag ${wol?.mqtt.connected ? 'red' : ''}`}>
                {wol?.mqtt.connected ? 'LIVE' : wol?.mqtt.enabled ? '重连中' : '未启用'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11.5px', color: 'var(--text-dim)' }}>
              <span class="num">
                {wol && wol.last_wake.sent > 0
                  ? `上次 ${wol.last_wake.time_synced && wol.last_wake.epoch > 0 ? new Date(wol.last_wake.epoch * 1000).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5) : `+${wol.last_wake.uptime_s}s`}`
                  : '尚未唤醒'}
              </span>
              <span style={{ color: 'var(--text)', cursor: 'pointer', fontWeight: 500 }} onClick={onGoWol}>远程开机详情 →</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">空间感知态势</span>
            <span class={`tag ${homeCount > 0 ? 'dark' : ''}`}>{homeCount} / {persons.length} 在家</span>
          </div>
          <div class="person-box" style={{ flex: 1, justifyContent: 'space-between' }}>
            {persons.length === 0 ? (
              <div class="dim" style={{ textAlign: 'center', padding: '24px 0' }}>暂未绑定成员，请前往「空间感知」添加</div>
            ) : (
              persons.slice(0, 2).map((p) => (
                <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div class="avatar">{p.name.slice(0, 1).toUpperCase()}</div>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '14px' }}>{p.name}</div>
                        <div class="kpi-sub">绑定 {p.devices.length} 台蓝牙设备</div>
                      </div>
                    </div>
                    <span class={`tag ${p.is_home ? 'red' : ''}`}>{p.is_home ? '在家' : '离开'}</span>
                  </div>
                  {p.devices.slice(0, 2).map((d) => (
                    <div class="dev-row" key={d.id}>
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 600 }}>
                          {d.label} <span class="tag" style={{ marginLeft: '4px' }}>{d.match_type || 'BLE'}</span>
                        </div>
                        <div class="kpi-sub num">{d.seen_ago_s >= 0 ? `${d.seen_ago_s} 秒前活跃` : '未发现'}</div>
                      </div>
                      <div class="num" style={{ fontWeight: 700 }}>{d.seen_ago_s >= 0 && d.rssi > -120 ? `${d.rssi} dBm` : '--'}</div>
                    </div>
                  ))}
                </div>
              ))
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '8px', borderTop: '1px dashed var(--line)', fontSize: '12px', color: 'var(--text-sec)' }}>
              <span>NimBLE 被动雷达</span>
              <span class="num" style={{ fontWeight: 600, color: 'var(--text)' }}>附近 {nearbyCount} 台设备 · {tel?.ble.state || '--'}</span>
            </div>
          </div>
        </div>

        <div class="card" style={{ justifyContent: 'space-between' }}>
          <div>
            <div class="card-head">
              <span class="card-title">快捷指令与状态灯</span>
              <span class="tag">GPIO {cfg?.led_gpio ?? 48}</span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-sec)', marginBottom: '7px', fontWeight: 500 }}>台灯快捷控制与校准</div>
            <div class="quick-grid" style={{ marginBottom: '12px' }}>
              <button class="btn btn-primary" disabled={busy} onClick={() => doLamp('on')}>开灯</button>
              <button class="btn" disabled={busy} onClick={() => doLamp('off')}>关灯</button>
              <button class="btn" disabled={busy} onClick={() => doLamp(lampOn ? 'off' : 'on')}>切换</button>
            </div>
            <div class="btn-row" style={{ marginBottom: '14px' }}>
              <button class="btn" style={{ flex: 1, fontSize: '12px' }} disabled={busy} onClick={() => doLamp('calibrate_on')}>校准为开</button>
              <button class="btn" style={{ flex: 1, fontSize: '12px' }} disabled={busy} onClick={() => doLamp('calibrate_off')}>校准为关</button>
            </div>
          </div>

          <div style={{ borderTop: '1px dashed var(--line)', paddingTop: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontSize: '12.5px', fontWeight: 600 }}>板载 WS2812B 指示灯</span>
              <div class="btn-row">
                <span class="led-pill"><span class="led-swatch" style={{ opacity: cfg?.led_idle_enabled ? 1 : 0.25 }} /><span class="num">{cfg?.led_brightness ?? 10}%</span></span>
                <button
                  type="button"
                  class={`toggle ${cfg?.led_idle_enabled ? 'on' : ''}`}
                  title="常态开启/关闭板载指示灯"
                  onClick={() => updateLed({ led_idle_enabled: !(cfg?.led_idle_enabled ?? true) })}
                />
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={cfg?.led_brightness ?? 10}
              style={{ width: '100%', accentColor: 'var(--black)' }}
              onChange={(e) => updateLed({ led_brightness: Number((e.target as HTMLInputElement).value) })}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', color: 'var(--text-dim)', marginTop: '6px' }}>
              <span>{cfg?.led_idle_enabled ? '常态指示已开启' : '常态已熄灭（仅配网/OTA 亮）'}</span>
              <span style={{ color: 'var(--text)', cursor: 'pointer', fontWeight: 500 }} onClick={onGoLighting}>Siri 链接与学习 →</span>
            </div>
          </div>
        </div>
      </div>

      {/* ROW 2 */}
      <div class="grid g-cockpit-bot grow">
        <div class="card">
          <div class="card-head">
            <span class="card-title">本周亮灯趋势与趋势线</span>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-line" style={{ background: 'var(--black)' }} />常规</span>
              <span class="legend-item"><span class="legend-line" style={{ background: 'var(--red)' }} />峰值 / 趋势线</span>
            </div>
          </div>
          <div class="chart-stats">
            <span class="chart-stat-item">今日已亮 <strong class="num">{todaySummary ? fmtDuration(todaySummary.on) : '--'}</strong></span>
            <span class="chart-stat-item">本周累计 <strong class="num">{summary ? fmtDuration(summary.total) : '--'}</strong></span>
            <span class="chart-stat-item">日均时长 <strong class="num">{summary?.average !== null && summary?.average !== undefined ? fmtDuration(summary.average) : '--'}</strong></span>
            <span class="chart-stat-item">周峰值 <strong class="num red">{peakIdx >= 0 ? `${barItems[peakIdx].lbl} · ${barItems[peakIdx].hours.toFixed(1)}h` : '--'}</strong></span>
          </div>
          <LightingBarChart id="bar-ov" items={barItems} themeTick={themeTick} />
          <div class="day-strip-wrap">
            <div class="day-strip-head">
              <span>今日 24 小时亮灯时段分布</span>
              <span class="num" style={{ color: 'var(--text)', fontWeight: 600 }}>活跃 {activeHours.size} 个时段</span>
            </div>
            <div class="day-strip">
              {Array.from({ length: 24 }, (_, h) => {
                const cls = h === curHour && lampOn ? 'day-slot now' : activeHours.has(h) ? 'day-slot on' : 'day-slot';
                return <div key={h} class={cls} title={`${String(h).padStart(2, '0')}:00`} />;
              })}
            </div>
            <div class="day-axis num"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">统一实时事件流</span>
            <span class="tag red">LIVE</span>
          </div>
          <div class="timeline">
            {logs.length === 0 ? (
              <div class="dim" style={{ textAlign: 'center', padding: '24px 0' }}>暂无事件记录</div>
            ) : (
              logs.slice(0, 5).map((l) => (
                <div class="tl-item" key={l.seq}>
                  <div class={`tl-dot ${l.event === 'ARRIVE' ? 'red' : 'gray'}`} />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span class="tl-text">{l.person_name} {l.event === 'ARRIVE' ? '回家' : '离家'}</span>
                      <span class="tl-time num">
                        {l.time_synced && l.timestamp > 0
                          ? new Date(l.timestamp * 1000).toLocaleTimeString('zh-CN', { hour12: false })
                          : `+${l.uptime_s}s`}
                      </span>
                    </div>
                    <div class="tl-sub">设备：{l.device || '--'}（{l.rssi} dBm）</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
