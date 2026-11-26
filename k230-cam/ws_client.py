# Lightweight RFC-6455 WebSocket client for CanMV K230 MicroPython (ws:// & wss://)
import binascii
import random
import socket
import ssl
import struct
import time

try:
    random.seed(time.ticks_us())
except Exception:
    pass


def _rand_bytes(n):
    return bytes([random.getrandbits(8) for _ in range(n)])


def _parse_url(url):
    if url.startswith("wss://"):
        is_ssl = True
        rest = url[6:]
        default_port = 443
    elif url.startswith("ws://"):
        is_ssl = False
        rest = url[5:]
        default_port = 80
    else:
        raise ValueError("Unsupported URL scheme")

    slash = rest.find("/")
    if slash < 0:
        hostport = rest
        path = "/"
    else:
        hostport = rest[:slash]
        path = rest[slash:]

    if ":" in hostport:
        host, pstr = hostport.split(":", 1)
        port = int(pstr)
    else:
        host = hostport
        port = default_port

    return is_ssl, host, port, path


def _mask_payload(mask, data):
    n = len(data)
    out = bytearray(data)
    m0, m1, m2, m3 = mask[0], mask[1], mask[2], mask[3]
    i = 0
    limit = n - 3
    while i < limit:
        out[i] ^= m0
        out[i + 1] ^= m1
        out[i + 2] ^= m2
        out[i + 3] ^= m3
        i += 4
    while i < n:
        out[i] ^= mask[i & 3]
        i += 1
    return out


class WebSocketClient:
    def __init__(self):
        self.raw_sock = None
        self.sock = None
        self.connected = False

    def connect(self, url, timeout=8):
        self.close()
        is_ssl, host, port, path = _parse_url(url)
        ai = socket.getaddrinfo(host, port)[0][-1]
        raw = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        raw.settimeout(timeout)
        raw.connect(ai)
        self.raw_sock = raw

        if is_ssl:
            s = ssl.wrap_socket(raw, server_hostname=host)
        else:
            s = raw
        self.sock = s

        sec_key = binascii.b2a_base64(_rand_bytes(16)).strip().decode()
        req = (
            "GET %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "Origin: https://%s\r\n\r\n"
        ) % (path, host, port, sec_key, host)
        self._write_all(req.encode())

        hdr = b""
        while b"\r\n\r\n" not in hdr:
            chunk = self.sock.read(512) if hasattr(self.sock, "read") else self.sock.recv(512)
            if not chunk:
                raise OSError("Handshake EOF")
            hdr += chunk
            if len(hdr) > 4096:
                raise OSError("Handshake header too large")

        status_line = hdr.split(b"\r\n", 1)[0]
        if b"101" not in status_line:
            raise OSError("WS handshake failed: " + status_line.decode("utf-8", "ignore"))

        self.raw_sock.settimeout(None)
        self.connected = True

    def _write_all(self, data):
        mv = memoryview(data)
        total = len(data)
        sent = 0
        while sent < total:
            if hasattr(self.sock, "write"):
                n = self.sock.write(mv[sent:])
            else:
                n = self.sock.send(mv[sent:])
            if n is None or n <= 0:
                raise OSError("Socket write failed")
            sent += n

    def _read_exact(self, n):
        buf = bytearray()
        while len(buf) < n:
            need = n - len(buf)
            chunk = self.sock.read(need) if hasattr(self.sock, "read") else self.sock.recv(need)
            if not chunk:
                raise OSError("WebSocket EOF")
            buf.extend(chunk)
        return bytes(buf)

    def send_frame(self, opcode, payload):
        if not self.connected or not self.sock:
            raise OSError("Not connected")
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        length = len(payload)
        hdr = bytearray()
        hdr.append(0x80 | (opcode & 0x0F))
        if length < 126:
            hdr.append(0x80 | length)
        elif length < 65536:
            hdr.append(0x80 | 126)
            hdr.extend(struct.pack(">H", length))
        else:
            hdr.append(0x80 | 127)
            hdr.extend(struct.pack(">Q", length))
        mask = _rand_bytes(4)
        hdr.extend(mask)
        masked = _mask_payload(mask, payload)
        self._write_all(hdr)
        if length > 0:
            self._write_all(masked)

    def send_text(self, text):
        self.send_frame(0x1, text)

    def send_binary(self, data):
        self.send_frame(0x2, data)

    def recv_frame(self):
        if not self.connected or not self.sock:
            return None
        h = self._read_exact(2)
        opcode = h[0] & 0x0F
        masked = (h[1] & 0x80) != 0
        length = h[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_exact(8))[0]
        mask = self._read_exact(4) if masked else None
        payload = self._read_exact(length) if length > 0 else b""
        if mask:
            payload = bytes(_mask_payload(mask, payload))

        if opcode == 0x8:  # Close
            self.close()
            return ("close", None)
        if opcode == 0x9:  # Ping -> Pong
            return ("ping", payload)
        if opcode == 0xA:  # Pong
            return ("pong", None)
        if opcode == 0x1:
            return ("text", payload.decode("utf-8", "ignore"))
        return ("bin", payload)

    def close(self):
        self.connected = False
        for s in (self.sock, self.raw_sock):
            if s:
                try:
                    s.close()
                except Exception:
                    pass
        self.sock = None
        self.raw_sock = None
