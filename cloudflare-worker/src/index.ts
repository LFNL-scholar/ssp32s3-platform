import { DurableObject } from 'cloudflare:workers';

export interface Env {
  TUNNEL: DurableObjectNamespace<DeviceTunnel>;
  ASSETS: Fetcher;
  TUNNEL_SECRET?: string;
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private getDeviceSocket(): WebSocket | null {
    const sockets = this.ctx.getWebSockets('device');
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) return ws;
    }
    return null;
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

      // Close any existing stale device sockets
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
      return Response.json({ ok: true, device_online: online, clients });
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
          // Ensure Secure flag on HTTPS edge
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
      url.pathname.startsWith('/tunnel/')
    ) {
      const stub = env.TUNNEL.getByName('esp32s3-main');
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
