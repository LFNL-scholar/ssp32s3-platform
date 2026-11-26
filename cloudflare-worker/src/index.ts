import { DurableObject } from 'cloudflare:workers';

export interface Env {
  TUNNEL: DurableObjectNamespace<DeviceTunnel>;
  ASSETS: Fetcher;
  TUNNEL_SECRET?: string;
  CAM_SECRET?: string;
}

interface PendingReq {
  resolve: (res: TunnelHttpRes) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TunnelHttpRes {
  id: number;
  status: number;
  content_type?: string;
  set_cookie?: string;
  body?: string;
}

interface CamConfig {
  privacy: boolean;
  away_only: boolean;
  fps: number;
  quality: number;
  res: string;
  lan_url: string;
}

interface CamMeta {
  ip: string;
  res: string;
  fps: number;
  quality: number;
  lastFrameAt: number;
  frameBytes: number;
  actualFps: number;
}

const DEFAULT_CAM_CFG: CamConfig = {
  privacy: false,
  away_only: false,
  fps: 8,
  quality: 60,
  res: '640x368',
  lan_url: '',
};

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export class DeviceTunnel extends DurableObject<Env> {
  private pending = new Map<number, PendingReq>();
  private nextId = 1;
  private camCfg: CamConfig | null = null;
  private camMeta: CamMeta = {
    ip: '',
    res: '640x368',
    fps: 8,
    quality: 60,
    lastFrameAt: 0,
    frameBytes: 0,
    actualFps: 0,
  };
  private lastFrame: ArrayBuffer | null = null;
  private camStreaming = false;
  private lastHomeBlocked = false;
  private camHttpLastSeenAt = 0;
  private lastCamStatusBcastAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async getCamCfg(): Promise<CamConfig> {
    if (!this.camCfg) {
      const stored = await this.ctx.storage.get<Partial<CamConfig>>('cam_cfg');
      this.camCfg = { ...DEFAULT_CAM_CFG, ...(stored || {}) };
    }
    return this.camCfg;
  }

  private async saveCamCfg(next: CamConfig): Promise<void> {
    this.camCfg = next;
    await this.ctx.storage.put('cam_cfg', next);
  }

  private getDeviceSocket(): WebSocket | null {
    const sockets = this.ctx.getWebSockets('device');
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) return ws;
    }
    return null;
  }

  private getCamSocket(): WebSocket | null {
    const sockets = this.ctx.getWebSockets('cam');
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) return ws;
    }
    return null;
  }

  private getCamViewers(): WebSocket[] {
    return this.ctx.getWebSockets('cam_viewer').filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private async checkAuthCookie(cookie: string): Promise<boolean> {
    try {
      const authRes = await this.proxyHttpOverTunnel('GET', '/api/auth/status', cookie, '', '', 6000);
      const parsed = JSON.parse(authRes.body || '{}') as { authenticated?: boolean };
      return Boolean(parsed.authenticated);
    } catch {
      return false;
    }
  }

  private async isAnyoneHome(cookie: string): Promise<boolean> {
    try {
      const res = await this.proxyHttpOverTunnel('GET', '/api/presence/state', cookie, '', '', 4000);
      if (res.status !== 200 || !res.body) return false;
      const parsed = JSON.parse(res.body) as { persons?: { is_home?: boolean }[] };
      return Boolean(parsed.persons?.some((p) => p.is_home));
    } catch {
      return false;
    }
  }

  private isCamOnline(): boolean {
    if (this.getCamSocket() !== null) return true;
    return this.camHttpLastSeenAt > 0 && Date.now() - this.camHttpLastSeenAt < 10000;
  }

  private verifyCamSecret(url: URL, request: Request): boolean {
    const expected = this.env.CAM_SECRET || this.env.TUNNEL_SECRET || '';
    const supplied = url.searchParams.get('secret') || request.headers.get('X-Tunnel-Secret') || '';
    return Boolean(expected && constantTimeEqual(supplied, expected));
  }

  private buildCamCtrlPayload(cfg: CamConfig) {
    const blocked = cfg.away_only ? this.lastHomeBlocked : false;
    const viewers = this.getCamViewers().length;
    const wantStream = Boolean(viewers > 0 && !cfg.privacy && !blocked);
    this.camStreaming = wantStream;
    return {
      ok: true,
      streaming: wantStream,
      fps: cfg.fps,
      quality: cfg.quality,
      res: cfg.res,
      privacy: cfg.privacy,
      viewers,
    };
  }

  private broadcastCamStatus(cfg: CamConfig, blocked: boolean): void {
    const statusMsg = JSON.stringify({
      type: 'cam_status',
      ...this.buildCamStatusPayload(cfg, blocked),
    });
    for (const v of this.getCamViewers()) {
      try {
        v.send(statusMsg);
      } catch {
        /* ignore */
      }
    }
  }

  private buildCamStatusPayload(cfg: CamConfig, homeBlocked: boolean) {
    const online = this.isCamOnline();
    const viewers = this.getCamViewers().length;
    const lastAgo = this.camMeta.lastFrameAt > 0
      ? Math.max(0, Math.round((Date.now() - this.camMeta.lastFrameAt) / 1000))
      : -1;
    return {
      ok: true,
      via: 'cloud',
      online,
      streaming: online && this.camStreaming && !cfg.privacy && !homeBlocked,
      privacy: cfg.privacy,
      away_only: cfg.away_only,
      home_blocked: homeBlocked,
      viewers,
      lan_ip: this.camMeta.ip,
      lan_url: cfg.lan_url,
      res: cfg.res,
      fps: cfg.fps,
      quality: cfg.quality,
      frame_bytes: this.camMeta.frameBytes,
      actual_fps: this.camMeta.actualFps,
      last_frame_ago_s: lastAgo,
    };
  }

  private async syncCamStreaming(homeBlocked?: boolean): Promise<void> {
    const cfg = await this.getCamCfg();
    if (homeBlocked !== undefined) {
      this.lastHomeBlocked = homeBlocked;
    }
    const blocked = cfg.away_only ? this.lastHomeBlocked : false;
    const cam = this.getCamSocket();
    const online = this.isCamOnline();
    const viewers = this.getCamViewers();
    const wantStream = Boolean(online && viewers.length > 0 && !cfg.privacy && !blocked);
    this.camStreaming = wantStream;

    if (cam) {
      try {
        cam.send(
          JSON.stringify({
            type: 'ctrl',
            streaming: wantStream,
            fps: cfg.fps,
            quality: cfg.quality,
            res: cfg.res,
            privacy: cfg.privacy,
          })
        );
      } catch {
        /* ignore */
      }
    }

    this.broadcastCamStatus(cfg, blocked);
  }

  private proxyHttpOverTunnel(
    method: string,
    pathWithQuery: string,
    cookie: string,
    contentType: string,
    body: string,
    timeoutMs = 12000
  ): Promise<TunnelHttpRes> {
    const dev = this.getDeviceSocket();
    if (!dev) {
      return Promise.reject(new Error('device_offline'));
    }

    const id = this.nextId++;
    if (this.nextId > 1_000_000) this.nextId = 1;

    return new Promise<TunnelHttpRes>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('tunnel_timeout'));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        dev.send(
          JSON.stringify({
            type: 'http_req',
            id,
            method,
            path: pathWithQuery,
            cookie,
            content_type: contentType,
            body,
          })
        );
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error('send_failed'));
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1. ESP32-S3 device outbound tunnel connection
    if (url.pathname === '/tunnel/connect') {
      const expected = this.env.TUNNEL_SECRET || '';
      const supplied = url.searchParams.get('secret') || request.headers.get('X-Tunnel-Secret') || '';
      if (!expected || !constantTimeEqual(supplied, expected)) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      for (const old of this.ctx.getWebSockets('device')) {
        try {
          old.close(1000, 'replaced');
        } catch {
          /* ignore */
        }
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ['device']);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Public tunnel health check
    if (url.pathname === '/tunnel/status') {
      const online = this.getDeviceSocket() !== null;
      const clients = this.ctx.getWebSockets('client').length;
      const camOnline = this.isCamOnline();
      const camViewers = this.getCamViewers().length;
      return Response.json({ ok: true, device_online: online, clients, cam_online: camOnline, cam_viewers: camViewers });
    }

    // 2a. K230 HTTP keep-alive control poll & JPEG frame upload (non-blocking alternative to WSS)
    if (url.pathname === '/cam/poll') {
      if (!this.verifyCamSecret(url, request)) {
        return new Response('Unauthorized', { status: 401 });
      }
      const wasOnline = this.isCamOnline();
      this.camHttpLastSeenAt = Date.now();
      const qIp = url.searchParams.get('ip');
      const qRes = url.searchParams.get('res');
      const qFps = url.searchParams.get('fps');
      const qQual = url.searchParams.get('q');
      const qActualFps = url.searchParams.get('actual_fps');
      if (qIp) this.camMeta.ip = qIp.slice(0, 64);
      if (qRes) this.camMeta.res = qRes.slice(0, 16);
      if (qFps && !Number.isNaN(Number(qFps))) this.camMeta.fps = Number(qFps);
      if (qQual && !Number.isNaN(Number(qQual))) this.camMeta.quality = Number(qQual);
      if (qActualFps && !Number.isNaN(Number(qActualFps))) this.camMeta.actualFps = Number(qActualFps);
      const cfg = await this.getCamCfg();
      if (!wasOnline) {
        this.broadcastCamStatus(cfg, cfg.away_only ? this.lastHomeBlocked : false);
      }
      return Response.json(this.buildCamCtrlPayload(cfg), {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/cam/frame' && request.method === 'POST') {
      if (!this.verifyCamSecret(url, request)) {
        return new Response('Unauthorized', { status: 401 });
      }
      this.camHttpLastSeenAt = Date.now();
      const qIp = url.searchParams.get('ip');
      const qRes = url.searchParams.get('res');
      const qActualFps = url.searchParams.get('actual_fps');
      if (qIp) this.camMeta.ip = qIp.slice(0, 64);
      if (qRes) this.camMeta.res = qRes.slice(0, 16);
      if (qActualFps && !Number.isNaN(Number(qActualFps))) this.camMeta.actualFps = Number(qActualFps);

      const cfg = await this.getCamCfg();
      const blocked = cfg.away_only ? this.lastHomeBlocked : false;
      const buf = await request.arrayBuffer();
      if (!cfg.privacy && !blocked && buf.byteLength > 100 && buf.byteLength <= 512 * 1024) {
        this.lastFrame = buf;
        this.camMeta.lastFrameAt = Date.now();
        this.camMeta.frameBytes = buf.byteLength;
        for (const viewer of this.getCamViewers()) {
          try {
            viewer.send(buf);
          } catch {
            /* ignore */
          }
        }
        if (Date.now() - this.lastCamStatusBcastAt >= 3000) {
          this.lastCamStatusBcastAt = Date.now();
          this.broadcastCamStatus(cfg, blocked);
        }
      }
      return Response.json(this.buildCamCtrlPayload(cfg), {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    // 2b. K230 camera node outbound WSS connection
    if (url.pathname === '/cam/connect') {
      if (!this.verifyCamSecret(url, request)) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      for (const old of this.ctx.getWebSockets('cam')) {
        try {
          old.close(1000, 'replaced');
        } catch {
          /* ignore */
        }
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ['cam']);
      await this.syncCamStreaming();
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2c. Browser /cam/ws live video stream WebSocket
    if (url.pathname === '/cam/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      const cookie = request.headers.get('Cookie') || '';
      const authed = await this.checkAuthCookie(cookie);
      if (!authed) {
        return new Response('Unauthorized', { status: 401 });
      }

      const cfg = await this.getCamCfg();
      const homeBlocked = cfg.away_only ? await this.isAnyoneHome(cookie) : false;

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ['cam_viewer']);

      await this.syncCamStreaming(homeBlocked);
      if (!cfg.privacy && !homeBlocked && this.lastFrame) {
        try {
          server.send(this.lastFrame);
        } catch {
          /* ignore */
        }
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2d. Camera REST endpoints handled directly at the Cloudflare edge (never proxied to ESP32-S3)
    if (url.pathname === '/api/cam/status' || url.pathname === '/api/cam/config' || url.pathname === '/api/cam/snapshot') {
      const cookie = request.headers.get('Cookie') || '';
      const authed = await this.checkAuthCookie(cookie);
      if (!authed) {
        return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }

      const cfg = await this.getCamCfg();
      if (url.pathname === '/api/cam/config' && request.method === 'PUT') {
        let patch: Partial<CamConfig> = {};
        try {
          patch = (await request.json()) as Partial<CamConfig>;
        } catch {
          return Response.json({ ok: false, error: '请求体无效' }, { status: 400 });
        }
        const next: CamConfig = {
          privacy: typeof patch.privacy === 'boolean' ? patch.privacy : cfg.privacy,
          away_only: typeof patch.away_only === 'boolean' ? patch.away_only : cfg.away_only,
          fps: typeof patch.fps === 'number' ? Math.max(1, Math.min(15, Math.round(patch.fps))) : cfg.fps,
          quality: typeof patch.quality === 'number' ? Math.max(25, Math.min(85, Math.round(patch.quality))) : cfg.quality,
          res: patch.res === '320x240' || patch.res === '640x368' || patch.res === '800x448' ? patch.res : cfg.res,
          lan_url: typeof patch.lan_url === 'string' ? patch.lan_url.trim().slice(0, 96) : cfg.lan_url,
        };
        await this.saveCamCfg(next);
        const homeBlocked = next.away_only ? await this.isAnyoneHome(cookie) : false;
        await this.syncCamStreaming(homeBlocked);
        return Response.json(this.buildCamStatusPayload(next, homeBlocked));
      }

      const homeBlocked = cfg.away_only ? await this.isAnyoneHome(cookie) : false;
      this.lastHomeBlocked = homeBlocked;

      if (url.pathname === '/api/cam/snapshot') {
        if (cfg.privacy || homeBlocked) {
          return Response.json({ ok: false, error: '隐私保护已开启，禁止抓拍' }, { status: 403 });
        }
        if (!this.lastFrame) {
          return Response.json({ ok: false, error: '暂无可用画面帧' }, { status: 404 });
        }
        return new Response(this.lastFrame, {
          status: 200,
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'no-store',
          },
        });
      }

      return Response.json(this.buildCamStatusPayload(cfg, homeBlocked), {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    // 3. Browser /ws live telemetry WebSocket
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      const cookie = request.headers.get('Cookie') || '';
      try {
        const authRes = await this.proxyHttpOverTunnel('GET', '/api/auth/status', cookie, '', '', 6000);
        const parsed = JSON.parse(authRes.body || '{}') as { authenticated?: boolean };
        if (!parsed.authenticated) {
          return new Response('Unauthorized', { status: 401 });
        }
      } catch {
        return new Response('Device Offline', { status: 503 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ['client']);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 4. Proxy /api/* requests through the ESP32-S3 tunnel
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/ota' || url.pathname === '/api/ota/www' || url.pathname === '/api/lamp/sample/upload') {
        return Response.json(
          { ok: false, error: '大文件上传/OTA 升级请在家庭局域网内进行' },
          { status: 413 }
        );
      }

      const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
      if (body.length > 16384) {
        return Response.json({ ok: false, error: '请求体超过云端隧道限制 (16KB)' }, { status: 413 });
      }

      const cookie = request.headers.get('Cookie') || '';
      const contentType = request.headers.get('Content-Type') || '';
      const pathWithQuery = url.pathname + url.search;

      try {
        const res = await this.proxyHttpOverTunnel(request.method, pathWithQuery, cookie, contentType, body);
        const headers = new Headers();
        headers.set('Content-Type', res.content_type || 'application/json; charset=utf-8');
        headers.set('Cache-Control', 'no-store');
        if (res.set_cookie) {
          const sc = res.set_cookie.includes('Secure') ? res.set_cookie : `${res.set_cookie}; Secure`;
          headers.set('Set-Cookie', sc);
        }
        return new Response(res.body || '', { status: res.status || 200, headers });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'tunnel_error';
        if (msg === 'device_offline') {
          return Response.json(
            { ok: false, error: 'ESP32-S3 云端隧道未连接（设备离线或未开启云端隧道）' },
            { status: 503 }
          );
        }
        return Response.json({ ok: false, error: 'ESP32-S3 响应超时，请稍后重试' }, { status: 504 });
      }
    }

    return new Response('Not Found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(ws);

    if (tags.includes('cam')) {
      if (message instanceof ArrayBuffer) {
        const cfg = await this.getCamCfg();
        const blocked = cfg.away_only ? this.lastHomeBlocked : false;
        if (cfg.privacy || blocked) return;
        this.lastFrame = message;
        this.camMeta.lastFrameAt = Date.now();
        this.camMeta.frameBytes = message.byteLength;
        for (const viewer of this.getCamViewers()) {
          try {
            viewer.send(message);
          } catch {
            /* ignore */
          }
        }
        return;
      }

      const text = message;
      if (text === 'ping') {
        try {
          ws.send('pong');
        } catch {
          /* ignore */
        }
        return;
      }

      try {
        const msg = JSON.parse(text) as {
          type?: string;
          ip?: string;
          res?: string;
          fps?: number;
          quality?: number;
          actual_fps?: number;
          frame_bytes?: number;
        };
        if (msg.type === 'hello' || msg.type === 'stats') {
          if (typeof msg.ip === 'string') this.camMeta.ip = msg.ip;
          if (typeof msg.res === 'string') this.camMeta.res = msg.res;
          if (typeof msg.fps === 'number') this.camMeta.fps = msg.fps;
          if (typeof msg.quality === 'number') this.camMeta.quality = msg.quality;
          if (typeof msg.actual_fps === 'number') this.camMeta.actualFps = msg.actual_fps;
          if (typeof msg.frame_bytes === 'number') this.camMeta.frameBytes = msg.frame_bytes;

          if (msg.type === 'hello') {
            await this.syncCamStreaming();
          } else {
            const cfg = await this.getCamCfg();
            const blocked = cfg.away_only ? this.lastHomeBlocked : false;
            const statusMsg = JSON.stringify({
              type: 'cam_status',
              ...this.buildCamStatusPayload(cfg, blocked),
            });
            for (const v of this.getCamViewers()) {
              try {
                v.send(statusMsg);
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch {
        /* ignore */
      }
      return;
    }

    if (tags.includes('cam_viewer')) {
      if (typeof message === 'string' && message === 'ping') {
        try {
          ws.send('pong');
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (!tags.includes('device')) {
      return;
    }

    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (text === 'ping') {
      try {
        ws.send('pong');
      } catch {
        /* ignore */
      }
      return;
    }

    let msg: { type?: string; id?: number; payload?: string } & TunnelHttpRes;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg.type === 'http_res' && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
    } else if (msg.type === 'ws_bcast' && typeof msg.payload === 'string') {
      for (const client of this.ctx.getWebSockets('client')) {
        try {
          client.send(msg.payload);
        } catch {
          /* ignore closed client */
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const tags = this.ctx.getTags(ws);
    if (tags.includes('device')) {
      for (const [id, p] of this.pending.entries()) {
        clearTimeout(p.timer);
        p.reject(new Error('device_offline'));
        this.pending.delete(id);
      }
    } else if (tags.includes('cam')) {
      this.lastFrame = null;
      this.camStreaming = false;
      await this.syncCamStreaming();
    } else if (tags.includes('cam_viewer')) {
      await this.syncCamStreaming();
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname === '/ws' ||
      url.pathname.startsWith('/tunnel/') ||
      url.pathname.startsWith('/cam/')
    ) {
      const stub = env.TUNNEL.getByName('esp32s3-main');
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
