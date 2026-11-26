import { useEffect, useRef, useState } from 'preact/hooks';
import { api, CamStatus, EnvState, LampState, PersonState, wsClient } from '../api/client';

const RES_OPTIONS: { value: '640x368' | '1280x720' | '1920x1080'; label: string }[] = [
  { value: '640x368', label: '极速 640×368' },
  { value: '1280x720', label: '高清 720p · 硬编' },
  { value: '1920x1080', label: '超清 1080p · 细节' },
];

const LS_FILL = 's3_cam_fill';
const LS_HUD = 's3_cam_hud';
const LS_SPOT = 's3_cam_spot';
const LS_LOC = 's3_cam_loc';

function readLs(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(key);
    return v !== null ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeLs(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* ignore */
  }
}

function calcDewPoint(tempC: number | null | undefined, hum: number | null | undefined): string {
  if (tempC === null || tempC === undefined || hum === null || hum === undefined || hum <= 0) {
    return '-- °C';
  }
  const a = 17.62;
  const b = 243.12;
  const gamma = (a * tempC) / (b + tempC) + Math.log(hum / 100);
  const dp = (b * gamma) / (a - gamma);
  return `${dp.toFixed(1)} °C`;
}

function formatClock(d: Date): { clock: string; date: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  return {
    clock: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} · ${days[d.getDay()]}`,
  };
}

export function Camera() {
  const [st, setSt] = useState<CamStatus | null>(null);
  const [lanLive, setLanLive] = useState<'loading' | 'live' | 'error'>('loading');
  const [naturalSize, setNaturalSize] = useState('');
  const [streamEpoch, setStreamEpoch] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; err?: boolean } | null>(null);

  // HUD live telemetry state
  const [env, setEnv] = useState<EnvState | null>(null);
  const [persons, setPersons] = useState<PersonState[]>([]);
  const [lamp, setLamp] = useState<LampState | null>(null);
  const [wsOk, setWsOk] = useState(false);
  const [nowParts, setNowParts] = useState(() => formatClock(new Date()));

  // Viewfinder HUD & geometry preferences
  const [fillMode, setFillMode] = useState(() => readLs(LS_FILL, '0') === '1');
  const [showHud, setShowHud] = useState(() => readLs(LS_HUD, '1') !== '0');
  const [spotName, setSpotName] = useState(() => readLs(LS_SPOT, '书房主视角'));
  const [locName, setLocName] = useState(() => readLs(LS_LOC, '家中书房'));

  // Form state
  const [lanUrl, setLanUrl] = useState('http://192.168.0.108:8080');
  const [res, setRes] = useState<'640x368' | '1280x720' | '1920x1080'>('1280x720');
  const [fps, setFps] = useState(20);
  const [quality, setQuality] = useState(75);
  const [dirty, setDirty] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const flash = (text: string, err = false) => {
    setNotice({ text, err });
    window.setTimeout(() => {
      setNotice((cur) => (cur?.text === text ? null : cur));
    }, 3200);
  };

  const hydrate = (s: CamStatus, force = false) => {
    if (!force && dirty) return;
    setLanUrl(s.lan_url || 'http://192.168.0.108:8080');
    const validRes = s.res === '640x368' || s.res === '1280x720' || s.res === '1920x1080' ? s.res : '1280x720';
    setRes(validRes);
    setFps(s.fps || 20);
    setQuality(s.quality || 75);
  };

  const refreshStatus = async () => {
    try {
      const s = await api.camStatus();
      setSt(s);
      hydrate(s, false);
    } catch (e) {
      flash(e instanceof Error ? e.message : '加载摄像头状态失败', true);
    }
  };

  useEffect(() => {
    refreshStatus();
    const timer = window.setInterval(refreshStatus, 8000);
    return () => window.clearInterval(timer);
  }, []);

  // 1 Hz live clock for HUD
  useEffect(() => {
    const id = window.setInterval(() => setNowParts(formatClock(new Date())), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Live ESP32-S3 telemetry for 4-corner HUD (environment, presence, lighting)
  useEffect(() => {
    api.envState().then(setEnv).catch(() => {});
    api.presenceState().then((r) => setPersons(r.persons || [])).catch(() => {});
    api.lampState().then(setLamp).catch(() => {});

    const unsubStatus = wsClient.subscribeStatus(setWsOk);
    const unsubMsg = wsClient.subscribe((msg) => {
      if (msg.type === 'env_state') {
        const { type: _t, ...rest } = msg;
        setEnv(rest);
      } else if (msg.type === 'presence_tick') {
        setPersons(msg.persons || []);
      } else if (msg.type === 'lamp_state') {
        const { type: _t, ...rest } = msg;
        setLamp(rest);
      }
    });
    return () => {
      unsubStatus();
      unsubMsg();
    };
  }, []);

  const isCloud = st?.via === 'cloud';
  const cleanLanUrl = (st?.lan_url || '').replace(/\/+$/, '');
  const activeRes = st?.res === '640x368' || st?.res === '1280x720' || st?.res === '1920x1080' ? st.res : '1280x720';
  const activeFps = st?.fps || 20;
  const activeQual = st?.quality || 75;
  const streamUrl = !isCloud && cleanLanUrl && st && !st.privacy
    ? `${cleanLanUrl}/stream?res=${activeRes}&fps=${activeFps}&q=${activeQual}&t=${streamEpoch}`
    : '';

  useEffect(() => {
    if (streamUrl) {
      setLanLive('loading');
    } else {
      setLanLive('loading');
      setNaturalSize('');
    }
  }, [streamUrl]);

  const applyConfig = async (patch: Parameters<typeof api.camConfig>[0], toastMsg?: string, reconnect = false) => {
    setBusy(true);
    try {
      const next = await api.camConfig(patch);
      setSt(next);
      setDirty(false);
      hydrate(next, true);
      if (reconnect) {
        setStreamEpoch((e) => e + 1);
      }
      if (toastMsg) flash(toastMsg);
    } catch (e) {
      flash(e instanceof Error ? e.message : '更新摄像头配置失败', true);
    } finally {
      setBusy(false);
    }
  };

  const toggleFillMode = () => {
    const nxt = !fillMode;
    setFillMode(nxt);
    writeLs(LS_FILL, nxt ? '1' : '0');
    flash(nxt ? '已切换为无黑边铺满画面' : '已切换为完整原始比例');
  };

  const toggleHud = () => {
    const nxt = !showHud;
    setShowHud(nxt);
    writeLs(LS_HUD, nxt ? '1' : '0');
  };

  const takeSnapshot = () => {
    if (!st || st.privacy) {
      flash('隐私保护开启中，无法抓拍', true);
      return;
    }
    const img = imgRef.current;
    if (!img || !img.complete || img.naturalWidth <= 0) {
      flash('画面尚未就绪，请等待首帧加载', true);
      return;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('no ctx');
      ctx.drawImage(img, 0, 0);
      const a = document.createElement('a');
      a.href = c.toDataURL('image/jpeg', 0.95);
      a.download = `k230-${activeRes}-${ts}.jpg`;
      a.click();
      flash(`已抓拍 ${img.naturalWidth}×${img.naturalHeight} JPEG`);
    } catch {
      if (cleanLanUrl) {
        window.open(`${cleanLanUrl}/snapshot?res=${activeRes}&q=${activeQual}`, '_blank');
      }
    }
  };

  const toggleFullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen?.().catch(() => {});
    }
  };

  const showPrivacy = Boolean(st?.privacy);
  const showCloudNotice = Boolean(st && isCloud);
  const showNoLanUrl = Boolean(st && !isCloud && !cleanLanUrl);
  const canRenderImg = Boolean(st && !isCloud && !showPrivacy && cleanLanUrl && streamUrl);
  const isLive = canRenderImg && lanLive === 'live';

  const lanHost = (() => {
    if (!cleanLanUrl) return '--';
    try {
      return new URL(cleanLanUrl).hostname;
    } catch {
      return cleanLanUrl.replace(/^https?:\/\//, '').split('/')[0];
    }
  })();

  const homeCount = persons.filter((p) => p.is_home).length;
  const tempText = env && env.valid && env.temp_c !== null ? `${env.temp_c.toFixed(1)} °C` : '-- °C';
  const humText = env && env.valid && env.humidity !== null ? `${env.humidity.toFixed(1)} %RH` : '-- %RH';
  const humPct = env && env.valid && env.humidity !== null ? Math.max(4, Math.min(100, Math.round(env.humidity))) : 0;
  const dewText = env && env.valid ? calcDewPoint(env.temp_c, env.humidity) : '-- °C';
  const lampText = lamp ? (lamp.power_known ? (lamp.power_on ? '开启' : '关闭') : '待校准') : '--';

  return (
    <>
      <header class="view-header">
        <div>
          <div class="eyebrow">K230 EDGE VISION · GC2093 MIPI CSI · LAN DIRECT</div>
          <h1 class="view-title">视觉监控 · 庐山派 K230</h1>
        </div>
        <div class="btn-row">
          <span class="tag">{isCloud ? '外网访问' : '局域网高速直连'}</span>
          <span class={`tag ${showPrivacy ? 'red' : isLive ? 'dark' : ''}`}>
            {showPrivacy
              ? '隐私遮罩中'
              : showCloudNotice
                ? '仅限内网高清'
                : isLive
                  ? '直连推流中'
                  : lanLive === 'error'
                    ? '节点未响应'
                    : '连接中'}
          </span>
        </div>
      </header>

      {notice && (
        <div class={`alert ${notice.err ? 'alert-err' : 'alert-ok'}`}>{notice.text}</div>
      )}

      {/* VIEWFINDER */}
      <div class="card">
        <div class="card-head">
          <span class="card-title">
            实时取景器（{naturalSize || activeRes} · {activeRes === '1280x720' ? 'VPU 硬件 MJPEG' : 'VICAP 软编'}）
          </span>
          <div class="btn-row">
            <span class="tag num">目标 {activeFps} FPS · Q{activeQual}</span>
            <span class="tag dark">{fillMode ? '无黑边铺满' : '原始比例'}</span>
          </div>
        </div>

        <div class={`cam-stage ${fillMode ? 'fill-mode' : ''}`} ref={stageRef}>
          <div class="cam-side-rail left" />
          <div class="cam-side-rail right" />

          {canRenderImg && (
            <img
              ref={imgRef}
              class="cam-media"
              crossOrigin="anonymous"
              src={streamUrl}
              alt="K230 LAN MJPEG Stream"
              style={{ display: lanLive === 'error' ? 'none' : 'block' }}
              onLoad={() => {
                setLanLive('live');
                const img = imgRef.current;
                if (img && img.naturalWidth > 0) {
                  setNaturalSize(`${img.naturalWidth}×${img.naturalHeight}`);
                }
              }}
              onError={() => {
                setLanLive('error');
                setNaturalSize('');
              }}
            />
          )}

          {/* 4-CORNER LFNL TELEMETRY HUD */}
          <div class={`cam-hud-layer ${showPrivacy || showCloudNotice || !showHud ? 'hidden' : ''}`}>
            <div class="cam-hud cam-hud-tl">
              <div class="cam-hud-eyebrow">OPTICAL FEED · CAM-01</div>
              <div class="cam-hud-row">
                <span class={`live-dot ${isLive ? '' : 'off'}`} />
                <span class="cam-hud-main">{spotName.trim() || '主视角'}</span>
                <span class={`cam-hud-badge ${isLive ? 'red' : ''}`}>{isLive ? 'REC' : 'WAIT'}</span>
              </div>
              <div class="cam-hud-sub num">
                LAN MJPEG · {naturalSize || activeRes.replace('x', '×')} · {activeFps} FPS · Q{activeQual}
              </div>
            </div>

            <div class="cam-hud cam-hud-tr">
              <div class="cam-hud-eyebrow">TIME &amp; LOCATION</div>
              <div class="cam-hud-clock num">{nowParts.clock}</div>
              <div class="cam-hud-sub num">{nowParts.date}</div>
              <div class="cam-hud-sub num">{locName.trim() || '家中'} · {lanHost}</div>
            </div>

            <div class="cam-hud cam-hud-bl">
              <div class="cam-hud-eyebrow">ENV · {env?.name || '小米温湿度计 3 MINI'}</div>
              <div class="cam-hud-row">
                <span class="cam-hud-main num">{tempText}</span>
                <span class="cam-hud-main num">{humText}</span>
                <span class={`cam-hud-badge ${env?.comfort?.alert ? 'red' : ''}`}>
                  {env?.comfort?.label || '等待广播'}
                </span>
              </div>
              <div class="cam-hud-sub num">露点 {dewText} · BLE {env?.rssi ?? '--'} dBm</div>
              <div class="cam-hud-bar"><i style={{ width: `${humPct}%` }} /></div>
            </div>

            <div class="cam-hud cam-hud-br">
              <div class="cam-hud-eyebrow">SPACE &amp; NODE · ESP32-S3</div>
              <div class="cam-hud-row">
                <span class={`live-dot ${homeCount > 0 ? '' : 'off'}`} style={{ width: '6px', height: '6px' }} />
                <span class="cam-hud-main">
                  {homeCount > 0 ? `空间感知 · 在家 (${homeCount} 人)` : '空间感知 · 无人离家'}
                </span>
              </div>
              <div class="cam-hud-sub num">台灯照明 · {lampText} · 遥测 {wsOk ? '1.0 Hz' : '离线'}</div>
            </div>
          </div>

          {(!canRenderImg || lanLive !== 'live') && (
            <div class="cam-curtain">
              <div class="cam-curtain-code num">
                {showPrivacy
                  ? 'PRIVACY SHIELD ACTIVE'
                  : showCloudNotice
                    ? 'LAN HD MODE ONLY'
                    : showNoLanUrl
                      ? 'LAN ENDPOINT REQUIRED'
                      : lanLive === 'error'
                        ? 'K230 STREAM UNREACHABLE'
                        : 'CONNECTING K230 STREAM...'}
              </div>
              <div class="cam-curtain-desc">
                {showPrivacy
                  ? '隐私遮罩已启用，已断开 K230 视频连接（0 字节传输）。'
                  : showCloudNotice
                    ? 'K230 当前运行在局域网 720p 硬编直连模式，请在家庭内网访问 http://esp32s3.local/（或通过回家 VPN）观看高帧率高清画面。'
                    : showNoLanUrl
                      ? '请在下方「K230 局域网直连地址」中填入 K230 地址（默认 http://192.168.0.108:8080）。'
                      : lanLive === 'error'
                        ? `无法连接到 ${cleanLanUrl}/stream，请确认 K230 已通电并接入 2.4GHz Wi-Fi，或点击下方「重连画面」。`
                        : `正在从 ${cleanLanUrl} 建立低延迟直连流...`}
              </div>
              {showPrivacy && (
                <button class="btn btn-primary btn-sm" disabled={busy} onClick={() => applyConfig({ privacy: false }, '已解除隐私遮罩，正在恢复画面', true)}>
                  解除隐私遮罩
                </button>
              )}
              {lanLive === 'error' && !showPrivacy && !showCloudNotice && (
                <button class="btn btn-primary btn-sm" onClick={() => setStreamEpoch((e) => e + 1)}>
                  立即重连
                </button>
              )}
            </div>
          )}
        </div>

        <div class="btn-row" style={{ marginTop: '12px', justifyContent: 'space-between' }}>
          <div class="btn-row">
            <button
              class={`btn ${showPrivacy ? 'btn-primary' : 'btn-danger'}`}
              disabled={busy}
              onClick={() => applyConfig({ privacy: !showPrivacy }, !showPrivacy ? '已开启隐私遮罩，立即断开视频流' : '已解除隐私遮罩', true)}
            >
              {showPrivacy ? '解除隐私遮罩' : '一键隐私遮罩'}
            </button>
            <button class="btn" disabled={!isLive} onClick={takeSnapshot}>抓拍保存</button>
          </div>
          <div class="btn-row">
            <button class="btn" onClick={toggleFillMode}>{fillMode ? '原始比例' : '画面铺满'}</button>
            <button class="btn" onClick={toggleHud}>{showHud ? '隐藏 HUD' : '显示 HUD'}</button>
            <button class="btn" onClick={() => { setStreamEpoch((e) => e + 1); refreshStatus(); }}>重连画面</button>
            <button class="btn" onClick={toggleFullscreen}>全屏</button>
          </div>
        </div>
      </div>

      {/* CONTROLS & CONNECTION */}
      <div class="grid g-2">
        <div class="card">
          <div class="card-head">
            <span class="card-title">分辨率与帧率控制</span>
            <span class="tag">{activeRes}</span>
          </div>

          <div class="switch-row" style={{ marginBottom: '12px' }}>
            <div>
              <div class="switch-title">隐私遮罩（断开直连）</div>
              <div class="switch-desc">开启后立刻关闭视频流 TCP 连接，停止采集与传输</div>
            </div>
            <button
              type="button"
              class={`toggle ${st?.privacy ? 'on' : ''}`}
              disabled={busy}
              onClick={() => applyConfig({ privacy: !(st?.privacy ?? false) }, undefined, true)}
            />
          </div>

          <div class="field">
            <label>分辨率预设</label>
            <div class="env-seg" style={{ width: '100%' }}>
              {RES_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  class={`theme-btn ${res === opt.value ? 'active' : ''}`}
                  onClick={() => { setRes(opt.value); setDirty(true); }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div class="kpi-sub" style={{ marginTop: '6px' }}>
              720p 走 K230 硬件 VPU MJPEG 编码（实测最高 50 FPS，推荐 20~25 FPS）；1080p 为全高清细节模式（约 2 FPS）。
            </div>
          </div>

          <div class="grid g-2" style={{ marginBottom: '12px' }}>
            <div class="field" style={{ marginBottom: 0 }}>
              <label>目标帧率：<strong class="num">{fps} FPS</strong></label>
              <input
                type="range"
                min={5}
                max={30}
                value={fps}
                style={{ width: '100%', accentColor: 'var(--black)' }}
                onInput={(e) => { setFps(Number((e.target as HTMLInputElement).value)); setDirty(true); }}
              />
            </div>
            <div class="field" style={{ marginBottom: 0 }}>
              <label>软编 JPEG 质量：<strong class="num">{quality}</strong></label>
              <input
                type="range"
                min={40}
                max={90}
                step={5}
                value={quality}
                style={{ width: '100%', accentColor: 'var(--black)' }}
                onInput={(e) => { setQuality(Number((e.target as HTMLInputElement).value)); setDirty(true); }}
              />
            </div>
          </div>

          <div class="btn-row" style={{ justifyContent: 'space-between' }}>
            <span class="kpi-sub">参数保存至 ESP32-S3，并重连拉取新流</span>
            <button
              class="btn btn-primary"
              disabled={busy}
              onClick={() => applyConfig({ res, fps, quality }, '画质与帧率参数已应用', true)}
            >
              应用画质参数
            </button>
          </div>
        </div>

        <div class="card" style={{ justifyContent: 'space-between' }}>
          <div>
            <div class="card-head">
              <span class="card-title">K230 节点与四角 HUD 标注</span>
              <span class={`tag ${isLive ? 'dark' : ''}`}>{isLive ? '直连正常' : '待机'}</span>
            </div>

            <div class="grid g-2" style={{ marginBottom: '10px' }}>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>机位名称（左上角）</label>
                <input
                  class="input"
                  value={spotName}
                  onInput={(e) => {
                    const v = (e.target as HTMLInputElement).value;
                    setSpotName(v);
                    writeLs(LS_SPOT, v);
                  }}
                />
              </div>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>所在位置（右上角）</label>
                <input
                  class="input"
                  value={locName}
                  onInput={(e) => {
                    const v = (e.target as HTMLInputElement).value;
                    setLocName(v);
                    writeLs(LS_LOC, v);
                  }}
                />
              </div>
            </div>

            <div class="field">
              <label>K230 局域网直连地址</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  class="input num"
                  placeholder="http://192.168.0.108:8080"
                  value={lanUrl}
                  onInput={(e) => { setLanUrl((e.target as HTMLInputElement).value); setDirty(true); }}
                />
                <button
                  class="btn btn-primary"
                  style={{ whiteSpace: 'nowrap' }}
                  disabled={busy}
                  onClick={() => applyConfig({ lan_url: lanUrl.trim() }, '局域网直连地址已保存', true)}
                >
                  保存地址
                </button>
              </div>
            </div>

            <div class="kpi-sub" style={{ marginBottom: '10px' }}>
              纯内网单线程直连模式：浏览器直接从 K230 8080 端口拉取 HTTP MJPEG，零经过 ESP32-S3，延迟最低。
            </div>
          </div>

          <table class="kv-table">
            <tbody>
              <tr>
                <td class="kv-key">边缘视觉节点</td>
                <td class="num">LCSC 庐山派 K230 · GC2093 MIPI CSI</td>
              </tr>
              <tr>
                <td class="kv-key">编码通道</td>
                <td class="num">{activeRes === '1280x720' ? 'VPU 硬件 MJPEG (K_PT_MJPEG)' : 'VICAP RGB565 → JPEG'}</td>
              </tr>
              <tr>
                <td class="kv-key">当前直连流</td>
                <td class="num">{cleanLanUrl || '--'}</td>
              </tr>
              <tr>
                <td class="kv-key">实时画幅</td>
                <td class="num">{naturalSize || activeRes} @ {activeFps} FPS 目标</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
