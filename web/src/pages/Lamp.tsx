import { useEffect, useState } from 'preact/hooks';
import { api, LampHistoryResp, LampState, wsClient } from '../api/client';
import { DAY, dateKey, fmtDuration, fmtTimeHM, PeriodMode, periodRange, shiftPeriod, summarize } from '../utils/lampStats';

const CAUSE_LABELS: Record<number, string> = {
  1: '网页控制',
  2: '状态校准',
  3: '对时同步',
  4: '蓝牙联动',
};

export function Lamp() {
  const [st, setSt] = useState<LampState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Learning UI state
  const [learnMsg, setLearnMsg] = useState('');
  const [learnRemain, setLearnRemain] = useState(0);

  // History stats state
  const [mode, setMode] = useState<PeriodMode>('day');
  const [anchorDate, setAnchorDate] = useState(() => dateKey(Math.floor(Date.now() / 1000)));
  const [histResp, setHistResp] = useState<LampHistoryResp | null>(null);

  const loadState = async () => {
    try {
      const s = await api.lampState();
      setSt(s);
      if (s.history.time_synced && s.history.now > 0) {
        setAnchorDate((prev) => prev || dateKey(s.history.now));
      }
    } catch (ex: any) {
      setErr(ex.message);
    }
  };

  const loadHistory = async (dateStr = anchorDate, m = mode) => {
    const range = periodRange(dateStr, m);
    if (!range) return;
    try {
      const res = await api.lampHistory(range.from, range.to);
      setHistResp(res);
    } catch { /* ignore when clock not synced */ }
  };

  useEffect(() => {
    loadState();
    return wsClient.subscribe((m) => {
      if (m.type === 'lamp_state') {
        setSt(m);
      } else if (m.type === 'lamp_learn') {
        if (m.status === 'listening') {
          setLearnRemain(10);
          setLearnMsg('正在监听 433.92 MHz，请短按原遥控器开关键...');
        } else if (m.status === 'captured') {
          setLearnRemain(0);
          setLearnMsg(`录制成功：${m.pulses} 段脉冲，时长 ${m.duration_ms} ms。请先点击“试播验证”，确认台灯能开关后再保存。`);
        } else {
          setLearnRemain(0);
          setLearnMsg(m.error || '录制未成功，请重试');
        }
      }
    });
  }, []);

  useEffect(() => {
    loadHistory(anchorDate, mode);
  }, [anchorDate, mode, st?.power_transmissions, st?.power_known]);

  useEffect(() => {
    if (learnRemain <= 0) return;
    const t = window.setInterval(() => setLearnRemain((v) => (v > 0 ? v - 1 : 0)), 1000);
    return () => window.clearInterval(t);
  }, [learnRemain]);

  const doAction = async (action: 'on' | 'off' | 'calibrate_on' | 'calibrate_off') => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const res = await api.lampAction(action);
      setSt(res);
      if (action === 'calibrate_on') setMsg('已校准：当前台灯为开启状态');
      else if (action === 'calibrate_off') setMsg('已校准：当前台灯为关闭状态');
      else setMsg(res.transmitted ? (action === 'on' ? '已发送开灯信号' : '已发送关灯信号') : '当前已是目标状态，未重复发射');
    } catch (ex: any) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleAuto = async (offAway: boolean, onArrive: boolean) => {
    setErr(''); setMsg('');
    try {
      const res = await api.lampAutomation(offAway, onArrive);
      setSt(res);
      setMsg('蓝牙联动设置已保存');
    } catch (ex: any) { setErr(ex.message); }
  };

  const range = periodRange(anchorDate, mode);
  const summary = histResp && range
    ? summarize(histResp.records, range.from, range.to, histResp.now || Math.floor(Date.now() / 1000), histResp.oldest)
    : null;
  const maxDayOn = summary ? Math.max(60, ...summary.days.map((d) => d.on)) : 3600;

  return (
    <div class="grid" style={{ gap: '14px' }}>
      {msg && <div class="alert alert-ok">{msg}</div>}
      {err && <div class="alert alert-err">{err}</div>}

      <div class="grid grid-2">
        <div class="card">
          <div class="card-title">
            <span>433MHz 台灯控制</span>
            <div class="row">
              <span class={`badge ${st?.radio_ready ? 'badge-green' : 'badge-red'}`}>
                {st?.radio_ready ? 'CC1101 就绪' : 'CC1101 未连接'}
              </span>
              <span class={`badge ${st?.sample_loaded ? 'badge-blue' : 'badge-amber'}`}>
                {st?.sample_loaded ? `已加载 (${st.sample_pulses} 脉冲)` : '未加载信号样本'}
              </span>
            </div>
          </div>

          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <div class="dim" style={{ fontSize: '12px' }}>当前推算状态</div>
            <div class="stat-val" style={{ color: !st?.power_known ? 'var(--amber)' : st.power_on ? 'var(--green)' : 'var(--text-dim)' }}>
              {!st?.power_known ? '未校准（重启后需校准）' : st.power_on ? '已开灯' : '已关灯'}
            </div>
            <div class="row" style={{ justifyContent: 'center', marginTop: '14px', gap: '12px' }}>
              <button
                class="btn btn-primary"
                style={{ minWidth: '120px', padding: '10px 20px', fontSize: '15px' }}
                disabled={busy || !st?.radio_ready || !st?.sample_loaded || !st?.power_known}
                onClick={() => doAction('on')}
              >
                开灯
              </button>
              <button
                class="btn"
                style={{ minWidth: '120px', padding: '10px 20px', fontSize: '15px' }}
                disabled={busy || !st?.radio_ready || !st?.sample_loaded || !st?.power_known}
                onClick={() => doAction('off')}
              >
                关灯
              </button>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '12px', marginTop: '8px' }}>
            <div class="dim" style={{ fontSize: '12px', marginBottom: '8px' }}>
              原遥控器为单一切换命令（无状态回传）。重启后或使用原遥控器/触控操作后，请按台灯实际状态校准：
            </div>
            <div class="row">
              <button class="btn btn-sm" disabled={busy} onClick={() => doAction('calibrate_on')}>校准：当前是开灯</button>
              <button class="btn btn-sm" disabled={busy} onClick={() => doAction('calibrate_off')}>校准：当前是关灯</button>
              <span class="dim" style={{ fontSize: '12px', marginLeft: 'auto' }}>累计发射：{st?.power_transmissions ?? 0} 次</span>
            </div>
          </div>
        </div>

        <div class="grid" style={{ gap: '14px', alignContent: 'start' }}>
          <div class="card">
            <div class="card-title">
              <span>遥控信号学习</span>
              {learnRemain > 0 && <span class="badge badge-blue">监听中 {learnRemain}s</span>}
            </div>
            <p class="dim" style={{ marginTop: 0, fontSize: '12px' }}>
              将原台灯遥控器靠近 CC1101 天线（约 0.5–1.5m），点击开始录制后短按开关键，再试播确认并保存为 <span class="mono">power_sample_1.rf</span>。
            </p>
            {learnMsg && <div class="alert alert-info">{learnMsg}</div>}
            <div class="row">
              <button
                class="btn btn-primary btn-sm"
                disabled={!st?.radio_ready || st?.learning.active}
                onClick={async () => {
                  setErr('');
                  try { await api.lampLearnStart(); } catch (ex: any) { setErr(ex.message); }
                }}
              >
                1. 开始录制 (10s)
              </button>
              <button
                class="btn btn-sm"
                disabled={!st?.learning.pending_ready || st?.learning.active}
                onClick={async () => {
                  setErr('');
                  try {
                    await api.lampLearnTest();
                    setMsg('已试播刚录制的信号，请观察台灯是否响应');
                  } catch (ex: any) { setErr(ex.message); }
                }}
              >
                2. 试播验证
              </button>
              <button
                class="btn btn-primary btn-sm"
                disabled={!st?.learning.pending_ready || st?.learning.active}
                onClick={async () => {
                  setErr('');
                  try {
                    const r = await api.lampLearnSave();
                    setSt(r);
                    setLearnMsg('');
                    setMsg('新遥控信号已保存并生效！');
                  } catch (ex: any) { setErr(ex.message); }
                }}
              >
                3. 保存生效
              </button>
              {(st?.learning.active || st?.learning.pending_ready) && (
                <button class="btn btn-sm btn-danger" onClick={() => { api.lampLearnCancel(); setLearnMsg(''); setLearnRemain(0); }}>
                  取消
                </button>
              )}
              <label class="btn btn-sm" style={{ marginLeft: 'auto', cursor: 'pointer' }}>
                导入备份 (.rf)
                <input
                  type="file"
                  accept=".rf"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (!file) return;
                    setErr(''); setMsg('');
                    try {
                      const resp = await fetch('/api/lamp/sample/upload', {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: file,
                      });
                      const data = await resp.json();
                      if (!resp.ok || data?.ok === false) throw new Error(data?.error || '导入失败');
                      setSt(data);
                      setMsg(`已导入备份样本（${data.sample_pulses} 段脉冲）`);
                    } catch (ex: any) {
                      setErr(ex.message || '导入失败');
                    }
                    (e.target as HTMLInputElement).value = '';
                  }}
                />
              </label>
            </div>
          </div>

          <div class="card">
            <div class="card-title">蓝牙在家检测联动</div>
            <p class="dim" style={{ marginTop: 0, fontSize: '12px' }}>
              仅当台灯状态已校准且已加载信号样本时才会自动执行，防止推算状态反向导致误操作。
            </p>
            <div class="grid" style={{ gap: '8px' }}>
              <label class="row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={st?.automation.auto_off_on_away ?? false}
                  onChange={(e) => toggleAuto((e.target as HTMLInputElement).checked, st?.automation.auto_on_on_arrive ?? false)}
                />
                <span>最后一人离开家时自动关灯</span>
              </label>
              <label class="row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={st?.automation.auto_on_on_arrive ?? false}
                  onChange={(e) => toggleAuto(st?.automation.auto_off_on_away ?? false, (e.target as HTMLInputElement).checked)}
                />
                <span>第一人回到家时自动开灯</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>用灯统计与时间轴（北京时间 UTC+8）</span>
          <div class="row">
            {(['day', 'week', 'month'] as PeriodMode[]).map((m) => (
              <button key={m} class={`btn btn-sm ${mode === m ? 'btn-primary' : ''}`} onClick={() => setMode(m)}>
                {m === 'day' ? '日' : m === 'week' ? '周' : '月'}
              </button>
            ))}
            <button class="btn btn-sm" onClick={() => setAnchorDate(shiftPeriod(anchorDate, mode, -1))}>上一期</button>
            <span class="mono" style={{ fontSize: '12px' }}>{anchorDate}</span>
            <button class="btn btn-sm" onClick={() => setAnchorDate(shiftPeriod(anchorDate, mode, 1))}>下一期</button>
            <button class="btn btn-sm" onClick={() => setAnchorDate(dateKey(st?.history.now || Math.floor(Date.now() / 1000)))}>今天</button>
          </div>
        </div>

        {!st?.history.time_synced ? (
          <div class="alert alert-info">等待 SNTP 网络对时完成后开始记录与展示用灯统计（灯光控制不受影响）。</div>
        ) : summary ? (
          <div>
            <div class="grid grid-4" style={{ marginBottom: '14px' }}>
              <div class="card" style={{ background: '#0f172a', padding: '10px 12px' }}>
                <div class="stat-sub">本期总开灯时长</div>
                <div class="stat-val" style={{ fontSize: '18px' }}>{fmtDuration(summary.total)}</div>
              </div>
              <div class="card" style={{ background: '#0f172a', padding: '10px 12px' }}>
                <div class="stat-sub">有效记录天数</div>
                <div class="stat-val" style={{ fontSize: '18px' }}>{summary.effectiveDays} 天</div>
              </div>
              <div class="card" style={{ background: '#0f172a', padding: '10px 12px' }}>
                <div class="stat-sub">有效日均时长</div>
                <div class="stat-val" style={{ fontSize: '18px' }}>{summary.average !== null ? fmtDuration(summary.average) : '--'}</div>
              </div>
              <div class="card" style={{ background: '#0f172a', padding: '10px 12px' }}>
                <div class="stat-sub">未知/断电时长</div>
                <div class="stat-val" style={{ fontSize: '18px' }}>{fmtDuration(summary.unknown)}</div>
              </div>
            </div>

            {mode === 'day' && summary.days[0] && (
              <div>
                <div class="dim" style={{ fontSize: '12px', marginBottom: '6px' }}>24 小时状态时间轴（绿=开灯，深蓝=关灯，灰=未知/未到）</div>
                <div style={{ display: 'flex', height: '24px', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border)', background: '#0f172a' }}>
                  {summary.days[0].segments.map((seg, idx) => {
                    const pct = ((seg.end - seg.start) / DAY) * 100;
                    const bg = seg.power === 1 ? '#22c55e' : seg.power === 0 ? '#1e3a5f' : seg.power === 'future' ? '#0f172a' : '#475569';
                    return (
                      <div
                        key={idx}
                        title={`${fmtTimeHM(seg.start)} - ${fmtTimeHM(seg.end)}: ${seg.power === 1 ? '开灯' : seg.power === 0 ? '关灯' : '未知'}`}
                        style={{ width: `${pct}%`, background: bg, height: '100%' }}
                      />
                    );
                  })}
                </div>
                <div class="row dim" style={{ justifyContent: 'space-between', fontSize: '11px', marginTop: '4px', marginBottom: '12px' }}>
                  <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
                </div>

                <div class="table-wrap">
                  <table>
                    <thead><tr><th>时间</th><th>状态</th><th>来源</th></tr></thead>
                    <tbody>
                      {summary.days[0].events.slice().reverse().map((ev, i) => (
                        <tr key={i}>
                          <td class="mono">{fmtTimeHM(ev.at)}</td>
                          <td><span class={`badge ${ev.power ? 'badge-green' : 'badge-gray'}`}>{ev.power ? '开灯' : '关灯'}</span></td>
                          <td>{CAUSE_LABELS[ev.cause] || '其他'}</td>
                        </tr>
                      ))}
                      {summary.days[0].events.length === 0 && <tr><td colSpan={3} class="dim">当日暂无开关或校准事件</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {mode !== 'day' && (
              <div class="grid" style={{ gap: '6px' }}>
                {summary.days.map((d) => (
                  <div key={d.start} class="row" style={{ gap: '10px', fontSize: '12px' }}>
                    <span class="mono dim" style={{ width: '86px' }}>{dateKey(d.start)}</span>
                    <div class="bar-bg" style={{ flex: 1, marginTop: 0, height: '12px' }}>
                      <div class="bar-fill" style={{ width: `${Math.min(100, (d.on / maxDayOn) * 100)}%`, background: 'var(--green)' }} />
                    </div>
                    <span class="mono" style={{ width: '80px', textAlign: 'right' }}>
                      {d.known > 0 ? fmtDuration(d.on) : (d.future ? '--' : '无记录')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : <div class="dim">加载中...</div>}
      </div>
    </div>
  );
}
