# Lightweight HTTP/1.1 Keep-Alive client (HTTPS/HTTP) for CanMV K230 MicroPython
import socket
import ssl


class KeepAliveHttpsClient:
    def __init__(self, host, port=443, use_ssl=True, timeout=8.0):
        self.host = host
        self.port = int(port)
        self.use_ssl = bool(use_ssl)
        self.timeout = float(timeout)
        self.raw_sock = None
        self.sock = None

    def connect(self):
        self.close()
        ai = socket.getaddrinfo(self.host, self.port)[0][-1]
        raw = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        raw.settimeout(self.timeout)
        raw.connect(ai)
        self.raw_sock = raw
        if self.use_ssl:
            self.sock = ssl.wrap_socket(raw, server_hostname=self.host)
        else:
            self.sock = raw

    def close(self):
        for s in (self.sock, self.raw_sock):
            if s is not None:
                try:
                    s.close()
                except Exception:
                    pass
        self.sock = None
        self.raw_sock = None

    def _sock_read(self, n):
        if hasattr(self.sock, "read"):
            return self.sock.read(n)
        return self.sock.recv(n)

    def _write_all(self, data):
        total = len(data)
        sent = 0
        mv = None
        while sent < total:
            if sent == 0:
                chunk = data
            else:
                if mv is None:
                    mv = memoryview(data)
                chunk = mv[sent:]
            if hasattr(self.sock, "write"):
                n = self.sock.write(chunk)
            else:
                n = self.sock.send(chunk)
            if n is None or n <= 0:
                raise OSError("Socket write failed")
            sent += n

    def _read_line(self):
        if hasattr(self.sock, "readline"):
            line = self.sock.readline()
            if not line:
                raise OSError("HTTP EOF")
            return line
        out = bytearray()
        while len(out) < 4096:
            c = self._sock_read(1)
            if not c:
                raise OSError("HTTP EOF")
            out.extend(c)
            if c == b"\n":
                return bytes(out)
        raise OSError("HTTP line too large")

    def _read_exact(self, n):
        if n <= 0:
            return b""
        out = bytearray()
        while len(out) < n:
            need = n - len(out)
            chunk = self._sock_read(need)
            if not chunk:
                raise OSError("HTTP EOF")
            out.extend(chunk)
        return bytes(out)

    def _read_chunked(self):
        out = bytearray()
        while True:
            line = self._read_line().strip()
            semi = line.find(b";")
            if semi >= 0:
                line = line[:semi]
            size = int(line.strip(), 16)
            if size == 0:
                while True:
                    trailer = self._read_line()
                    if trailer in (b"\r\n", b"\n"):
                        break
                break
            out.extend(self._read_exact(size))
            self._read_exact(2)
        return bytes(out)

    def _do_request(self, method, path, body, content_type):
        if self.sock is None:
            self.connect()
        default_port = 443 if self.use_ssl else 80
        host_hdr = self.host if self.port == default_port else "%s:%d" % (self.host, self.port)
        lines = [
            "%s %s HTTP/1.1" % (method, path),
            "Host: " + host_hdr,
            "User-Agent: K230-Cam/1.0",
            "Connection: keep-alive",
        ]
        if body is not None:
            if content_type:
                lines.append("Content-Type: " + content_type)
            lines.append("Content-Length: %d" % len(body))
        elif method in ("POST", "PUT"):
            lines.append("Content-Length: 0")

        hdr_bytes = ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")
        self._write_all(hdr_bytes)
        if body is not None and len(body) > 0:
            self._write_all(body)

        status_line = self._read_line().decode("utf-8", "ignore").strip()
        status_parts = status_line.split(" ")
        status = int(status_parts[1]) if len(status_parts) > 1 else 0

        content_len = None
        chunked = False
        conn_close = False
        while True:
            raw_line = self._read_line()
            if raw_line in (b"\r\n", b"\n"):
                break
            line = raw_line.decode("utf-8", "ignore").strip()
            colon = line.find(":")
            if colon <= 0:
                continue
            k = line[:colon].strip().lower()
            v = line[colon + 1:].strip()
            if k == "content-length":
                content_len = int(v)
            elif k == "transfer-encoding" and "chunked" in v.lower():
                chunked = True
            elif k == "connection" and "close" in v.lower():
                conn_close = True

        if chunked:
            resp_body = self._read_chunked()
        elif content_len is not None:
            resp_body = self._read_exact(content_len)
        else:
            chunks = []
            while True:
                c = self._sock_read(512)
                if not c:
                    break
                chunks.append(c)
            resp_body = b"".join(chunks)
            conn_close = True

        if conn_close:
            self.close()
        return status, resp_body

    def request(self, method, path, body=None, content_type=None):
        reused = self.sock is not None
        try:
            return self._do_request(method, path, body, content_type)
        except Exception:
            self.close()
            if not reused:
                raise
            return self._do_request(method, path, body, content_type)
