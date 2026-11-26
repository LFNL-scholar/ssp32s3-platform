import { useEffect, useState } from 'preact/hooks';
import { api, WolState, wsClient } from '../api/client';

interface Props {
  hostLabel: string;
}

function fmtEventTime(timeSynced: boolean, epoch: number, uptimeS: number): string {
  if (timeSynced && epoch > 0) {
    return new Date(epoch * 1000).toLocaleTimeString('zh-CN', { hour12: false });
  }
  return `+${uptimeS}s`;
}

export function Wol({ hostLabel }: Props) {
  const [st, setSt] = useState<WolState | null>(null);
  const [busy, setBusy] = useState(false);
  const [rippleKey, setRippleKey] = useState(0);
  const [notice, setNotice] = useState<{ text: string; err?: boolean } | null>(null);

  // Host form state
  const [hostName, setHostName] = useState('Windows 工作站');
  const [hostIp, setHostIp] = useState('192.168.0.106');
  const [hostMac, setHostMac] = useState('9C:6B:00:5F:9C:7C');
  const [hostDirty, setHostDirty] = useState(false);

  // MQTT form state
  const [mqttHost, setMqttHost] = useState('bemfa.com');
  const [mqttPort, setMqttPort] = useState('9501');
  const [mqttCid, setMqttCid] = useState('');
  const [mqttWolTopic, setMqttWolTopic] = useState('pcwake006');
  const [mqttLampTopic, setMqttLampTopic] = useState('lamp002');
  const [mqttUser, setMqttUser] = useState('');
  const [mqttPass, setMqttPass] = useState('');
  const [mqttDirty, setMqttDirty] = useState(false);

  const flash = (text: string, err = false) => {
    setNotice({ text, err });
    window.setTimeout(() => {
      setNotice((cur) => (cur?.text === text ? null : cur));
    }, 3200);
  };

  const hydrateForms = (s: WolState, force = false) => {
    if (force || !hostDirty) {
      setHostName(s.host.name);
      setHostIp(s.host.ip);
      setHostMac(s.host.mac);
    }
    if (force || !mqttDirty) {
      setMqttHost(s.mqtt.host);
      setMqttPort(String(s.mqtt.port || 9501));
      setMqttCid(s.mqtt.client_id);
      setMqttWolTopic(s.mqtt.wol_topic);
      setMqttLampTopic(s.mqtt.lamp_topic);
      setMqttUser(s.mqtt.username);
    }
  };

  useEffect(() => {
    api.wolState()
      .then((s) => {
        setSt(s);
        hydrateForms(s, true);
      })
      .catch((e) => flash(e instanceof Error ? e.message : '加载 WOL 状态失败', true));

    const unsub = wsClient.subscribe((msg) => {
      if (msg.type === 'wol_state') {
        setSt(msg);
      }
    });
    return unsub;
  }, []);

  const doWake = async () => {
    if (busy) return;
    setBusy(true);
    setRippleKey((k) => k + 1);
    try {
      const res = await api.wolWake();
      setSt(res);
      flash(`已发出 ${res.sent} 个 UDP 魔术包，正在轮询主机上线...`);
    } catch (e) {
      flash(e instanceof Error ? e.message : '发送魔术包失败', true);
    } finally {
      setBusy(false);
    }
  };

  const doProbe = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.wolProbe();
      setSt(res);
      flash(res.online ? `探测完成：${res.host.ip} 当前已开机` : `探测完成：${res.host.ip} 当前已关机（可唤醒）`);
    } catch (e) {
      flash(e instanceof Error ? e.message : '状态探测失败', true);
    } finally {
      setBusy(false);
    }
  };

  const toggleAutoWake = async () => {
    if (!st) return;
    const next = !st.host.auto_wake_on_arrive;
    try {
      const res = await api.wolConfig({ auto_wake_on_arrive: next });
      setSt(res);
      flash(next ? '蓝牙到家自动开机已启用（已开机自动跳过）' : '蓝牙到家自动开机已关闭');
    } catch (e) {
      flash(e instanceof Error ? e.message : '更新联动开关失败', true);
    }
  };

  const saveHost = async () => {
    setBusy(true);
    try {
      const res = await api.wolConfig({
        name: hostName.trim(),
        ip: hostIp.trim(),
        mac: hostMac.trim(),
      });
      setSt(res);
      setHostDirty(false);
      hydrateForms(res, true);
      flash('目标主机配置已保存至 NVS');
    } catch (e) {
      flash(e instanceof Error ? e.message : '保存主机配置失败', true);
    } finally {
      setBusy(false);
    }
  };

  const resetHostDefaults = () => {
    setHostName('Windows 工作站');
    setHostIp('192.168.0.106');
    setHostMac('9C:6B:00:5F:9C:7C');
    setHostDirty(true);
  };

  const applyBemfaPreset = () => {
    setMqttHost('bemfa.com');
    setMqttPort('9501');
    setMqttUser('');
    setMqttPass('');
    setMqttDirty(true);
    flash('已填入巴法云预设（bemfa.com:9501），请填写私钥并保存');
  };

  const toggleMqttEnabled = async () => {
    if (!st) return;
    const next = !st.mqtt.enabled;
    try {
      const res = await api.mqttConfig({ enabled: next });
      setSt(res);
      flash(next ? 'MQTT 外网通道已启用' : 'MQTT 外网通道已关闭');
    } catch (e) {
      flash(e instanceof Error ? e.message : '切换 MQTT 开关失败', true);
    }
  };

  const saveMqtt = async () => {
    setBusy(true);
    try {
      const payload: Parameters<typeof api.mqttConfig>[0] = {
        enabled: st?.mqtt.enabled ?? true,
        host: mqttHost.trim() || 'bemfa.com',
        port: Number(mqttPort) || 9501,
        client_id: mqttCid.trim(),
        username: mqttUser.trim(),
        wol_topic: mqttWolTopic.trim(),
        lamp_topic: mqttLampTopic.trim(),
      };
      if (mqttPass !== '') {
        payload.password = mqttPass;
      }
      const res = await api.mqttConfig(payload);
      setSt(res);
      setMqttPass('');
      setMqttDirty(false);
      hydrateForms(res, true);
      flash('MQTT 配置已保存并重新连接');
    } catch (e) {
      flash(e instanceof Error ? e.message : '保存 MQTT 配置失败', true);
    } finally {
      setBusy(false);
    }
  };

  const reconnectMqtt = async () => {
    setBusy(true);
    try {
      const res = await api.mqttReconnect();
      setSt(res);
      flash('已触发 MQTT 重新连接');
    } catch (e) {
      flash(e instanceof Error ? e.message : '重连失败', true);
    } finally {
      setBusy(false);
    }
  };

  const copyText = (text: string, label: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    flash(`已复制「${label}」`);
  };

  const online = st?.online ?? false;
  const waking = st?.waking ?? false;
  const prog = st?.wake_progress ?? (online ? 100 : 0);
  const autoOn = st?.host.auto_wake_on_arrive ?? false;
  const mqttEn = st?.mqtt.enabled ?? false;
  const mqttConn = st?.mqtt.connected ?? false;
  const siriToken = st?.siri.token || '<token>';
  const baseHost = hostLabel || 'esp32s3.local';
  const uidDisplay = st?.mqtt.client_id ? st.mqtt.client_id : '<私钥>';
  const wolTopic = st?.mqtt.wol_topic || 'pcwake006';
  const lampTopic = st?.mqtt.lamp_topic || 'lamp002';

  const lanWakeUrl = `http://${baseHost}/api/siri/wol/wake?token=${siriToken}`;
  const lanStatusUrl = `http://${baseHost}/api/siri/wol/status?token=${siriToken}`;
  const bemfaWakeUrl = `https://apis.bemfa.com/va/postmsg?uid=${uidDisplay}&topic=${wolTopic}&type=1&msg=on`;
  const bemfaLampUrl = `https://apis.bemfa.com/va/postmsg?uid=${uidDisplay}&topic=${lampTopic}&type=1&msg=on`;

  const lastWakeTime = st && st.last_wake.sent > 0
    ? fmtEventTime(st.last_wake.time_synced, st.last_wake.epoch, st.last_wake.uptime_s)
    : '--';

  return (
    <>
      <div class="view-header">
        <div>
          <div class="eyebrow">WAKE-ON-LAN · UDP MAGIC PACKET · MQTT BRIDGE</div>
          <h1 class="view-title">远程开机与外网桥接</h1>
        </div>
        <div class="btn-row">
          <button class="btn" disabled={busy} onClick={doProbe}>立即探测状态</button>
          <button class="btn btn-primary" disabled={busy} onClick={doWake}>发送魔术包开机</button>
        </div>
      </div>

      {notice && (
        <div class={`alert ${notice.err ? 'alert-err' : 'alert-ok'}`}>{notice.text}</div>
      )}

      <div class="grid g-4">
        <div class="card">
          <div class="card-head">
            <span class="card-title">目标主机状态</span>
            <span class={`tag ${waking ? 'red' : online ? 'dark' : ''}`}>
              {waking ? '轮询中' : online ? '在线' : '离线'}
            </span>
          </div>
          <div class="kpi-val">{waking ? '正在唤醒' : online ? '已开机' : '已关机'}</div>
          <div class="kpi-sub num">{st?.host.ip || '--'} · TCP 445/135 + ARP</div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">外网 MQTT 通道</span>
            <span class={`tag ${mqttConn ? 'red' : ''}`}>
              {mqttConn ? '已连接' : mqttEn ? '连接中' : '未启用'}
            </span>
          </div>
          <div class="kpi-val">{mqttConn ? '在线' : mqttEn ? '重连中' : '关闭'}</div>
          <div class="kpi-sub num">
            {st?.mqtt.last_error
              ? st.mqtt.last_error
              : `${st?.mqtt.host || 'bemfa.com'}:${st?.mqtt.port || 9501} · ${wolTopic} / ${lampTopic}`}
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">上次唤醒记录</span>
            <span class="tag">{st?.last_wake.source || '暂无'}</span>
          </div>
          <div class="kpi-val num">{lastWakeTime}</div>
          <div class="kpi-sub num">
            {st && st.last_wake.sent > 0
              ? `已发出 ${st.last_wake.sent} 包 · 端口 9 / 7 × 3 轮`
              : '开机后尚未触发唤醒'}
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">蓝牙到家自动开机</span>
            <span class={`tag ${autoOn ? 'dark' : ''}`}>{autoOn ? '已开启' : '已关闭'}</span>
          </div>
          <div class="kpi-val">{autoOn ? '守卫生效中' : '待命'}</div>
          <div class="kpi-sub num">已开机自动跳过 · 冷却防抖 {st?.host.auto_cooldown_s ?? 300} 秒</div>
        </div>
      </div>

      <div class="grid g-lamp">
        {/* Left: Power Core + BLE Auto-Wake */}
        <div class="card">
          <div class="card-head">
            <span class="card-title">魔术包发射核心 · WOL</span>
            <span class={`tag ${waking ? 'red' : online ? 'dark' : ''}`}>
              {waking ? '唤醒中' : online ? '已开机' : '已关机'}
            </span>
          </div>
          <div class="power-center">
            <div
              class={`power-orb ${online ? 'is-on' : ''}`}
              role="button"
              tabIndex={0}
              style={{ opacity: busy ? 0.65 : 1 }}
              onClick={doWake}
            >
              {rippleKey > 0 && <div key={rippleKey} class="rf-ripple firing" />}
              <svg class="orb-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <rect x="3" y="4" width="18" height="12" rx="1.5" />
                <path d="M8 20h8M12 16v4" />
              </svg>
              <div class="orb-label">
                <span class="orb-dot" />
                <span>{waking ? 'WAKING...' : online ? 'ONLINE' : 'WAKE PC'}</span>
              </div>
            </div>
            <div class="kpi-sub">点击核心向局域网发送 102 字节 UDP 魔术包（18 包）</div>
            <div style={{ width: '100%', maxWidth: '280px', marginTop: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-sec)', marginBottom: '4px' }}>
                <span>
                  {waking
                    ? '已发包 · 正在 ARP / TCP 轮询上线...'
                    : online
                      ? '主机在线 · 后台每 15 秒核验 ARP'
                      : '主机离线 · 点击上方核心可唤醒'}
                </span>
                <span class="num">{prog}%</span>
              </div>
              <div class="meter" style={{ marginTop: 0 }}>
                <div class="meter-fill red" style={{ width: `${prog}%` }} />
              </div>
            </div>
          </div>

          <div style={{ borderTop: '1px dashed var(--line)', paddingTop: '14px', marginTop: '10px' }}>
            <div style={{ fontSize: '12.5px', fontWeight: 600, marginBottom: '4px' }}>蓝牙空间感知联动</div>
            <div class="switch-row">
              <div>
                <div class="switch-title">到家自动开机</div>
                <div class="switch-desc">首位成员回家时先探测主机状态，确认未开机才发包</div>
              </div>
              <button type="button" class={`toggle ${autoOn ? 'on' : ''}`} onClick={toggleAutoWake} />
            </div>
            <div class="switch-row">
              <div>
                <div class="switch-title">防误触守卫状态</div>
                <div class="switch-desc num">已开机跳过：开启 · 冷却间隔：{st?.host.auto_cooldown_s ?? 300} 秒</div>
              </div>
              <span class="tag dark">GUARD</span>
            </div>
          </div>

          <div style={{ borderTop: '1px dashed var(--line)', paddingTop: '12px', marginTop: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11.5px', color: 'var(--text-dim)' }}>
              <span>协议：UDP 广播 + 单播</span>
              <span class="num" style={{ color: 'var(--text)', fontWeight: 600 }}>Port 9 / 7 · 102 Bytes</span>
            </div>
          </div>
        </div>

        {/* Right: Host Config + MQTT Bridge Config */}
        <div class="grid" style={{ gap: '12px' }}>
          <div class="card">
            <div class="card-head">
              <span class="card-title">目标主机配置（单机 · NVS 持久化）</span>
              <span class="tag num">{st?.host.mac || hostMac}</span>
            </div>
            <div class="grid g-2" style={{ gap: '12px' }}>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>主机备注名称</label>
                <input
                  class="input"
                  value={hostName}
                  onInput={(e) => { setHostName((e.target as HTMLInputElement).value); setHostDirty(true); }}
                />
              </div>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>目标局域网 IP（用于单播与在线探测）</label>
                <input
                  class="input num"
                  value={hostIp}
                  onInput={(e) => { setHostIp((e.target as HTMLInputElement).value); setHostDirty(true); }}
                />
              </div>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>网卡 MAC 地址</label>
                <input
                  class="input num"
                  value={hostMac}
                  onInput={(e) => { setHostMac((e.target as HTMLInputElement).value); setHostDirty(true); }}
                />
              </div>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>发包策略</label>
                <input class="input num" value="子网广播 + 255.255.255.255 + 单播 (Port 9/7 × 3)" disabled style={{ opacity: 0.75 }} />
              </div>
            </div>
            <div class="btn-row" style={{ justifyContent: 'flex-end', marginTop: '14px', paddingTop: '12px', borderTop: '1px dashed var(--line)' }}>
              <button class="btn" disabled={busy} onClick={resetHostDefaults}>恢复默认主机</button>
              <button class="btn btn-primary" disabled={busy} onClick={saveHost}>保存主机配置</button>
            </div>
          </div>

          <div class="card">
            <div class="card-head">
              <span class="card-title">MQTT 外网通道（零域名远程开机 &amp; 控灯）</span>
              <div class="btn-row" style={{ alignItems: 'center' }}>
                <span class={`tag ${mqttConn ? 'red' : ''}`}>
                  {mqttConn ? '已连接' : mqttEn ? '连接中' : '未启用'}
                </span>
                <button type="button" class={`toggle ${mqttEn ? 'on' : ''}`} onClick={toggleMqttEnabled} />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '12px', padding: '8px 10px', background: 'var(--surface-sub)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-sec)' }}>通用 MQTT 客户端 · 电脑关机后外网 4G/5G 仍可直接唤醒与控灯</span>
              <button class="btn btn-sm" onClick={applyBemfaPreset}>一键填入巴法云预设</button>
            </div>
            <div class="grid g-3" style={{ gap: '10px' }}>
              <div class="field" style={{ marginBottom: 0, gridColumn: 'span 2' }}>
                <label>Broker 服务器地址</label>
                <input
                  class="input num"
                  value={mqttHost}
                  onInput={(e) => { setMqttHost((e.target as HTMLInputElement).value); setMqttDirty(true); }}
                />
              </div>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>端口</label>
                <input
                  class="input num"
                  value={mqttPort}
                  onInput={(e) => { setMqttPort((e.target as HTMLInputElement).value); setMqttDirty(true); }}
                />
              </div>
            </div>
            <div class="grid g-3" style={{ gap: '10px', marginTop: '10px' }}>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>Client ID / 巴法云私钥 (UID)</label>
                <input
                  class="input num"
                  type="password"
                  value={mqttCid}
                  placeholder="粘贴巴法云私钥"
                  onInput={(e) => { setMqttCid((e.target as HTMLInputElement).value); setMqttDirty(true); }}
                />
              </div>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>远程开机主题 (WOL Topic)</label>
                <input
                  class="input num"
                  value={mqttWolTopic}
                  onInput={(e) => { setMqttWolTopic((e.target as HTMLInputElement).value); setMqttDirty(true); }}
                />
              </div>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>台灯控制主题 (Lamp Topic)</label>
                <input
                  class="input num"
                  value={mqttLampTopic}
                  onInput={(e) => { setMqttLampTopic((e.target as HTMLInputElement).value); setMqttDirty(true); }}
                />
              </div>
            </div>
            <div class="grid g-2" style={{ gap: '10px', marginTop: '10px' }}>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>用户名（巴法云留空，通用 Broker 选填）</label>
                <input
                  class="input"
                  value={mqttUser}
                  placeholder="可选"
                  onInput={(e) => { setMqttUser((e.target as HTMLInputElement).value); setMqttDirty(true); }}
                />
              </div>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>密码（巴法云留空，留空则保持原密码）</label>
                <input
                  class="input"
                  type="password"
                  value={mqttPass}
                  placeholder={st?.mqtt.has_password ? '已设置密码（留空保持不变）' : '可选'}
                  onInput={(e) => { setMqttPass((e.target as HTMLInputElement).value); setMqttDirty(true); }}
                />
              </div>
            </div>
            <div class="btn-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: '14px', paddingTop: '12px', borderTop: '1px dashed var(--line)' }}>
              <span class="kpi-sub">
                开机消息：<strong style={{ color: 'var(--text)' }}>on / wake</strong> · 控灯消息：<strong style={{ color: 'var(--text)' }}>on / off / toggle</strong>
              </span>
              <div class="btn-row">
                <button class="btn" disabled={busy} onClick={reconnectMqtt}>测试重连</button>
                <button class="btn btn-primary" disabled={busy} onClick={saveMqtt}>保存 MQTT 配置</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="grid g-2">
        <div class="card">
          <div class="card-head">
            <span class="card-title">快捷指令接入（局域网 Siri + 外网巴法云 API）</span>
            <span class="tag">{st?.siri.enabled ? 'Siri 已启用' : 'Siri 已关闭'}</span>
          </div>
          <div class="kpi-sub">在家连 Wi-Fi 可直连 ESP32-S3；外出 4G/5G 时在 iPhone「快捷指令」调用巴法云 HTTPS 接口：</div>
          <div class="siri-list">
            <div class="siri-item">
              <span class="siri-label">局域网开机</span>
              <span class="siri-url num">{lanWakeUrl}</span>
              <button class="btn btn-primary btn-sm" onClick={() => copyText(lanWakeUrl, '局域网开机链接')}>复制</button>
            </div>
            <div class="siri-item">
              <span class="siri-label">局域网状态</span>
              <span class="siri-url num">{lanStatusUrl}</span>
              <button class="btn btn-sm" onClick={() => copyText(lanStatusUrl, '局域网状态链接')}>复制</button>
            </div>
            <div class="siri-item">
              <span class="siri-label">外网开机</span>
              <span class="siri-url num">{bemfaWakeUrl}</span>
              <button class="btn btn-primary btn-sm" onClick={() => copyText(bemfaWakeUrl, '外网巴法云开机接口')}>复制</button>
            </div>
            <div class="siri-item">
              <span class="siri-label">外网开灯</span>
              <span class="siri-url num">{bemfaLampUrl}</span>
              <button class="btn btn-sm" onClick={() => copyText(bemfaLampUrl, '外网巴法云开灯接口')}>复制</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">唤醒与外网桥接日志</span>
            <span class="tag red">LIVE</span>
          </div>
          <div class="timeline">
            {!st || st.logs.length === 0 ? (
              <div class="dim" style={{ textAlign: 'center', padding: '24px 0' }}>暂无唤醒或外网桥接记录</div>
            ) : (
              st.logs.slice(0, 6).map((l) => (
                <div class="tl-item" key={l.seq}>
                  <div class={`tl-dot ${l.level === 'red' ? 'red' : l.level === 'gray' ? 'gray' : ''}`} />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span class="tl-text">{l.title}</span>
                      <span class="tl-time num">{fmtEventTime(l.time_synced, l.epoch, l.uptime_s)}</span>
                    </div>
                    <div class="tl-sub">{l.detail}</div>
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
