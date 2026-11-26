import { useEffect, useState } from 'preact/hooks';
import { api, EnvHistoryResp, EnvState, NearbyBleDevice, wsClient } from '../api/client';
import { EnvTrendChart } from '../components/Charts';
import { chartPalette } from '../utils/theme';

interface Props {
  themeTick: string;
  hostLabel: string;
}

function rssiBars(rssi: number | null): number {
  if (rssi === null || rssi <= -120) return 0;
  if (rssi >= -62) return 4;
  if (rssi >= -74) return 3;
  if (rssi >= -86) return 2;
  return 1;
}

function fmtAge(sec: number): string {
  if (sec < 0) return '尚未收到';
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒前`;
  return `${Math.floor(sec / 3600)} 小时前`;
}

function calcDewPoint(tempC: number, humPct: number): number | null {
  if (humPct <= 0) return null;
  const a = 17.62;
  const b = 243.12;
  const gamma = (a * tempC) / (b + tempC) + Math.log(humPct / 100);
  return (b * gamma) / (a - gamma);
}

function statusText(st: 'low' | 'ok' | 'high' | 'unknown', kind: 'temp' | 'hum'): string {
  if (st === 'unknown') return '等待读数';
  if (st === 'ok') return '舒适区间';
  if (kind === 'temp') return st === 'high' ? '高于上限' : '低于下限';
  return st === 'high' ? '偏潮湿' : '偏干燥';
}

export function Environment({ themeTick, hostLabel }: Props) {
  const [st, setSt] = useState<EnvState | null>(null);
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('24h');
  const [hist, setHist] = useState<EnvHistoryResp | null>(null);
  const [nearby, setNearby] = useState<NearbyBleDevice[]>([]);
  const [showScan, setShowScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; err?: boolean } | null>(null);
  const [copiedKey, setCopiedKey] = useState('');
  const [siriTestMsg, setSiriTestMsg] = useState('');

  // Config form
  const [enabled, setEnabled] = useState(true);
  const [name, setName] = useState('小米温湿度计 3 mini');
  const [mac, setMac] = useState('A4:C1:38:D0:8B:34');
  const [bindkey, setBindkey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [tempLow, setTempLow] = useState('18');
  const [tempHigh, setTempHigh] = useState('28');
  const [humLow, setHumLow] = useState('35');
  const [humHigh, setHumHigh] = useState('65');
  const [dirty, setDirty] = useState(false);

  const flash = (text: string, err = false) => {
    setNotice({ text, err });
    window.setTimeout(() => {
      setNotice((cur) => (cur?.text === text ? null : cur));
    }, 3400);
  };

  const hydrate = (s: EnvState, force = false) => {
    if (!force && dirty) return;
    setEnabled(s.enabled);
    setName(s.name);
    setMac(s.mac);
    setTempLow(String(s.thresholds.temp_low));
    setTempHigh(String(s.thresholds.temp_high));
    setHumLow(String(s.thresholds.hum_low));
    setHumHigh(String(s.thresholds.hum_high));
  };

  const loadHistory = (r: '24h' | '7d' | '30d' = range) => {
    api.envHistory(r).then(setHist).catch(() => {});
  };

  useEffect(() => {
    api.envState()
      .then((s) => {
        setSt(s);
        hydrate(s, true);
      })
      .catch((e) => flash(e instanceof Error ? e.message : '加载环境状态失败', true));
    loadHistory('24h');

    const unsub = wsClient.subscribe((msg) => {
      if (msg.type === 'env_state') {
        setSt((prev) => ({ ...msg, siri: prev?.siri }));
      }
    });
    return unsub;
  }, []);

  const switchRange = (r: '24h' | '7d' | '30d') => {
    setRange(r);
    loadHistory(r);
  };

  const saveConfig = async () => {
    setBusy(true);
    try {
      const payload: Parameters<typeof api.envConfig>[0] = {
        enabled,
        name: name.trim(),
        mac: mac.trim().toUpperCase(),
        temp_low: Number(tempLow),
        temp_high: Number(tempHigh),
        hum_low: Number(humLow),
        hum_high: Number(humHigh),
      };
      const cleanKey = bindkey.replace(/[\s:-]/g, '');
      if (cleanKey.length > 0) {
        payload.bindkey = cleanKey;
      }
      const res = await api.envConfig(payload);
      setSt(res);
      setBindkey('');
      setDirty(false);
      hydrate(res, true);
      flash(cleanKey ? '传感器配置与 Bindkey 已保存至 NVS，等待下一次广播解密' : '传感器配置已保存至 NVS');
    } catch (e) {
      flash(e instanceof Error ? e.message : '保存配置失败', true);
    } finally {
      setBusy(false);
    }
  };

  const clearBindkey = async () => {
    setBusy(true);
    try {
      const res = await api.envConfig({ clear_bindkey: true });
      setSt(res);
      setBindkey('');
      flash('已清除已保存的 Bindkey');
    } catch (e) {
      flash(e instanceof Error ? e.message : '清除失败', true);
    } finally {
      setBusy(false);
    }
  };

  const scanBle = async () => {
    try {
      const res = await api.bleScan();
      setNearby(res.devices || []);
      setShowScan(true);
    } catch (e) {
      flash(e instanceof Error ? e.message : '读取附近蓝牙列表失败', true);
    }
  };

  const clearHistory = async () => {
    if (!window.confirm('确认清空 Flash 中保存的所有历史温湿度采样记录？')) return;
    setBusy(true);
    try {
      await api.envClearHistory();
      loadHistory(range);
      const s = await api.envState();
      setSt(s);
      flash('历史温湿度记录已清空');
    } catch (e) {
      flash(e instanceof Error ? e.message : '清空失败', true);
    } finally {
      setBusy(false);
    }
  };

  const updateSiri = async (patch: { enabled?: boolean; regenerate?: boolean }) => {
    setBusy(true);
    try {
      const lampRes = await api.lampSiriConfig(patch);
      setSt((prev) => (prev && lampRes.siri ? { ...prev, siri: { enabled: lampRes.siri.enabled, token: lampRes.siri.token } } : prev));
      flash(patch.regenerate ? 'Siri 查询密钥已重置' : lampRes.siri?.enabled ? 'Siri 快捷指令已启用' : 'Siri 快捷指令已停用');
    } catch (e) {
      flash(e instanceof Error ? e.message : '更新 Siri 配置失败', true);
    } finally {
      setBusy(false);
    }
  };

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((c) => (c === key ? '' : c)), 1800);
  };

  const testSiriQuery = async () => {
    if (!st?.siri?.token) return;
    try {
      const resp = await fetch(`/api/env/siri?token=${encodeURIComponent(st.siri.token)}`);
      const data = await resp.json();
      setSiriTestMsg(data.message || data.error || '无返回');
    } catch (e) {
      setSiriTestMsg(e instanceof Error ? e.message : '请求失败');
    }
  };

  const P = chartPalette();
  const bars = rssiBars(st?.rssi ?? null);
  const dewPt = st?.valid && st.temp_c !== null && st.humidity !== null ? calcDewPoint(st.temp_c, st.humidity) : null;

  const tempMeterPct = st?.temp_c !== null && st?.temp_c !== undefined
    ? Math.max(0, Math.min(100, ((st.temp_c - 10) / 30) * 100))
    : 0;
  const humMeterPct = st?.humidity !== null && st?.humidity !== undefined
    ? Math.max(0, Math.min(100, st.humidity))
    : 0;

  const tempPts = (hist?.points || []).map((pt) => ({ epoch: pt[0], val: pt[1] }));
  const humPts = (hist?.points || []).map((pt) => ({ epoch: pt[0], val: pt[2] }));

  const originBase = typeof window !== 'undefined' ? window.location.origin : `http://${hostLabel}`;
  const lanBase = `http://${hostLabel}`;
  const siriToken = st?.siri?.token || '';
  const originSiriUrl = `${originBase}/api/env/siri?token=${siriToken}`;
  const lanSiriUrl = `${lanBase}/api/env/siri?token=${siriToken}`;

  return (
    <>
      <header class="view-header">
        <div>
          <div class="eyebrow">BLE MIBEACON V5 · AES-128-CCM</div>
          <h1 class="view-title">环境监测 · 小米温湿度计 3 mini</h1>
        </div>
        <div class="btn-row">
          <span class="tag">{st?.mac || 'A4:C1:38:D0:8B:34'}</span>
          <span class={`tag ${st?.comfort.alert ? 'red' : st?.valid ? 'dark' : ''}`}>
            {st?.comfort.label || '加载中'}
          </span>
        </div>
      </header>

      {notice && (
        <div class={`alert ${notice.err ? 'alert-err' : 'alert-ok'}`}>{notice.text}</div>
      )}

      {st && !st.has_bindkey && (
        <div class="alert alert-err">
          尚未配置 32 位 <strong>Bindkey</strong>：请在下方「传感器与舒适阈值配置」中粘贴你从米家提取的 <code>BLE KEY</code> 并保存，S3 即可自动解密广播温湿度。
        </div>
      )}

      {st && st.has_bindkey && st.last_error && (
        <div class="alert alert-err">{st.last_error}</div>
      )}

      {/* KPI ROW */}
      <div class="grid g-4">
        <div class="card">
          <div class="card-head">
            <span class="card-title">室内温度</span>
            <span class={`tag ${st?.comfort.temp_status === 'high' || st?.comfort.temp_status === 'low' ? 'red' : st?.valid ? 'dark' : ''}`}>
              {statusText(st?.comfort.temp_status ?? 'unknown', 'temp')}
            </span>
          </div>
          <div class="kpi-val num">
            {st?.temp_c !== null && st?.temp_c !== undefined ? st.temp_c.toFixed(1) : '--'}
            <span class="kpi-unit">°C</span>
          </div>
          <div class="kpi-sub num">
            舒适阈值 {st?.thresholds.temp_low ?? 18} – {st?.thresholds.temp_high ?? 28} °C
          </div>
          <div class="meter">
            <div class={`meter-fill ${st?.comfort.temp_status === 'high' || st?.comfort.temp_status === 'low' ? 'red' : ''}`} style={{ width: `${tempMeterPct}%` }} />
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">室内相对湿度</span>
            <span class={`tag ${st?.comfort.hum_status === 'high' || st?.comfort.hum_status === 'low' ? 'red' : st?.valid ? 'dark' : ''}`}>
              {statusText(st?.comfort.hum_status ?? 'unknown', 'hum')}
            </span>
          </div>
          <div class="kpi-val num">
            {st?.humidity !== null && st?.humidity !== undefined ? st.humidity.toFixed(1) : '--'}
            <span class="kpi-unit">%RH</span>
          </div>
          <div class="kpi-sub num">
            舒适阈值 {st?.thresholds.hum_low ?? 35} – {st?.thresholds.hum_high ?? 65} %
          </div>
          <div class="meter">
            <div class={`meter-fill ${st?.comfort.hum_status === 'high' || st?.comfort.hum_status === 'low' ? 'red' : ''}`} style={{ width: `${humMeterPct}%` }} />
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">舒适态势与露点</span>
            <span class={`tag ${st?.comfort.alert ? 'red' : st?.valid ? 'dark' : ''}`}>
              {st?.comfort.label || '--'}
            </span>
          </div>
          <div class="kpi-val num">
            {dewPt !== null ? dewPt.toFixed(1) : '--'}
            <span class="kpi-unit">°C 露点</span>
          </div>
          <div class="kpi-sub num">
            已落盘 {st?.history.count ?? 0} / {st?.history.max_records ?? 8640} 条（5 分钟采样）
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">电池与 BLE 链路</span>
            <span class={`tag ${st?.battery_pct !== null && st?.battery_pct !== undefined && st.battery_pct <= 15 ? 'red' : ''}`}>
              {st?.battery_pct !== null && st?.battery_pct !== undefined ? `电量 ${st.battery_pct}%` : '电量未知'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '2px 0 5px' }}>
            <div class="kpi-val num" style={{ margin: 0 }}>
              {st?.rssi !== null && st?.rssi !== undefined ? st.rssi : '--'}
              <span class="kpi-unit">dBm</span>
            </div>
            <div class="sig-wrap">
              <div class="sig-bars">
                {[1, 2, 3, 4].map((b) => (
                  <span
                    key={b}
                    class={`sig-bar ${b <= bars ? (bars === 1 ? 'red' : 'on') : ''}`}
                    style={{ height: `${b * 3}px` }}
                  />
                ))}
              </div>
            </div>
          </div>
          <div class="kpi-sub num">
            更新：{fmtAge(st?.seen_ago_s ?? -1)} · 解密 {st?.decrypt_ok ?? 0} / 失败 {st?.decrypt_fail ?? 0}
          </div>
        </div>
      </div>

      {/* HISTORY CHARTS */}
      <div class="card">
        <div class="card-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <span class="card-title">历史趋势曲线（LittleFS 持久化）</span>
            <div class="env-seg" role="group" aria-label="历史时间范围">
              {([
                ['24h', '24 小时'],
                ['7d', '7 天'],
                ['30d', '30 天'],
              ] as const).map(([val, lbl]) => (
                <button
                  key={val}
                  type="button"
                  class={`theme-btn ${range === val ? 'active' : ''}`}
                  onClick={() => switchRange(val)}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>
          <div class="btn-row">
            <button class="btn btn-sm" onClick={() => loadHistory(range)}>刷新</button>
            <button class="btn btn-sm btn-danger" disabled={busy || (hist?.count ?? 0) === 0} onClick={clearHistory}>清空历史</button>
          </div>
        </div>

        <div class="chart-stats">
          <span class="chart-stat-item">
            温度范围 <strong class="num">{hist?.stats.temp_min !== null && hist?.stats.temp_min !== undefined ? `${hist.stats.temp_min.toFixed(1)} ~ ${hist.stats.temp_max?.toFixed(1)} °C` : '--'}</strong>
          </span>
          <span class="chart-stat-item">
            温度均值 <strong class="num red">{hist?.stats.temp_avg !== null && hist?.stats.temp_avg !== undefined ? `${hist.stats.temp_avg.toFixed(1)} °C` : '--'}</strong>
          </span>
          <span class="chart-stat-item">
            湿度范围 <strong class="num">{hist?.stats.hum_min !== null && hist?.stats.hum_min !== undefined ? `${hist.stats.hum_min.toFixed(1)} ~ ${hist.stats.hum_max?.toFixed(1)} %` : '--'}</strong>
          </span>
          <span class="chart-stat-item">
            湿度均值 <strong class="num">{hist?.stats.hum_avg !== null && hist?.stats.hum_avg !== undefined ? `${hist.stats.hum_avg.toFixed(1)} %` : '--'}</strong>
          </span>
          <span class="chart-stat-item">
            采样点 <strong class="num">{hist?.count ?? 0}</strong>
          </span>
        </div>

        <div class="grid g-2">
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-sec)', marginBottom: '6px' }}>
              <span>温度趋势 (°C)</span>
              <span class="num">阈值 {st?.thresholds.temp_low ?? 18} / {st?.thresholds.temp_high ?? 28} °C</span>
            </div>
            <EnvTrendChart
              id="env-temp"
              label="室内温度"
              unit="°C"
              points={tempPts}
              range={range}
              isRed
              themeTick={themeTick}
              refLines={st ? [
                { val: st.thresholds.temp_high, color: P.red },
                { val: st.thresholds.temp_low, color: P.sec },
              ] : []}
            />
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-sec)', marginBottom: '6px' }}>
              <span>湿度趋势 (%RH)</span>
              <span class="num">阈值 {st?.thresholds.hum_low ?? 35} / {st?.thresholds.hum_high ?? 65} %</span>
            </div>
            <EnvTrendChart
              id="env-hum"
              label="室内湿度"
              unit="%"
              points={humPts}
              range={range}
              minFloor={0}
              maxCeil={100}
              themeTick={themeTick}
              refLines={st ? [
                { val: st.thresholds.hum_high, color: P.red },
                { val: st.thresholds.hum_low, color: P.sec },
              ] : []}
            />
          </div>
        </div>
      </div>

      {/* CONFIG & SIRI */}
      <div class="grid g-2">
        <div class="card">
          <div class="card-head">
            <span class="card-title">传感器与舒适阈值配置</span>
            <div class="btn-row">
              <span class={`tag ${enabled ? 'dark' : ''}`}>{enabled ? '监听中' : '已停用'}</span>
              <button
                type="button"
                class={`toggle ${enabled ? 'on' : ''}`}
                onClick={() => { setEnabled(!enabled); setDirty(true); }}
              />
            </div>
          </div>

          <div class="grid g-2">
            <div class="field">
              <label>传感器名称</label>
              <input class="input" value={name} onInput={(e) => { setName((e.target as HTMLInputElement).value); setDirty(true); }} />
            </div>
            <div class="field">
              <label>蓝牙 MAC 地址</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input class="input num" value={mac} onInput={(e) => { setMac((e.target as HTMLInputElement).value); setDirty(true); }} />
                <button type="button" class="btn btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={scanBle}>附近扫描</button>
              </div>
            </div>
          </div>

          {showScan && (
            <div class="person-box" style={{ marginBottom: '12px', maxHeight: '160px', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', fontWeight: 600 }}>附近 BLE 设备（点击快速填入 MAC）</span>
                <button class="btn btn-sm" onClick={() => setShowScan(false)}>收起</button>
              </div>
              {nearby.length === 0 ? (
                <div class="dim" style={{ fontSize: '12px' }}>暂未扫描到附近蓝牙广播</div>
              ) : (
                nearby.slice(0, 12).map((d) => (
                  <div
                    key={d.mac}
                    class={`dev-row ${d.mac === mac.toUpperCase() ? 'selected' : ''}`}
                    style={{ padding: '6px 10px' }}
                    onClick={() => { setMac(d.mac); setDirty(true); setShowScan(false); }}
                  >
                    <div>
                      <span style={{ fontSize: '12.5px', fontWeight: 600 }}>{d.name || '未命名设备'}</span>
                      <span class="kpi-sub num" style={{ marginLeft: '8px' }}>{d.mac}</span>
                    </div>
                    <span class="num" style={{ fontSize: '12px', fontWeight: 600 }}>{d.rssi} dBm</span>
                  </div>
                ))
              )}
            </div>
          )}

          <div class="field">
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>MiBeacon Bindkey（32 位十六进制）</span>
              <span class="tag">{st?.has_bindkey ? '已存储于 NVS' : '未设置'}</span>
            </label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                type={showKey ? 'text' : 'password'}
                class="input num"
                placeholder={st?.has_bindkey ? '已保存密钥（留空则保持不变，输入新密钥将覆盖）' : '粘贴 32 位十六进制 BLE KEY'}
                value={bindkey}
                onInput={(e) => setBindkey((e.target as HTMLInputElement).value)}
              />
              <button type="button" class="btn btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={() => setShowKey(!showKey)}>
                {showKey ? '隐藏' : '显示'}
              </button>
              {st?.has_bindkey && (
                <button type="button" class="btn btn-sm btn-danger" style={{ whiteSpace: 'nowrap' }} disabled={busy} onClick={clearBindkey}>
                  清除
                </button>
              )}
            </div>
          </div>

          <div class="grid g-4" style={{ marginBottom: '12px' }}>
            <div class="field" style={{ marginBottom: 0 }}>
              <label>温度下限 (°C)</label>
              <input type="number" step="0.5" class="input num" value={tempLow} onInput={(e) => { setTempLow((e.target as HTMLInputElement).value); setDirty(true); }} />
            </div>
            <div class="field" style={{ marginBottom: 0 }}>
              <label>温度上限 (°C)</label>
              <input type="number" step="0.5" class="input num" value={tempHigh} onInput={(e) => { setTempHigh((e.target as HTMLInputElement).value); setDirty(true); }} />
            </div>
            <div class="field" style={{ marginBottom: 0 }}>
              <label>湿度下限 (%)</label>
              <input type="number" step="1" class="input num" value={humLow} onInput={(e) => { setHumLow((e.target as HTMLInputElement).value); setDirty(true); }} />
            </div>
            <div class="field" style={{ marginBottom: 0 }}>
              <label>湿度上限 (%)</label>
              <input type="number" step="1" class="input num" value={humHigh} onInput={(e) => { setHumHigh((e.target as HTMLInputElement).value); setDirty(true); }} />
            </div>
          </div>

          <div class="btn-row" style={{ justifyContent: 'space-between' }}>
            <span class="kpi-sub">无需给 3 mini 刷机，米家 App 照常使用</span>
            <button class="btn btn-primary" disabled={busy} onClick={saveConfig}>保存配置</button>
          </div>
        </div>

        <div class="card" style={{ justifyContent: 'space-between' }}>
          <div>
            <div class="card-head">
              <span class="card-title">Siri 快捷指令查询与设备诊断</span>
              <div class="btn-row">
                <span class={`tag ${st?.siri?.enabled ? 'dark' : ''}`}>{st?.siri?.enabled ? 'Siri 已启用' : 'Siri 已停用'}</span>
                <button
                  type="button"
                  class={`toggle ${st?.siri?.enabled ? 'on' : ''}`}
                  disabled={busy}
                  onClick={() => updateSiri({ enabled: !(st?.siri?.enabled ?? true) })}
                />
              </div>
            </div>

            <div class="kpi-sub">
              在 iPhone「快捷指令」中添加「获取 URL 内容」→「获取词典值（键：message）」→「朗读文本」，即可直接问 Siri 室温湿度（支持外网隧道访问）。
            </div>

            <div class="siri-list">
              <div class="siri-item">
                <span class="siri-label">当前访问</span>
                <span class="siri-url num" title={originSiriUrl}>{originSiriUrl}</span>
                <button class="btn btn-sm" onClick={() => copyText('origin', originSiriUrl)}>
                  {copiedKey === 'origin' ? '已复制' : '复制'}
                </button>
              </div>
              <div class="siri-item">
                <span class="siri-label">局域网</span>
                <span class="siri-url num" title={lanSiriUrl}>{lanSiriUrl}</span>
                <button class="btn btn-sm" onClick={() => copyText('lan', lanSiriUrl)}>
                  {copiedKey === 'lan' ? '已复制' : '复制'}
                </button>
              </div>
            </div>

            <div class="btn-row" style={{ marginTop: '10px' }}>
              <button class="btn btn-sm" disabled={!st?.siri?.enabled} onClick={testSiriQuery}>测试语音播报返回</button>
              <button class="btn btn-sm" disabled={busy} onClick={() => updateSiri({ regenerate: true })}>重置 Siri 密钥</button>
            </div>

            {siriTestMsg && (
              <div class="alert alert-ok" style={{ marginTop: '10px' }}>
                <strong>Siri 返回：</strong>{siriTestMsg}
              </div>
            )}
          </div>

          <table class="kv-table" style={{ marginTop: '12px' }}>
            <tbody>
              <tr>
                <td class="kv-key">识别型号 / Product ID</td>
                <td class="num">{st?.model || '--'} · {st?.product_id || '0x0000'}</td>
              </tr>
              <tr>
                <td class="kv-key">累计广播 / 解密统计</td>
                <td class="num">收包 {st?.adv_count ?? 0} · 成功 {st?.decrypt_ok ?? 0} · 失败 {st?.decrypt_fail ?? 0}</td>
              </tr>
              <tr>
                <td class="kv-key">Flash 历史文件</td>
                <td class="num">/data/env_hist.bin ({st?.history.count ?? 0} / {st?.history.max_records ?? 8640})</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
