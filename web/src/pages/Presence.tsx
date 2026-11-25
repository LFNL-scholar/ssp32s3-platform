import { useEffect, useState } from 'preact/hooks';
import { api, NearbyBleDevice, PersonState, PresenceLogEntry, TrackedDevice, wsClient } from '../api/client';
import { TelemetryChart } from '../components/Charts';
import { chartPalette } from '../utils/theme';

function fmtLogTime(e: PresenceLogEntry) {
  if (e.time_synced && e.timestamp > 0) {
    return new Date(e.timestamp * 1000).toLocaleString('zh-CN', { hour12: false });
  }
  return `开机后 ${e.uptime_s}s`;
}

export function Presence({ themeTick }: { themeTick: string }) {
  const [persons, setPersons] = useState<PersonState[]>([]);
  const [newPerson, setNewPerson] = useState('');
  const [nearby, setNearby] = useState<NearbyBleDevice[]>([]);
  const [logs, setLogs] = useState<PresenceLogEntry[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [logPage, setLogPage] = useState(0);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const [chartDevId, setChartDevId] = useState<number | null>(null);
  const [rssiHist, setRssiHist] = useState<Record<number, (number | null)[]>>({});
  const [rawHist, setRawHist] = useState<Record<number, (number | null)[]>>({});

  const [enterThresh, setEnterThresh] = useState(-75);
  const [exitThresh, setExitThresh] = useState(-85);
  const [awayTimeout, setAwayTimeout] = useState(120);

  const [pairModal, setPairModal] = useState<{ open: boolean; personId: number; label: string; active: boolean; remaining: number; msg: string; ok: boolean }>({
    open: false, personId: 0, label: '', active: false, remaining: 60, msg: '', ok: false,
  });
  const [bindModal, setBindModal] = useState<{ open: boolean; mac: string; label: string; personId: number }>({
    open: false, mac: '', label: '', personId: 0,
  });

  const loadState = async () => {
    try {
      const res = await api.presenceState();
      setPersons(res.persons);
      if (!chartDevId) {
        const firstDev = res.persons.flatMap((p) => p.devices)[0];
        if (firstDev) {
          setChartDevId(firstDev.id);
          setEnterThresh(firstDev.enter_rssi ?? -75);
          setExitThresh(firstDev.exit_rssi ?? -85);
          setAwayTimeout(firstDev.away_timeout_s ?? 120);
        }
      }
    } catch (ex: any) { setErr(ex.message); }
  };

  const loadScan = async () => {
    try {
      const res = await api.bleScan();
      setNearby(res.devices || []);
    } catch { /* ignore */ }
  };

  const loadLogs = async (page = logPage) => {
    try {
      const res = await api.logs(12, page * 12);
      setLogs(res.logs || []);
      setLogTotal(res.total || 0);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadState();
    loadScan();
    loadLogs(0);

    const unsub = wsClient.subscribe((m) => {
      if (m.type === 'presence_tick') {
        setPersons((prev) =>
          m.persons.map((np) => {
            const oldP = prev.find((p) => p.id === np.id);
            return {
              ...np,
              devices: np.devices.map((nd) => ({ ...oldP?.devices.find((d) => d.id === nd.id), ...nd })),
            };
          })
        );
        setRssiHist((prev) => {
          const next = { ...prev };
          m.persons.forEach((p) =>
            p.devices.forEach((d) => {
              const arr = next[d.id] || [];
              next[d.id] = [...arr.slice(-59), d.seen_ago_s >= 0 && d.rssi > -120 ? d.rssi : null];
            })
          );
          return next;
        });
        setRawHist((prev) => {
          const next = { ...prev };
          m.persons.forEach((p) =>
            p.devices.forEach((d) => {
              const arr = next[d.id] || [];
              next[d.id] = [...arr.slice(-59), d.seen_ago_s >= 0 && d.raw_rssi > -120 ? d.raw_rssi : null];
            })
          );
          return next;
        });
      } else if (m.type === 'presence_event') {
        loadLogs(0);
      } else if (m.type === 'pair_result') {
        setPairModal((pm) => ({
          ...pm,
          active: false,
          ok: m.status === 'success',
          msg: m.status === 'success' ? `配对成功！已绑定设备「${m.label}」` : (m.reason || '配对未完成'),
        }));
        if (m.status === 'success') loadState();
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!pairModal.open || !pairModal.active) return;
    const t = window.setInterval(() => {
      setPairModal((pm) => (pm.remaining > 0 ? { ...pm, remaining: pm.remaining - 1 } : pm));
    }, 1000);
    return () => window.clearInterval(t);
  }, [pairModal.open, pairModal.active]);

  const allDevs: TrackedDevice[] = persons.flatMap((p) => p.devices);
  const selectedDev = allDevs.find((d) => d.id === chartDevId) || allDevs[0] || null;
  const P = chartPalette();

  const emaData = selectedDev ? rssiHist[selectedDev.id] || [] : [];
  const rawData = selectedDev ? rawHist[selectedDev.id] || [] : [];
  const validEma = emaData.filter((v): v is number => v !== null);
  const curEma = validEma.length ? validEma[validEma.length - 1] : null;
  const maxEma = validEma.length ? Math.max(...validEma) : null;
  const avgEma = validEma.length ? validEma.reduce((a, b) => a + b, 0) / validEma.length : null;

  const selectDevice = (d: TrackedDevice) => {
    setChartDevId(d.id);
    setEnterThresh(d.enter_rssi ?? -75);
    setExitThresh(d.exit_rssi ?? -85);
    setAwayTimeout(d.away_timeout_s ?? 120);
  };

  const saveThresholds = async (
    enter = enterThresh,
    exit = exitThresh,
    timeout = awayTimeout,
  ) => {
    if (!selectedDev) return;
    setErr(''); setMsg('');
    try {
      await api.updateDevice(selectedDev.id, {
        label: selectedDev.label,
        enter_rssi: enter,
        exit_rssi: exit,
        away_timeout_s: timeout,
      });
      setMsg(`已保存「${selectedDev.label}」阈值配置`);
      loadState();
    } catch (ex: any) { setErr(ex.message); }
  };

  const homePersons = persons.filter((p) => p.is_home).length;
  const activeDevs = allDevs.filter((d) => d.is_home).length;

  return (
    <>
      <div class="view-header">
        <div>
          <div class="eyebrow">NIMBLE · IRK + RPA 空间雷达</div>
          <h1 class="view-title">空间感知与蓝牙雷达</h1>
        </div>
        <div class="btn-row">
          <input
            class="input"
            style={{ width: '140px' }}
            placeholder="新成员名称..."
            value={newPerson}
            onInput={(e) => setNewPerson((e.target as HTMLInputElement).value)}
          />
          <button
            class="btn"
            onClick={async () => {
              if (!newPerson.trim()) return;
              try {
                await api.addPerson(newPerson.trim());
                setNewPerson('');
                loadState();
              } catch (ex: any) { setErr(ex.message); }
            }}
          >
            + 添加成员
          </button>
          <button
            class="btn btn-primary"
            disabled={persons.length === 0}
            onClick={() =>
              setPairModal({
                open: true,
                personId: persons[0]?.id || 0,
                label: '我的手机',
                active: false,
                remaining: 60,
                msg: '',
                ok: false,
              })
            }
          >
            + 配对手机 (IRK)
          </button>
          <button class="btn" onClick={loadScan}>扫描雷达</button>
        </div>
      </div>

      {msg && <div class="alert alert-ok">{msg}</div>}
      {err && <div class="alert alert-err">{err}</div>}

      <div class="grid g-4">
        <div class="card">
          <div class="card-head"><span class="card-title">当前在家成员</span><span class={`tag ${homePersons > 0 ? 'dark' : ''}`}>{homePersons > 0 ? '在线' : '离家'}</span></div>
          <div class="kpi-val num">{homePersons}<span class="kpi-unit">/ {persons.length} 人</span></div>
          <div class="kpi-sub">支持多人多设备协同判定</div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">活跃追踪设备</span><span class="tag">IRK + MAC</span></div>
          <div class="kpi-val num">{activeDevs}<span class="kpi-unit">/ {allDevs.length} 台</span></div>
          <div class="kpi-sub">随机 MAC 自动解析</div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">选中设备信号</span><span class="tag red">实时</span></div>
          <div class="kpi-val num">{curEma !== null ? Math.round(curEma) : '--'}<span class="kpi-unit">dBm</span></div>
          <div class="kpi-sub">{selectedDev ? `${selectedDev.label} · EMA 平滑` : '暂未选中设备'}</div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">雷达扫描状态</span><span class="tag">NimBLE</span></div>
          <div class="kpi-val num">{nearby.length}<span class="kpi-unit">台附近设备</span></div>
          <div class="kpi-sub">环形日志 {logTotal} / 1000 条</div>
        </div>
      </div>

      <div class="grid g-pres-top grow">
        <div class="card">
          <div class="card-head">
            <span class="card-title">绑定成员与设备</span>
            <span class="tag">点击设备切换曲线</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', flex: 1 }}>
            {persons.map((p) => (
              <div class="person-box" key={p.id}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div class="avatar">{p.name.slice(0, 1).toUpperCase()}</div>
                    <div>
                      <div style={{ fontWeight: 600 }}>{p.name}</div>
                      <div class="kpi-sub">绑定 {p.devices.length} 台设备</div>
                    </div>
                  </div>
                  <div class="btn-row">
                    <span class={`tag ${p.is_home ? 'dark' : ''}`}>{p.is_home ? '在家' : '离家'}</span>
                    <button
                      class="btn btn-sm btn-danger"
                      onClick={async () => {
                        if (!window.confirm(`删除成员「${p.name}」及其所有设备？`)) return;
                        await api.deletePerson(p.id);
                        loadState();
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
                {p.devices.map((d) => (
                  <div class={`dev-row ${selectedDev?.id === d.id ? 'selected' : ''}`} key={d.id} onClick={() => selectDevice(d)}>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 600 }}>
                        {d.label} <span class="tag" style={{ marginLeft: '4px' }}>{d.match_type || 'BLE'}</span>
                      </div>
                      <div class="kpi-sub num">进入 {d.enter_rssi ?? -75} / 离开 {d.exit_rssi ?? -85} · {d.away_timeout_s ?? 120}s</div>
                    </div>
                    <div class="btn-row">
                      <span class="num" style={{ fontWeight: 700 }}>{d.seen_ago_s >= 0 && d.rssi > -120 ? `${d.rssi} dBm` : '--'}</span>
                      <button
                        class="btn btn-sm btn-danger"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!window.confirm(`解绑设备「${d.label}」？`)) return;
                          await api.deleteDevice(d.id);
                          loadState();
                        }}
                      >
                        解绑
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">实时 RSSI 滤波与迟滞校准{selectedDev ? ` · ${selectedDev.label}` : ''}</span>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-line" style={{ background: P.ink }} />EMA 平滑</span>
              <span class="legend-item"><span class="legend-dot" style={{ background: P.lbl }} />Raw 采样</span>
              <span class="legend-item"><span class="legend-line" style={{ background: P.sec }} />进入 {enterThresh}</span>
              <span class="legend-item"><span class="legend-line" style={{ background: P.red }} />离开 {exitThresh}</span>
            </div>
          </div>
          <div class="chart-stats">
            <span class="chart-stat-item">当前 EMA <strong class="num">{curEma !== null ? `${Math.round(curEma)} dBm` : '--'}</strong></span>
            <span class="chart-stat-item">60s 峰值 <strong class="num">{maxEma !== null ? `${Math.round(maxEma)} dBm` : '--'}</strong></span>
            <span class="chart-stat-item">60s 均值 <strong class="num">{avgEma !== null ? `${Math.round(avgEma)} dBm` : '--'}</strong></span>
            <span class="chart-stat-item">判定状态 <strong class={selectedDev?.is_home ? 'red' : ''}>{selectedDev ? (selectedDev.is_home ? '在家' : '离开') : '--'}</strong></span>
          </div>
          <TelemetryChart
            id="chart-ble"
            min={-95}
            max={-45}
            yTicks={[-95, -85, -75, -65, -55, -45]}
            unit=" dBm"
            rawSeries={rawData}
            awayBelow={exitThresh}
            series={[{ label: 'EMA 平滑', color: P.ink, data: emaData, w: 2, fmt: (v) => `${Math.round(v)} dBm` }]}
            refLines={[
              { val: enterThresh, color: P.sec, bg: P.tagBg },
              { val: exitThresh, color: P.red, bg: P.tagRedBg },
            ]}
            themeTick={themeTick}
          />
          <div class="calib-bar">
            <div class="calib-item">
              <label><span>进入阈值</span><strong class="num">{enterThresh} dBm</strong></label>
              <input
                type="range"
                min={-90}
                max={-50}
                disabled={!selectedDev}
                value={enterThresh}
                onInput={(e) => setEnterThresh(Number((e.target as HTMLInputElement).value))}
                onChange={(e) => {
                  const v = Number((e.target as HTMLInputElement).value);
                  setEnterThresh(v);
                  saveThresholds(v, exitThresh, awayTimeout);
                }}
              />
            </div>
            <div class="calib-item">
              <label><span>离开阈值</span><strong class="num">{exitThresh} dBm</strong></label>
              <input
                type="range"
                min={-95}
                max={-60}
                disabled={!selectedDev}
                value={exitThresh}
                onInput={(e) => setExitThresh(Number((e.target as HTMLInputElement).value))}
                onChange={(e) => {
                  const v = Number((e.target as HTMLInputElement).value);
                  setExitThresh(v);
                  saveThresholds(enterThresh, v, awayTimeout);
                }}
              />
            </div>
            <div class="calib-item">
              <label><span>离家超时</span><strong class="num">{awayTimeout} 秒</strong></label>
              <input
                type="range"
                min={30}
                max={300}
                step={10}
                disabled={!selectedDev}
                value={awayTimeout}
                onInput={(e) => setAwayTimeout(Number((e.target as HTMLInputElement).value))}
                onChange={(e) => {
                  const v = Number((e.target as HTMLInputElement).value);
                  setAwayTimeout(v);
                  saveThresholds(enterThresh, exitThresh, v);
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <div class="grid g-2 grow">
        <div class="card">
          <div class="card-head">
            <span class="card-title">附近 BLE 广播雷达</span>
            <span class="tag">实时发现 {nearby.length} 台</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table class="kv-table">
              <thead><tr><th>设备名称 / 地址</th><th>类型</th><th>信号</th><th>操作</th></tr></thead>
              <tbody>
                {nearby.slice(0, 8).map((d) => (
                  <tr key={d.mac}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{d.name || '未知设备'}</div>
                      <div class="kpi-sub num">{d.mac}</div>
                    </td>
                    <td><span class="tag">{d.addr_type}</span></td>
                    <td class="num" style={{ fontWeight: 600 }}>{d.rssi} dBm</td>
                    <td>
                      <button
                        class="btn btn-sm"
                        disabled={persons.length === 0}
                        onClick={() => setBindModal({ open: true, mac: d.mac, label: d.name || 'BLE设备', personId: persons[0]?.id || 0 })}
                      >
                        绑定
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">进出历史日志（LittleFS 1000 条环形存储）</span>
            <div class="btn-row">
              <button class="btn btn-sm" disabled={logPage === 0} onClick={() => { setLogPage(logPage - 1); loadLogs(logPage - 1); }}>上一页</button>
              <button class="btn btn-sm" disabled={(logPage + 1) * 12 >= logTotal} onClick={() => { setLogPage(logPage + 1); loadLogs(logPage + 1); }}>下一页</button>
              <button class="btn btn-sm btn-danger" onClick={async () => { if (window.confirm('确定清空全部进出日志？')) { await api.clearLogs(); loadLogs(0); } }}>清空</button>
            </div>
          </div>
          <table class="kv-table">
            <thead><tr><th>时间</th><th>成员</th><th>事件</th><th>触发设备</th><th>信号</th></tr></thead>
            <tbody>
              {logs.slice(0, 6).map((l) => (
                <tr key={l.seq}>
                  <td class="num">{fmtLogTime(l)}</td>
                  <td>{l.person_name}</td>
                  <td><span class={`tag ${l.event === 'ARRIVE' ? 'dark' : 'red'}`}>{l.event === 'ARRIVE' ? '回家' : '离家'}</span></td>
                  <td>{l.device || '--'}</td>
                  <td class="num">{l.rssi} dBm</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* IRK PAIRING MODAL */}
      {pairModal.open && (
        <div class="modal-backdrop">
          <div class="card modal-card">
            <div class="card-head">
              <span class="card-title">手机蓝牙配对（提取 IRK）</span>
              <button class="btn btn-sm" onClick={() => { if (pairModal.active) api.stopPairing(); setPairModal({ ...pairModal, open: false, active: false }); }}>关闭</button>
            </div>
            <div class="field">
              <label>归属成员</label>
              <select class="input" value={pairModal.personId} onChange={(e) => setPairModal({ ...pairModal, personId: Number((e.target as HTMLSelectElement).value) })}>
                {persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div class="field">
              <label>设备名称</label>
              <input class="input" value={pairModal.label} onInput={(e) => setPairModal({ ...pairModal, label: (e.target as HTMLInputElement).value })} />
            </div>
            {pairModal.active ? (
              <div class="alert alert-ok" style={{ marginBottom: '12px' }}>
                正在广播配对信号（剩余 {pairModal.remaining}s）：请在手机系统蓝牙设置中连接 <b>ESP32S3-Presence</b> 并确认配对。
              </div>
            ) : pairModal.msg ? (
              <div class={`alert ${pairModal.ok ? 'alert-ok' : 'alert-err'}`} style={{ marginBottom: '12px' }}>{pairModal.msg}</div>
            ) : null}
            <div class="btn-row">
              {!pairModal.active ? (
                <button
                  class="btn btn-primary"
                  onClick={async () => {
                    try {
                      await api.startPairing(pairModal.personId, pairModal.label.trim() || '我的手机', 60);
                      setPairModal({ ...pairModal, active: true, remaining: 60, msg: '' });
                    } catch (ex: any) { setErr(ex.message); }
                  }}
                >
                  开启 60s 配对窗口
                </button>
              ) : (
                <button class="btn btn-danger" onClick={() => { api.stopPairing(); setPairModal({ ...pairModal, active: false }); }}>停止配对</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* FIXED MAC BIND MODAL */}
      {bindModal.open && (
        <div class="modal-backdrop">
          <div class="card modal-card">
            <div class="card-head">
              <span class="card-title">绑定固定 MAC 设备</span>
              <button class="btn btn-sm" onClick={() => setBindModal({ ...bindModal, open: false })}>关闭</button>
            </div>
            <div class="field"><label>MAC 地址</label><input class="input num" value={bindModal.mac} readOnly /></div>
            <div class="field">
              <label>归属成员</label>
              <select class="input" value={bindModal.personId} onChange={(e) => setBindModal({ ...bindModal, personId: Number((e.target as HTMLSelectElement).value) })}>
                {persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div class="field">
              <label>设备备注</label>
              <input class="input" value={bindModal.label} onInput={(e) => setBindModal({ ...bindModal, label: (e.target as HTMLInputElement).value })} />
            </div>
            <button
              class="btn btn-primary"
              onClick={async () => {
                try {
                  await api.addFixedDevice({ person_id: bindModal.personId, label: bindModal.label, mac: bindModal.mac, enter_rssi: -75, exit_rssi: -85, away_timeout_s: 120 });
                  setBindModal({ ...bindModal, open: false });
                  loadState();
                } catch (ex: any) { setErr(ex.message); }
              }}
            >
              确认绑定
            </button>
          </div>
        </div>
      )}
    </>
  );
}
