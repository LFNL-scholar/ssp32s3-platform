import { useEffect, useState } from 'preact/hooks';
import { api, NearbyBleDevice, PersonState, PresenceLogEntry, TrackedDevice, wsClient } from '../api/client';
import { LineChart } from '../components/LineChart';

function fmtLogTime(e: PresenceLogEntry) {
  if (e.time_synced && e.timestamp > 0) {
    return new Date(e.timestamp * 1000).toLocaleString('zh-CN', { hour12: false });
  }
  return `开机后 ${e.uptime_s} 秒`;
}

export function Presence() {
  const [persons, setPersons] = useState<PersonState[]>([]);
  const [newPerson, setNewPerson] = useState('');
  const [nearby, setNearby] = useState<NearbyBleDevice[]>([]);
  const [logs, setLogs] = useState<PresenceLogEntry[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [logPage, setLogPage] = useState(0);
  const [err, setErr] = useState('');

  // Selected device for live RSSI chart
  const [chartDevId, setChartDevId] = useState<number | null>(null);
  const [rssiHist, setRssiHist] = useState<Record<number, (number | null)[]>>({});
  const [rawHist, setRawHist] = useState<Record<number, (number | null)[]>>({});

  // Pairing modal
  const [pairModal, setPairModal] = useState<{ open: boolean; personId: number; label: string; active: boolean; remaining: number; msg: string; ok: boolean }>({
    open: false, personId: 0, label: '', active: false, remaining: 60, msg: '', ok: false,
  });

  // Fixed MAC bind modal
  const [bindModal, setBindModal] = useState<{ open: boolean; mac: string; label: string; personId: number }>({
    open: false, mac: '', label: '', personId: 0,
  });

  // Edit device thresholds modal
  const [editDev, setEditDev] = useState<{ id: number; label: string; enter_rssi: number; exit_rssi: number; away_timeout_s: number } | null>(null);

  const loadState = async () => {
    try {
      const res = await api.presenceState();
      setPersons(res.persons);
      if (!chartDevId) {
        const firstDev = res.persons.flatMap((p) => p.devices)[0];
        if (firstDev) setChartDevId(firstDev.id);
      }
    } catch (ex: any) {
      setErr(ex.message);
    }
  };

  const loadScan = async () => {
    try {
      const res = await api.bleScan();
      setNearby(res.devices || []);
    } catch { /* ignore */ }
  };

  const loadLogs = async (page = logPage) => {
    try {
      const res = await api.logs(20, page * 20);
      setLogs(res.logs || []);
      setLogTotal(res.total || 0);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadState();
    loadScan();
    loadLogs(0);

    const unsub = wsClient.subscribe((msg) => {
      if (msg.type === 'presence_tick') {
        setPersons((prev) =>
          msg.persons.map((np) => {
            const oldP = prev.find((p) => p.id === np.id);
            return {
              ...np,
              devices: np.devices.map((nd) => {
                const oldD = oldP?.devices.find((d) => d.id === nd.id);
                return { ...oldD, ...nd };
              }),
            };
          })
        );
        setRssiHist((prev) => {
          const next = { ...prev };
          msg.persons.forEach((p) =>
            p.devices.forEach((d) => {
              const arr = next[d.id] || [];
              next[d.id] = [...arr.slice(-59), d.seen_ago_s >= 0 && d.rssi > -120 ? d.rssi : null];
            })
          );
          return next;
        });
        setRawHist((prev) => {
          const next = { ...prev };
          msg.persons.forEach((p) =>
            p.devices.forEach((d) => {
              const arr = next[d.id] || [];
              next[d.id] = [...arr.slice(-59), d.seen_ago_s >= 0 && d.raw_rssi > -120 ? d.raw_rssi : null];
            })
          );
          return next;
        });
      } else if (msg.type === 'presence_event') {
        loadLogs(0);
      } else if (msg.type === 'pair_result') {
        setPairModal((m) => ({
          ...m,
          active: false,
          ok: msg.status === 'success',
          msg: msg.status === 'success' ? `配对成功！已绑定设备「${msg.label}」` : (msg.reason || '配对未完成'),
        }));
        if (msg.status === 'success') loadState();
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!pairModal.active) return;
    const t = window.setInterval(() => {
      setPairModal((m) => (m.active && m.remaining > 0 ? { ...m, remaining: m.remaining - 1 } : m));
    }, 1000);
    return () => window.clearInterval(t);
  }, [pairModal.active]);

  const addPerson = async (e: Event) => {
    e.preventDefault();
    if (!newPerson.trim()) return;
    setErr('');
    try {
      await api.addPerson(newPerson.trim());
      setNewPerson('');
      await loadState();
    } catch (ex: any) { setErr(ex.message); }
  };

  const renamePerson = async (p: PersonState) => {
    const name = window.prompt('输入新名称', p.name);
    if (!name || name.trim() === p.name) return;
    try {
      await api.renamePerson(p.id, name.trim());
      await loadState();
    } catch (ex: any) { setErr(ex.message); }
  };

  const deletePerson = async (p: PersonState) => {
    if (!window.confirm(`确定删除「${p.name}」及其所有绑定设备？`)) return;
    try {
      await api.deletePerson(p.id);
      await loadState();
    } catch (ex: any) { setErr(ex.message); }
  };

  const deleteDevice = async (d: TrackedDevice) => {
    if (!window.confirm(`确定解绑设备「${d.label}」？`)) return;
    try {
      await api.deleteDevice(d.id);
      await loadState();
    } catch (ex: any) { setErr(ex.message); }
  };

  const startPairing = async () => {
    if (!pairModal.label.trim()) return;
    setErr('');
    try {
      await api.startPairing(pairModal.personId, pairModal.label.trim(), 60);
      setPairModal((m) => ({ ...m, active: true, remaining: 60, msg: '请在手机系统蓝牙设置中连接「SSP32S3-Pair」并确认配对', ok: false }));
    } catch (ex: any) {
      setPairModal((m) => ({ ...m, msg: ex.message, active: false }));
    }
  };

  const stopPairing = async () => {
    await api.stopPairing().catch(() => {});
    setPairModal((m) => ({ ...m, active: false, open: false }));
  };

  const submitFixedBind = async (e: Event) => {
    e.preventDefault();
    if (!bindModal.personId || !bindModal.label.trim()) return;
    try {
      await api.addFixedDevice({
        person_id: bindModal.personId,
        label: bindModal.label.trim(),
        mac: bindModal.mac,
        enter_rssi: -75,
        exit_rssi: -85,
        away_timeout_s: 120,
      });
      setBindModal({ open: false, mac: '', label: '', personId: 0 });
      await loadState();
    } catch (ex: any) { setErr(ex.message); }
  };

  const saveEditDev = async (e: Event) => {
    e.preventDefault();
    if (!editDev) return;
    try {
      await api.updateDevice(editDev.id, {
        label: editDev.label,
        enter_rssi: editDev.enter_rssi,
        exit_rssi: editDev.exit_rssi,
        away_timeout_s: editDev.away_timeout_s,
      });
      setEditDev(null);
      await loadState();
    } catch (ex: any) { setErr(ex.message); }
  };

  const allDevices = persons.flatMap((p) => p.devices.map((d) => ({ ...d, personName: p.name })));
  const selectedDev = allDevices.find((d) => d.id === chartDevId) || allDevices[0];

  return (
    <div class="grid" style={{ gap: '14px' }}>
      {err && <div class="alert alert-err">{err}</div>}

      <div class="card">
        <div class="card-title">
          <span>人员与设备管理</span>
          <form class="row" onSubmit={addPerson}>
            <input
              class="input"
              style={{ width: '160px' }}
              placeholder="输入人员姓名"
              value={newPerson}
              onInput={(e) => setNewPerson((e.target as HTMLInputElement).value)}
            />
            <button class="btn btn-primary btn-sm" type="submit">+ 添加人员</button>
          </form>
        </div>

        {persons.length === 0 ? (
          <div class="dim">暂无人员，请先添加一个人员（例如“自己”或家人姓名），再绑定手机或手环。</div>
        ) : (
          <div class="grid grid-2">
            {persons.map((p) => (
              <div key={p.id} class="card" style={{ background: '#0f172a' }}>
                <div class="card-title">
                  <div class="row">
                    <span>{p.name}</span>
                    <span class={`badge ${p.is_home ? 'badge-green' : 'badge-gray'}`}>
                      {p.is_home ? '在家' : '离开'}
                    </span>
                  </div>
                  <div class="row">
                    <button
                      class="btn btn-sm btn-primary"
                      onClick={() => setPairModal({ open: true, personId: p.id, label: `${p.name}的手机`, active: false, remaining: 60, msg: '', ok: false })}
                    >
                      + 配对手机 (IRK)
                    </button>
                    <button class="btn btn-sm" onClick={() => renamePerson(p)}>改名</button>
                    <button class="btn btn-sm btn-danger" onClick={() => deletePerson(p)}>删除</button>
                  </div>
                </div>

                {p.devices.length === 0 ? (
                  <div class="dim" style={{ fontSize: '12px' }}>未绑定设备。可点击“配对手机”或从下方扫描雷达添加固定 MAC 设备。</div>
                ) : (
                  <div class="grid" style={{ gap: '8px' }}>
                    {p.devices.map((d) => (
                      <div key={d.id} style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg-card)' }}>
                        <div class="row" style={{ justifyContent: 'space-between' }}>
                          <div class="row">
                            <b>{d.label}</b>
                            <span class="badge badge-blue">{d.match_type || 'BLE'}</span>
                            <span class={`badge ${d.is_home ? 'badge-green' : 'badge-gray'}`}>{d.is_home ? '在场' : '离线'}</span>
                          </div>
                          <div class="row">
                            <button class="btn btn-sm" onClick={() => setChartDevId(d.id)}>曲线</button>
                            <button class="btn btn-sm" onClick={() => setEditDev({
                              id: d.id,
                              label: d.label,
                              enter_rssi: d.enter_rssi ?? -75,
                              exit_rssi: d.exit_rssi ?? -85,
                              away_timeout_s: d.away_timeout_s ?? 120,
                            })}>调参</button>
                            <button class="btn btn-sm btn-danger" onClick={() => deleteDevice(d)}>解绑</button>
                          </div>
                        </div>
                        <div class="dim" style={{ fontSize: '12px', marginTop: '4px' }}>
                          平滑 RSSI: <b>{d.seen_ago_s >= 0 ? `${d.rssi} dBm` : '--'}</b> ·
                          最近看到: {d.seen_ago_s >= 0 ? `${d.seen_ago_s}秒前` : '尚未扫描到'} ·
                          阈值: {d.enter_rssi ?? -75}/{d.exit_rssi ?? -85} dBm · 超时 {d.away_timeout_s ?? 120}s
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedDev && (
        <div class="card">
          <div class="card-title">
            <span>实时 RSSI 校准曲线 — {selectedDev.personName} / {selectedDev.label}</span>
            <select
              style={{ width: 'auto' }}
              value={selectedDev.id}
              onChange={(e) => setChartDevId(Number((e.target as HTMLSelectElement).value))}
            >
              {allDevices.map((d) => <option key={d.id} value={d.id}>{d.personName} - {d.label}</option>)}
            </select>
          </div>
          <LineChart
            min={-105}
            max={-30}
            unit=" dBm"
            height={160}
            series={[
              { label: '平滑 RSSI', color: '#38bdf8', data: rssiHist[selectedDev.id] || [] },
              { label: '原始 RSSI', color: '#94a3b8', data: rawHist[selectedDev.id] || [] },
            ]}
            thresholds={[
              { value: selectedDev.enter_rssi ?? -75, label: '到家阈值', color: '#22c55e' },
              { value: selectedDev.exit_rssi ?? -85, label: '离开阈值', color: '#ef4444' },
            ]}
          />
        </div>
      )}

      <div class="card">
        <div class="card-title">
          <span>附近 BLE 扫描雷达（近 30 秒）</span>
          <button class="btn btn-sm" onClick={loadScan}>刷新列表</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>MAC 地址</th><th>类型</th><th>广播名称</th><th>RSSI</th><th>最近出现</th><th>操作</th></tr></thead>
            <tbody>
              {nearby.slice(0, 20).map((d) => (
                <tr key={`${d.mac}-${d.addr_type}`}>
                  <td class="mono">{d.mac}</td>
                  <td><span class="badge badge-gray">{d.addr_type}</span></td>
                  <td>{d.name || <span class="dim">(未广播名称)</span>}</td>
                  <td class="mono">{d.rssi} dBm</td>
                  <td>{d.seen_ago_s}s 前</td>
                  <td>
                    <button
                      class="btn btn-sm"
                      disabled={persons.length === 0}
                      onClick={() => setBindModal({
                        open: true,
                        mac: d.mac,
                        label: d.name || `BLE-${d.mac.slice(-5)}`,
                        personId: persons[0]?.id || 0,
                      })}
                    >
                      绑定固定 MAC
                    </button>
                  </td>
                </tr>
              ))}
              {nearby.length === 0 && <tr><td colSpan={6} class="dim">暂无附近设备，点击右上角刷新</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>进出历史日志（共 {logTotal} 条，最多保留 1000 条）</span>
          <div class="row">
            <button class="btn btn-sm" onClick={() => loadLogs(logPage)}>刷新</button>
            <button class="btn btn-sm btn-danger" onClick={async () => {
              if (window.confirm('确定清空全部历史日志？')) {
                await api.clearLogs();
                loadLogs(0);
              }
            }}>清空日志</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>#</th><th>时间</th><th>人员</th><th>事件</th><th>触发设备</th><th>RSSI</th></tr></thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.seq}>
                  <td class="mono dim">{l.seq}</td>
                  <td class="mono">{fmtLogTime(l)}</td>
                  <td>{l.person_name}</td>
                  <td><span class={`badge ${l.event === 'ARRIVE' ? 'badge-green' : 'badge-amber'}`}>{l.event === 'ARRIVE' ? '到家' : '离开'}</span></td>
                  <td>{l.device}</td>
                  <td class="mono">{l.rssi} dBm</td>
                </tr>
              ))}
              {logs.length === 0 && <tr><td colSpan={6} class="dim">暂无进出记录</td></tr>}
            </tbody>
          </table>
        </div>
        {logTotal > 20 && (
          <div class="row" style={{ justifyContent: 'flex-end', marginTop: '10px' }}>
            <button class="btn btn-sm" disabled={logPage === 0} onClick={() => { setLogPage(logPage - 1); loadLogs(logPage - 1); }}>上一页</button>
            <span class="dim">第 {logPage + 1} 页</span>
            <button class="btn btn-sm" disabled={(logPage + 1) * 20 >= logTotal} onClick={() => { setLogPage(logPage + 1); loadLogs(logPage + 1); }}>下一页</button>
          </div>
        )}
      </div>

      {pairModal.open && (
        <div class="modal-mask">
          <div class="modal">
            <div class="card-title">
              <span>手机蓝牙配对向导 (IRK)</span>
              {pairModal.active && <span class="badge badge-blue">{pairModal.remaining}s</span>}
            </div>
            {pairModal.msg && (
              <div class={`alert ${pairModal.ok ? 'alert-ok' : pairModal.active ? 'alert-info' : 'alert-err'}`}>
                {pairModal.msg}
              </div>
            )}
            {!pairModal.active && !pairModal.ok && (
              <div class="field">
                <label>设备备注名称</label>
                <input class="input" value={pairModal.label} onInput={(e) => setPairModal((m) => ({ ...m, label: (e.target as HTMLInputElement).value }))} />
              </div>
            )}
            <div class="row" style={{ justifyContent: 'flex-end' }}>
              {!pairModal.active && !pairModal.ok && (
                <button class="btn btn-primary" onClick={startPairing}>开始配对广播</button>
              )}
              <button class="btn" onClick={pairModal.active ? stopPairing : () => setPairModal((m) => ({ ...m, open: false }))}>
                {pairModal.active ? '取消配对' : '关闭'}
              </button>
            </div>
          </div>
        </div>
      )}

      {bindModal.open && (
        <div class="modal-mask">
          <form class="modal" onSubmit={submitFixedBind}>
            <div class="card-title">绑定固定 MAC 设备</div>
            <div class="field">
              <label>MAC 地址</label>
              <input class="input mono" value={bindModal.mac} disabled />
            </div>
            <div class="field">
              <label>所属人员</label>
              <select value={bindModal.personId} onChange={(e) => setBindModal((m) => ({ ...m, personId: Number((e.target as HTMLSelectElement).value) }))}>
                {persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div class="field">
              <label>设备名称</label>
              <input class="input" value={bindModal.label} onInput={(e) => setBindModal((m) => ({ ...m, label: (e.target as HTMLInputElement).value }))} required />
            </div>
            <div class="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" class="btn" onClick={() => setBindModal({ open: false, mac: '', label: '', personId: 0 })}>取消</button>
              <button type="submit" class="btn btn-primary">确认绑定</button>
            </div>
          </form>
        </div>
      )}

      {editDev && (
        <div class="modal-mask">
          <form class="modal" onSubmit={saveEditDev}>
            <div class="card-title">调整检测参数</div>
            <div class="field">
              <label>设备名称</label>
              <input class="input" value={editDev.label} onInput={(e) => setEditDev({ ...editDev, label: (e.target as HTMLInputElement).value })} required />
            </div>
            <div class="field">
              <label>到家阈值 (dBm，默认 -75)</label>
              <input class="input" type="number" min="-100" max="-20" value={editDev.enter_rssi} onInput={(e) => setEditDev({ ...editDev, enter_rssi: Number((e.target as HTMLInputElement).value) })} />
            </div>
            <div class="field">
              <label>离开阈值 (dBm，默认 -85)</label>
              <input class="input" type="number" min="-110" max="-30" value={editDev.exit_rssi} onInput={(e) => setEditDev({ ...editDev, exit_rssi: Number((e.target as HTMLInputElement).value) })} />
            </div>
            <div class="field">
              <label>离开确认超时 (秒，默认 120)</label>
              <input class="input" type="number" min="10" max="1800" value={editDev.away_timeout_s} onInput={(e) => setEditDev({ ...editDev, away_timeout_s: Number((e.target as HTMLInputElement).value) })} />
            </div>
            <div class="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" class="btn" onClick={() => setEditDev(null)}>取消</button>
              <button type="submit" class="btn btn-primary">保存</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
