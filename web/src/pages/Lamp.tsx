import { useEffect, useState } from 'preact/hooks';
import { api, LampHistoryResp, LampState, wsClient } from '../api/client';
import { BarItem, LightingBarChart } from '../components/Charts';
import { dateKey, fmtDuration, PeriodMode, periodRange, shiftPeriod, summarize } from '../utils/lampStats';

export function Lamp({ themeTick }: { themeTick: string }) {
  const [st, setSt] = useState<LampState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [learnMsg, setLearnMsg] = useState('');
  const [learnRemain, setLearnRemain] = useState(0);

  const [mode, setMode] = useState<PeriodMode>('week');
  const [anchorDate, setAnchorDate] = useState(() => dateKey(Math.floor(Date.now() / 1000)));
  const [histResp, setHistResp] = useState<LampHistoryResp | null>(null);

  const loadState = async () => {
    try {
      const s = await api.lampState();
      setSt(s);
      if (s.history.time_synced && s.history.now > 0) {
        setAnchorDate((prev) => prev || dateKey(s.history.now));
      }
    } catch (ex: any) { setErr(ex.message); }
  };

  const loadHistory = async (dateStr = anchorDate, m = mode) => {
    const range = periodRange(dateStr, m);
    if (!range) return;
    try {
      const res = await api.lampHistory(range.from, range.to);
      setHistResp(res);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadState();
    return wsClient.subscribe((m) => {
      if (m.type === 'lamp_state') setSt(m);
      else if (m.type === 'lamp_learn') {
        if (m.status === 'listening') {
          setLearnRemain(10);
          setLearnMsg('正在监听 433.92 MHz，请短按原遥控器开关键...');
        } else if (m.status === 'captured') {
          setLearnRemain(0);
          setLearnMsg(`录制成功：${m.pulses} 段脉冲，时长 ${m.duration_ms} ms。请先试播验证后再保存。`);
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
    } catch (ex: any) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  const toggleAuto = async (offAway: boolean, onArrive: boolean) => {
    setErr(''); setMsg('');
    try {
      const res = await api.lampAutomation(offAway, onArrive);
      setSt(res);
      setMsg('蓝牙联动设置已保存');
    } catch (ex: any) { setErr(ex.message); }
  };

  const updateSiri = async (body: { enabled?: boolean; regenerate?: boolean }) => {
    setErr(''); setMsg('');
    try {
      const res = await api.lampSiriConfig(body);
      setSt(res);
      setMsg(body.regenerate ? '已重置 Siri 快捷指令密钥' : 'Siri 快捷指令开关已更新');
    } catch (ex: any) { setErr(ex.message); }
  };

  const copyText = async (text: string, label: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setMsg(`已复制「${label}」Siri 链接`);
    } catch { setErr('复制失败，请手动长按复制'); }
  };

  const siriHost = st?.siri?.hostname ? `${st.siri.hostname}.local` : location.host;
  const siriToken = st?.siri?.token || '';
  const siriBase = `http://${siriHost}/api/lamp/siri?token=${encodeURIComponent(siriToken)}`;
  const lampOn = st?.power_on ?? false;

  const range = periodRange(anchorDate, mode);
  const summary = histResp && range ? summarize(histResp.records, range.from, range.to, histResp.now, histResp.oldest) : null;
  let peakIdx = -1;
  let maxOn = 0;
  summary?.days.forEach((d, i) => {
    if (d.on > maxOn) { maxOn = d.on; peakIdx = i; }
  });

  const barItems: BarItem[] = summary
    ? summary.days.map((d, i) => {
        const k = dateKey(d.start);
        return {
          lbl: mode === 'month' ? k.slice(8) : k.slice(5),
          hours: d.on / 3600,
          events: d.events.length,
          isPeak: i === peakIdx && d.on > 0,
          isToday: k === dateKey(histResp!.now || Math.floor(Date.now() / 1000)),
        };
      })
    : [];

  return (
    <>
      <div class="view-header">
        <div>
          <div class="eyebrow">SUB-GHZ · CC1101 · 433.92 MHz</div>
          <h1 class="view-title">照明控制与自动化</h1>
        </div>
        <div class="btn-row">
          <button class="btn" disabled={busy} onClick={() => doAction('calibrate_on')}>校准为开</button>
          <button class="btn" disabled={busy} onClick={() => doAction('calibrate_off')}>校准为关</button>
          <button class="btn btn-primary" onClick={() => { setLearnMsg(''); api.lampLearnStart().catch((ex: any) => setErr(ex.message)); }}>
            {st?.learning.active ? `监听中 (${learnRemain}s)...` : '录制遥控信号'}
          </button>
        </div>
      </div>

      {msg && <div class="alert alert-ok">{msg}</div>}
      {err && <div class="alert alert-err">{err}</div>}

      <div class="grid g-4">
        <div class="card">
          <div class="card-head"><span class="card-title">当前电源状态</span><span class={`tag ${lampOn ? 'dark' : ''}`}>{st?.power_known ? (lampOn ? '运行中' : '待机') : '待校准'}</span></div>
          <div class="kpi-val">{st?.power_known ? (lampOn ? '已开启' : '已关闭') : '未知'}</div>
          <div class="kpi-sub">最近动作：{st?.last_action || '--'}</div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">统计周期累计</span><span class="tag">{mode === 'day' ? '单日' : mode === 'week' ? '7 日' : '本月'}</span></div>
          <div class="kpi-val num">{summary ? fmtDuration(summary.total) : '--'}</div>
          <div class="kpi-sub">有效记录 {summary?.effectiveDays ?? 0} 天</div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">周期日均时长</span><span class="tag">均值</span></div>
          <div class="kpi-val num">{summary?.average !== null && summary?.average !== undefined ? fmtDuration(summary.average) : '--'}</div>
          <div class="kpi-sub">{st?.history.time_synced ? 'SNTP 校时正常' : '等待 SNTP 对时'}</div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">射频样本状态</span><span class={`tag ${st?.sample_loaded ? 'red' : ''}`}>{st?.sample_loaded ? '就绪' : '未加载'}</span></div>
          <div class="kpi-val num">{st?.power_transmissions ?? 0}<span class="kpi-unit">次发射</span></div>
          <div class="kpi-sub">OOK {st?.sample_mhz?.toFixed(2) ?? '433.92'} MHz · {st?.sample_pulses ?? 0} 段脉冲</div>
        </div>
      </div>

      <div class="grid g-lamp grow">
        <div class="card">
          <div class="card-head">
            <span class="card-title">射频开关核心</span>
            <span class={`tag ${lampOn ? 'dark' : ''}`}>{lampOn ? '已开启' : '待机中'}</span>
          </div>
          <div class="power-center">
            <div class={`power-orb ${lampOn ? 'is-on' : ''}`} role="button" tabIndex={0} style={{ width: '122px', height: '122px', margin: '6px 0 14px' }} onClick={() => !busy && doAction(lampOn ? 'off' : 'on')}>
              <svg class="orb-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="M12 2v10" />
                <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
              </svg>
              <div class="orb-label"><span class="orb-dot" /><span>{lampOn ? 'POWER ON' : 'STANDBY'}</span></div>
            </div>
            <div class="kpi-sub">点击核心立即通过 CC1101 发射 433.92 MHz 脉冲</div>
          </div>

          <div style={{ borderTop: '1px dashed var(--line)', paddingTop: '14px', marginTop: '10px' }}>
            <div style={{ fontSize: '12.5px', fontWeight: 600, marginBottom: '4px' }}>蓝牙自动联动</div>
            <div class="switch-row">
              <div><div class="switch-title">离家自动关灯</div><div class="switch-desc">全员离家超时后自动关闭</div></div>
              <button type="button" class={`toggle ${st?.automation.auto_off_on_away ? 'on' : ''}`} onClick={() => toggleAuto(!(st?.automation.auto_off_on_away ?? false), st?.automation.auto_on_on_arrive ?? false)} />
            </div>
            <div class="switch-row">
              <div><div class="switch-title">回家自动开灯</div><div class="switch-desc">首位成员回家自动开启</div></div>
              <button type="button" class={`toggle ${st?.automation.auto_on_on_arrive ? 'on' : ''}`} onClick={() => toggleAuto(st?.automation.auto_off_on_away ?? false, !(st?.automation.auto_on_on_arrive ?? false))} />
            </div>
          </div>

          <div style={{ borderTop: '1px dashed var(--line)', paddingTop: '12px', marginTop: '12px' }}>
            {learnMsg && <div class="kpi-sub" style={{ marginBottom: '8px', color: 'var(--red)' }}>{learnMsg}</div>}
            <div class="btn-row">
              {st?.learning.pending_ready && (
                <>
                  <button class="btn btn-sm" onClick={() => api.lampLearnTest().catch((ex: any) => setErr(ex.message))}>试播验证</button>
                  <button class="btn btn-sm btn-primary" onClick={() => api.lampLearnSave().then((r) => { setSt(r); setLearnMsg(''); setMsg('新波形已保存'); })}>保存波形</button>
                </>
              )}
              {(st?.learning.active || st?.learning.pending_ready) && (
                <button class="btn btn-sm btn-danger" onClick={() => { api.lampLearnCancel(); setLearnMsg(''); setLearnRemain(0); }}>取消</button>
              )}
              <label class="btn btn-sm" style={{ cursor: 'pointer', marginLeft: 'auto' }}>
                导入备份 (.rf)
                <input
                  type="file"
                  accept=".rf"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (!file) return;
                    try {
                      const resp = await fetch('/api/lamp/sample/upload', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
                      const data = await resp.json();
                      if (!resp.ok || data?.ok === false) throw new Error(data?.error || '导入失败');
                      setSt(data);
                      setMsg(`已导入备份样本（${data.sample_pulses} 段脉冲）`);
                    } catch (ex: any) { setErr(ex.message || '导入失败'); }
                    (e.target as HTMLInputElement).value = '';
                  }}
                />
              </label>
            </div>
          </div>
        </div>

        <div class="grid" style={{ gap: '14px', gridTemplateRows: 'auto 1fr' }}>
          <div class="card">
            <div class="card-head">
              <span class="card-title">Siri 快捷指令（局域网一键控灯 · 3 组指令）</span>
              <div class="btn-row">
                <span style={{ fontSize: '12px', color: 'var(--text-sec)' }}>启用</span>
                <button type="button" class={`toggle ${st?.siri?.enabled ? 'on' : ''}`} onClick={() => updateSiri({ enabled: !(st?.siri?.enabled ?? false) })} />
                <button class="btn btn-sm" onClick={() => window.confirm('重置密钥后旧快捷指令链接将失效，确定重置？') && updateSiri({ regenerate: true })}>重置密钥</button>
              </div>
            </div>
            <div class="kpi-sub">在 iPhone「快捷指令」添加动作「获取 URL 内容」并粘贴下方链接（无需登录，重启不失效）：</div>
            {st?.siri?.enabled && siriToken ? (
              <div class="siri-list">
                <div class="siri-item">
                  <span class="siri-label">开灯指令</span>
                  <span class="siri-url num">{`${siriBase}&action=on`}</span>
                  <button class="btn btn-sm btn-primary" onClick={() => copyText(`${siriBase}&action=on`, '开灯')}>复制</button>
                </div>
                <div class="siri-item">
                  <span class="siri-label">关灯指令</span>
                  <span class="siri-url num">{`${siriBase}&action=off`}</span>
                  <button class="btn btn-sm" onClick={() => copyText(`${siriBase}&action=off`, '关灯')}>复制</button>
                </div>
                <div class="siri-item">
                  <span class="siri-label">切换指令</span>
                  <span class="siri-url num">{`${siriBase}&action=toggle`}</span>
                  <button class="btn btn-sm" onClick={() => copyText(`${siriBase}&action=toggle`, '切换')}>复制</button>
                </div>
              </div>
            ) : (
              <div class="dim" style={{ marginTop: '10px', fontSize: '12px' }}>已关闭 Siri 快捷指令接口，开启后将显示 3 组局域网 URL。</div>
            )}
          </div>

          <div class="card">
            <div class="card-head">
              <span class="card-title">亮灯时长统计（日 / 周 / 月）</span>
              <div class="btn-row">
                <button class="btn btn-sm" onClick={() => setAnchorDate(shiftPeriod(anchorDate, mode, -1))}>←</button>
                <span class="num" style={{ fontSize: '12px', color: 'var(--text-sec)' }}>{anchorDate}</span>
                <button class="btn btn-sm" onClick={() => setAnchorDate(shiftPeriod(anchorDate, mode, 1))}>→</button>
                <button class={`btn btn-sm ${mode === 'day' ? 'btn-primary' : ''}`} onClick={() => setMode('day')}>日</button>
                <button class={`btn btn-sm ${mode === 'week' ? 'btn-primary' : ''}`} onClick={() => setMode('week')}>周</button>
                <button class={`btn btn-sm ${mode === 'month' ? 'btn-primary' : ''}`} onClick={() => setMode('month')}>月</button>
              </div>
            </div>
            <LightingBarChart id="bar-lp" items={barItems} themeTick={themeTick} />
          </div>
        </div>
      </div>
    </>
  );
}
