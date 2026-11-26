export interface AuthStatus {
  setup_required: boolean;
  authenticated: boolean;
  ap_mode: boolean;
  hostname: string;
}

export interface WifiAp {
  ssid: string;
  rssi: number;
  channel: number;
  auth: string;
}

export interface PartitionInfo {
  label: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
  used?: number;
}

export interface SystemInfo {
  chip: string;
  revision: number;
  cores: number;
  cpu_mhz: number;
  mac: string;
  idf_version: string;
  fw_version: string;
  project_name: string;
  compile_date: string;
  compile_time: string;
  reset_reason: string;
  running_partition: string;
  partitions: PartitionInfo[];
  littlefs: {
    www?: { total: number; used: number };
    data?: { total: number; used: number };
  };
}

export interface TelemetryMsg {
  type: 'telemetry';
  uptime_s: number;
  time_synced: boolean;
  epoch: number;
  temp_c: number | null;
  sram: { total: number; free: number; min_free: number };
  psram: { total: number; free: number; min_free: number };
  wifi: {
    mode: string;
    ssid: string;
    rssi: number;
    channel: number;
    ip: string;
    gateway: string;
    dns: string;
    sta_connected: boolean;
    ap_active: boolean;
  };
  ble: { state: string; tracked: number; home_persons: number };
  tasks: { name: string; cpu: number; core: number; stack_hwm: number }[];
}

export interface TrackedDevice {
  id: number;
  label: string;
  is_home: boolean;
  rssi: number;
  raw_rssi: number;
  seen_ago_s: number;
  match_type?: 'IRK' | 'MAC';
  mac?: string;
  enter_rssi?: number;
  exit_rssi?: number;
  away_timeout_s?: number;
}

export interface PersonState {
  id: number;
  name: string;
  is_home: boolean;
  devices: TrackedDevice[];
}

export interface PresenceStateResp {
  persons: PersonState[];
  pairing: { active: boolean; person_id: number; remaining_s: number };
}

export interface NearbyBleDevice {
  mac: string;
  addr_type: string;
  name: string;
  rssi: number;
  seen_ago_s: number;
}

export interface PresenceLogEntry {
  seq: number;
  timestamp: number;
  uptime_s: number;
  time_synced: boolean;
  person_id: number;
  person_name: string;
  event: 'ARRIVE' | 'LEAVE';
  device: string;
  rssi: number;
}

export interface SystemSettings {
  hostname: string;
  led_gpio: number;
  led_brightness: number;
  led_away_mode: number;
  led_idle_enabled: boolean;
  ntp_server1: string;
  ntp_server2: string;
  timezone: string;
}

export interface LampState {
  radio_ready: boolean;
  storage_ready: boolean;
  sample_loaded: boolean;
  sample_pulses: number;
  sample_mhz: number;
  power_known: boolean;
  power_on: boolean;
  power_transmissions: number;
  last_action: string;
  last_error: string;
  learning: {
    active: boolean;
    pending_ready: boolean;
    pending_pulses: number;
    pending_duration_ms: number;
  };
  automation: {
    auto_off_on_away: boolean;
    auto_on_on_arrive: boolean;
  };
  history: {
    time_synced: boolean;
    ready: boolean;
    recording: boolean;
    now: number;
    oldest: number;
    error: string;
  };
  siri?: {
    enabled: boolean;
    token: string;
    hostname: string;
  };
}

export interface LampHistoryResp {
  time_synced: boolean;
  ready: boolean;
  recording: boolean;
  now: number;
  oldest: number;
  error: string;
  incomplete: boolean;
  records: [number, number, number, number][];
}

export interface WolLogEntry {
  seq: number;
  epoch: number;
  uptime_s: number;
  time_synced: boolean;
  title: string;
  detail: string;
  level: 'red' | 'dark' | 'gray' | string;
}

export interface WolState {
  host: {
    name: string;
    ip: string;
    mac: string;
    auto_wake_on_arrive: boolean;
    auto_cooldown_s: number;
  };
  online: boolean;
  waking: boolean;
  wake_progress: number;
  last_wake: {
    epoch: number;
    uptime_s: number;
    time_synced: boolean;
    source: string;
    sent: number;
  };
  logs: WolLogEntry[];
  mqtt: {
    enabled: boolean;
    connected: boolean;
    host: string;
    port: number;
    client_id: string;
    username: string;
    has_password: boolean;
    wol_topic: string;
    lamp_topic: string;
    last_error: string;
  };
  siri: {
    enabled: boolean;
    token: string;
  };
  tunnel?: {
    enabled: boolean;
    connected: boolean;
    url: string;
    has_secret: boolean;
    last_error: string;
  };
}

export type LivingCostHouse = '旧房' | '新房';
export type LivingCostUtilMode = 'split' | 'bundle';
export type LivingCostPart = 'elec' | 'water' | 'gas';

export interface LivingCostRecord {
  month: string;
  house: LivingCostHouse;
  rent: number;
  utilMode: LivingCostUtilMode;
  elec: number;
  water: number;
  gas: number;
  bundleAmount: number;
  bundleParts: LivingCostPart[];
  utilPending?: boolean;
  lampHours?: number;
  note?: string;
}

export interface LivingCostData {
  initialized?: boolean;
  budgetTotal: number;
  budgetUtil: number;
  records: LivingCostRecord[];
}

export type WsMessage =
  | TelemetryMsg
  | { type: 'presence_tick'; persons: PersonState[] }
  | { type: 'presence_event'; event: string; person_id: number; person_name: string; device: string; rssi: number; epoch: number }
  | { type: 'pair_result'; status: 'success' | 'timeout' | 'cancelled' | 'error'; device_id?: number; label?: string; reason?: string }
  | ({ type: 'lamp_state' } & LampState)
  | { type: 'lamp_learn'; status: 'listening' | 'captured' | 'timeout' | 'error'; pulses?: number; duration_ms?: number; error?: string }
  | ({ type: 'wol_state' } & WolState);

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  if (resp.status === 401 && onUnauthorized && !url.includes('/api/auth/')) {
    onUnauthorized();
    throw new Error('登录已过期');
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.ok === false && data?.error) {
    throw new Error(data?.error || `HTTP ${resp.status}`);
  }
  return data as T;
}

export const api = {
  authStatus: () => req<AuthStatus>('/api/auth/status'),
  setupInit: (password: string) => req<{ ok: boolean }>('/api/setup/init', { method: 'POST', body: JSON.stringify({ password }) }),
  login: (password: string) => req<{ ok: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  changePassword: (old_password: string, new_password: string) =>
    req<{ ok: boolean }>('/api/auth/password', { method: 'POST', body: JSON.stringify({ old_password, new_password }) }),

  wifiScan: () => req<{ ok: boolean; aps: WifiAp[] }>('/api/wifi/scan'),
  wifiConnect: (ssid: string, password: string) =>
    req<{ ok: boolean; ip: string; hostname: string }>('/api/wifi/connect', { method: 'POST', body: JSON.stringify({ ssid, password }) }),

  systemInfo: () => req<SystemInfo>('/api/system/info'),
  systemStatus: () => req<TelemetryMsg>('/api/system/status'),
  getSettings: () => req<SystemSettings>('/api/settings'),
  putSettings: (s: SystemSettings) => req<{ ok: boolean }>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),
  reboot: () => req<{ ok: boolean }>('/api/system/reboot', { method: 'POST' }),
  factoryReset: () => req<{ ok: boolean }>('/api/system/factory-reset', { method: 'POST' }),

  presenceState: () => req<PresenceStateResp>('/api/presence/state'),
  addPerson: (name: string) => req<{ ok: boolean; id: number; name: string }>('/api/presence/persons', { method: 'POST', body: JSON.stringify({ name }) }),
  renamePerson: (id: number, name: string) => req<{ ok: boolean }>(`/api/presence/persons/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deletePerson: (id: number) => req<{ ok: boolean }>(`/api/presence/persons/${id}`, { method: 'DELETE' }),

  addFixedDevice: (body: { person_id: number; label: string; mac: string; enter_rssi: number; exit_rssi: number; away_timeout_s: number }) =>
    req<{ ok: boolean; id: number }>('/api/presence/devices', { method: 'POST', body: JSON.stringify(body) }),
  updateDevice: (id: number, body: { label: string; enter_rssi: number; exit_rssi: number; away_timeout_s: number }) =>
    req<{ ok: boolean }>(`/api/presence/devices/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteDevice: (id: number) => req<{ ok: boolean }>(`/api/presence/devices/${id}`, { method: 'DELETE' }),

  startPairing: (person_id: number, label: string, timeout_s = 60) =>
    req<{ ok: boolean }>('/api/presence/pair/start', { method: 'POST', body: JSON.stringify({ person_id, label, timeout_s }) }),
  stopPairing: () => req<{ ok: boolean }>('/api/presence/pair/stop', { method: 'POST' }),
  bleScan: () => req<{ devices: NearbyBleDevice[] }>('/api/presence/scan'),

  logs: (limit = 50, offset = 0) => req<{ total: number; logs: PresenceLogEntry[] }>(`/api/presence/logs?limit=${limit}&offset=${offset}`),
  clearLogs: () => req<{ ok: boolean }>('/api/presence/logs', { method: 'DELETE' }),

  lampState: () => req<LampState>('/api/lamp/state'),
  lampAction: (action: 'on' | 'off' | 'calibrate_on' | 'calibrate_off') =>
    req<LampState & { ok: boolean; transmitted?: boolean }>('/api/lamp/action', { method: 'POST', body: JSON.stringify({ action }) }),
  lampHistory: (from: number, to: number) => req<LampHistoryResp>(`/api/lamp/history?from=${from}&to=${to}`),
  lampAutomation: (auto_off_on_away: boolean, auto_on_on_arrive: boolean) =>
    req<LampState & { ok: boolean }>('/api/lamp/automation', { method: 'PUT', body: JSON.stringify({ auto_off_on_away, auto_on_on_arrive }) }),
  lampLearnStart: () => req<{ ok: boolean }>('/api/lamp/learn/start', { method: 'POST' }),
  lampLearnTest: () => req<{ ok: boolean }>('/api/lamp/learn/test', { method: 'POST' }),
  lampLearnSave: () => req<LampState & { ok: boolean }>('/api/lamp/learn/save', { method: 'POST' }),
  lampLearnCancel: () => req<{ ok: boolean }>('/api/lamp/learn/cancel', { method: 'POST' }),
  lampSiriConfig: (body: { enabled?: boolean; regenerate?: boolean }) =>
    req<LampState & { ok: boolean }>('/api/lamp/siri/config', { method: 'PUT', body: JSON.stringify(body) }),

  wolState: () => req<WolState>('/api/wol/state'),
  wolConfig: (body: { name?: string; ip?: string; mac?: string; auto_wake_on_arrive?: boolean; auto_cooldown_s?: number }) =>
    req<WolState & { ok: boolean }>('/api/wol/config', { method: 'PUT', body: JSON.stringify(body) }),
  wolWake: () => req<WolState & { ok: boolean; sent: number }>('/api/wol/wake', { method: 'POST' }),
  wolProbe: () => req<WolState & { ok: boolean }>('/api/wol/probe', { method: 'POST' }),
  mqttConfig: (body: {
    enabled?: boolean;
    host?: string;
    port?: number;
    client_id?: string;
    username?: string;
    password?: string;
    wol_topic?: string;
    lamp_topic?: string;
  }) => req<WolState & { ok: boolean }>('/api/mqtt/config', { method: 'PUT', body: JSON.stringify(body) }),
  mqttReconnect: () => req<WolState & { ok: boolean }>('/api/mqtt/reconnect', { method: 'POST' }),
  tunnelConfig: (body: { enabled?: boolean; url?: string; secret?: string }) =>
    req<WolState & { ok: boolean }>('/api/tunnel/config', { method: 'PUT', body: JSON.stringify(body) }),
  tunnelReconnect: () => req<WolState & { ok: boolean }>('/api/tunnel/reconnect', { method: 'POST' }),

  livingCostGet: () => req<LivingCostData>('/api/living-cost'),
  livingCostSave: (data: LivingCostData) =>
    req<{ ok: boolean; bytes?: number }>('/api/living-cost', { method: 'PUT', body: JSON.stringify(data) }),
};

type Listener = (msg: WsMessage) => void;
type StatusListener = (connected: boolean) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private active = false;
  private timer: number | null = null;
  public connected = false;

  start() {
    if (this.active) return;
    this.active = true;
    this.connect();
  }

  stop() {
    this.active = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setConn(false);
  }

  private setConn(v: boolean) {
    this.connected = v;
    this.statusListeners.forEach((fn) => fn(v));
  }

  private connect() {
    if (!this.active) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => this.setConn(true);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WsMessage;
        this.listeners.forEach((fn) => fn(msg));
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      this.setConn(false);
      this.ws = null;
      if (this.active) {
        this.timer = window.setTimeout(() => this.connect(), 2000);
      }
    };
    ws.onerror = () => ws.close();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribeStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    fn(this.connected);
    return () => this.statusListeners.delete(fn);
  }
}

export const wsClient = new WsClient();
