# LCSC Lushan-Pi K230 (CanMV) High-Speed LAN MJPEG Node
# Pure single-threaded HTTP MJPEG server with 3-channel VICAP + 720p VPU hardware MJPEG
import gc
import json
import network
import os
import socket
import time
import uctypes

from media.display import Display
from media.media import MediaManager
from media.sensor import Sensor, CAM_CHN_ID_0, CAM_CHN_ID_1, CAM_CHN_ID_2
from media.vencoder import (
    Encoder,
    StreamData,
    k_venc_chn_attr,
    K_PT_MJPEG,
    K_VENC_RC_MODE_MJPEG_FIXQP,
    VENC_CHN_ID_0,
    VENC_DEV_ID,
    VIDEO_ENCODE_MOD_ID,
    kd_mpi_venc_create_chn,
    kd_mpi_venc_start_chn,
)

try:
    import config
except ImportError:
    raise RuntimeError("Missing config.py! Copy config.example.py to config.py and set WIFI_SSID/WIFI_PASS.")

RES_SET = ("640x368", "1280x720", "1920x1080")


def _parse_query(path_with_query):
    q_idx = path_with_query.find("?")
    if q_idx < 0:
        return path_with_query, {}
    path = path_with_query[:q_idx]
    qs = path_with_query[q_idx + 1:]
    params = {}
    for pair in qs.split("&"):
        if "=" in pair:
            k, v = pair.split("=", 1)
            params[k] = v
    return path, params


def _read_http_line(cli):
    if hasattr(cli, "readline"):
        return cli.readline()
    out = bytearray()
    while len(out) < 2048:
        c = cli.recv(1)
        if not c:
            break
        out.extend(c)
        if c == b"\n":
            break
    return bytes(out)


def _send_all(cli, data):
    total = len(data)
    if total <= 16384:
        cli.sendall(data)
        return
    mv = memoryview(data)
    off = 0
    while off < total:
        end = off + 16384
        if end > total:
            end = total
        cli.sendall(mv[off:end])
        off = end


class LanMjpegNode:
    def __init__(self):
        self.res = getattr(config, "DEFAULT_RES", "1280x720")
        if self.res not in RES_SET:
            self.res = "1280x720"
        self.fps = max(1, min(30, int(getattr(config, "DEFAULT_FPS", 20))))
        self.quality = max(30, min(95, int(getattr(config, "DEFAULT_QUALITY", 75))))
        self.port = int(getattr(config, "LAN_PORT", 8080))

        self.wlan = network.WLAN(0)
        self.ip = "0.0.0.0"
        self.sensor = None
        self.enc = None
        self.link = None
        self.sd = None
        self.srv = None

        self.running = True
        self.frame_bytes = 0
        self.actual_fps = 0.0

    def ensure_wifi(self):
        if self.wlan.isconnected():
            ip = self.wlan.ifconfig()[0]
            if ip and ip != "0.0.0.0":
                self.ip = ip
                return True
        print("Connecting Wi-Fi (2.4GHz):", config.WIFI_SSID)
        try:
            self.wlan.connect(config.WIFI_SSID, config.WIFI_PASS)
        except Exception as e:
            print("Wi-Fi connect err:", e)
        deadline = time.ticks_add(time.ticks_ms(), 15000)
        while time.ticks_diff(deadline, time.ticks_ms()) > 0:
            os.exitpoint()
            if self.wlan.isconnected() and self.wlan.ifconfig()[0] != "0.0.0.0":
                self.ip = self.wlan.ifconfig()[0]
                print("Wi-Fi connected! K230 LAN IP:", self.ip)
                return True
            time.sleep_ms(250)
        print("Wi-Fi connection timeout")
        return False

    def init_pipeline(self):
        print("Init 3-channel hybrid vision pipeline (720p HW MJPEG + 1080p + 368p)...")
        s = Sensor(id=2)
        self.sensor = s
        s.reset()
        if getattr(config, "H_MIRROR", False):
            s.set_hmirror(True)
        if getattr(config, "V_FLIP", False):
            s.set_vflip(True)

        # CHN0: 1280x720 YUV420SP -> Hardware VPU MJPEG (up to 50 FPS)
        s.set_framesize(width=1280, height=720, chn=CAM_CHN_ID_0)
        s.set_pixformat(Sensor.YUV420SP, chn=CAM_CHN_ID_0)

        # CHN1: 1920x1080 RGB565 -> High-res detail mode & snapshots
        s.set_framesize(width=1920, height=1080, chn=CAM_CHN_ID_1)
        s.set_pixformat(Sensor.RGB565, chn=CAM_CHN_ID_1)

        # CHN2: 640x368 RGB565 -> Low-bandwidth fallback
        s.set_framesize(width=640, height=368, chn=CAM_CHN_ID_2)
        s.set_pixformat(Sensor.RGB565, chn=CAM_CHN_ID_2)

        Display.init(Display.VIRT, width=1280, height=720, to_ide=False)

        enc = Encoder()
        self.enc = enc
        enc.SetOutBufs(VENC_CHN_ID_0, 6, 1280, 720)
        MediaManager.init()

        self.link = MediaManager.link(
            s.bind_info(chn=CAM_CHN_ID_0)["src"],
            (VIDEO_ENCODE_MOD_ID, VENC_DEV_ID, VENC_CHN_ID_0),
        )
        q_factor = max(30, min(95, int(getattr(config, "HW_Q_FACTOR", 85))))
        ca = k_venc_chn_attr()
        ca.venc_attr.type = K_PT_MJPEG
        ca.venc_attr.pic_width = 1280
        ca.venc_attr.pic_height = 720
        ca.venc_attr.profile = 0
        ca.venc_attr.stream_buf_size = 1280 * 720
        ca.venc_attr.stream_buf_cnt = 6
        ca.rc_attr.rc_mode = K_VENC_RC_MODE_MJPEG_FIXQP
        ca.rc_attr.mjpeg_fixqp.src_frame_rate = 30
        ca.rc_attr.mjpeg_fixqp.dst_frame_rate = 30
        ca.rc_attr.mjpeg_fixqp.q_factor = q_factor
        ret_c = kd_mpi_venc_create_chn(VENC_CHN_ID_0, ca)
        if ret_c != 0:
            raise RuntimeError("kd_mpi_venc_create_chn failed: %d" % ret_c)
        ret_s = kd_mpi_venc_start_chn(VENC_CHN_ID_0)
        if ret_s != 0:
            raise RuntimeError("kd_mpi_venc_start_chn failed: %d" % ret_s)
        s.run()
        self.sd = StreamData()

        # Warmup 6 frames so AE settles and report 720p HW frame size
        for _ in range(6):
            self._capture_jpeg("1280x720", self.quality, drain=0)
        print("Vision pipeline ready! 720p HW frame KB:", round(self.frame_bytes / 1024.0, 1))

    def deinit_pipeline(self):
        if self.sensor is not None:
            try:
                self.sensor.stop()
            except BaseException:
                pass
            self.sensor = None
        if self.link is not None:
            try:
                del self.link
            except BaseException:
                pass
            self.link = None
        if self.enc is not None:
            try:
                self.enc.Stop(VENC_CHN_ID_0)
            except BaseException:
                pass
            try:
                self.enc.Destroy(VENC_CHN_ID_0)
            except BaseException:
                pass
            self.enc = None
        try:
            Display.deinit()
        except BaseException:
            pass
        try:
            MediaManager.deinit()
        except BaseException:
            pass
        gc.collect()

    def _get_hw_720p_jpeg(self, drain=0):
        sd = self.sd
        enc = self.enc
        for _ in range(drain):
            enc.GetStream(VENC_CHN_ID_0, sd)
            if sd.pack_cnt > 0 and sd.data_size[0] > 0:
                enc.ReleaseStream(VENC_CHN_ID_0, sd)

        for _ in range(50):
            enc.GetStream(VENC_CHN_ID_0, sd)
            if sd.pack_cnt > 0 and sd.data_size[0] > 0:
                if sd.pack_cnt == 1:
                    jpg = uctypes.bytes_at(sd.data[0], sd.data_size[0])
                else:
                    parts = []
                    for p in range(sd.pack_cnt):
                        parts.append(uctypes.bytes_at(sd.data[p], sd.data_size[p]))
                    jpg = b"".join(parts)
                enc.ReleaseStream(VENC_CHN_ID_0, sd)
                return jpg
            time.sleep_ms(5)
        raise OSError("HW MJPEG timeout")

    def _get_sw_jpeg(self, chn, quality):
        img = self.sensor.snapshot(chn=chn)
        c = img.compress(quality=quality)
        return c.to_bytes() if hasattr(c, "to_bytes") else bytes(c)

    def _capture_jpeg(self, res, quality, drain=0):
        if res == "1280x720":
            b = self._get_hw_720p_jpeg(drain=drain)
        elif res == "1920x1080":
            b = self._get_sw_jpeg(CAM_CHN_ID_1, quality)
        else:
            b = self._get_sw_jpeg(CAM_CHN_ID_2, quality)
        self.frame_bytes = len(b)
        return b

    def _apply_params(self, params):
        if "res" in params and params["res"] in RES_SET:
            self.res = params["res"]
        if "fps" in params:
            try:
                self.fps = max(1, min(30, int(params["fps"])))
            except Exception:
                pass
        if "q" in params:
            try:
                self.quality = max(30, min(95, int(params["q"])))
            except Exception:
                pass

    def _cors_headers(self, ctype, length=None):
        lines = [
            "HTTP/1.1 200 OK",
            "Content-Type: " + ctype,
            "Cache-Control: no-store",
            "Access-Control-Allow-Origin: *",
            "Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS",
            "Access-Control-Allow-Headers: Content-Type",
            "Connection: close",
        ]
        if length is not None:
            lines.append("Content-Length: " + str(length))
        return ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")

    def _status_bytes(self):
        return json.dumps({
            "ok": True,
            "ip": self.ip,
            "res": self.res,
            "fps": self.fps,
            "quality": self.quality,
            "actual_fps": round(self.actual_fps, 1),
            "frame_bytes": self.frame_bytes,
            "hw_jpeg": self.res == "1280x720",
        }).encode("utf-8")

    def _serve_stream(self, cli):
        cli.sendall(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
            b"Cache-Control: no-store, no-cache, must-revalidate\r\n"
            b"Pragma: no-cache\r\n"
            b"Access-Control-Allow-Origin: *\r\n"
            b"Connection: close\r\n\r\n"
        )
        cli.settimeout(2.0)
        try:
            cli.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:
            pass
        res = self.res
        fps = self.fps
        quality = self.quality
        interval_ms = int(1000 / max(1, fps))

        # Flush stale VENC queued frames so initial frame is live
        first_drain = 6 if res == "1280x720" else 0
        cnt = 0
        win_cnt = 0
        win_start = time.ticks_ms()

        print("Stream start:", res, "target_fps=", fps, "q=", quality)
        try:
            while self.running:
                os.exitpoint()
                t0 = time.ticks_ms()
                jpg = self._capture_jpeg(res, quality, drain=first_drain)
                first_drain = 0
                t1 = time.ticks_ms()

                hdr = (
                    "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n"
                    % len(jpg)
                ).encode("ascii")
                cli.sendall(hdr + jpg + b"\r\n")
                t2 = time.ticks_ms()
                if cnt < 3:
                    print("  frame", cnt, "kb=", round(len(jpg) / 1024.0, 1), "cap_ms=", time.ticks_diff(t1, t0), "send_ms=", time.ticks_diff(t2, t1))

                cnt += 1
                win_cnt += 1
                now = time.ticks_ms()
                win_ms = time.ticks_diff(now, win_start)
                if win_ms >= 1500:
                    self.actual_fps = (win_cnt * 1000.0) / win_ms
                    win_cnt = 0
                    win_start = now

                if cnt >= 60:
                    cnt = 0
                    gc.collect()

                elapsed = time.ticks_diff(time.ticks_ms(), t0)
                rem = interval_ms - elapsed
                if rem > 2:
                    time.sleep_ms(rem)
        finally:
            print("Stream end:", res, "frames=", cnt)

    def _handle_client(self, cli):
        cli.settimeout(2.0)
        req_line = _read_http_line(cli)
        if not req_line:
            return
        while True:
            hdr_line = _read_http_line(cli)
            if not hdr_line or hdr_line in (b"\r\n", b"\n"):
                break

        first = req_line.decode("utf-8", "ignore").strip()
        parts = first.split(" ")
        method = parts[0] if len(parts) > 0 else "GET"
        raw_path = parts[1] if len(parts) > 1 else "/"
        path, params = _parse_query(raw_path)

        if method == "OPTIONS":
            cli.sendall(
                b"HTTP/1.1 204 No Content\r\n"
                b"Access-Control-Allow-Origin: *\r\n"
                b"Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\n"
                b"Access-Control-Allow-Headers: Content-Type\r\n"
                b"Connection: close\r\n\r\n"
            )
            return

        if path.startswith("/stream"):
            self._apply_params(params)
            self._serve_stream(cli)
            return

        if path.startswith("/snapshot"):
            self._apply_params(params)
            jpg = self._capture_jpeg(self.res, self.quality, drain=(6 if self.res == "1280x720" else 0))
            cli.sendall(self._cors_headers("image/jpeg", len(jpg)))
            _send_all(cli, jpg)
            return

        payload = self._status_bytes()
        cli.sendall(self._cors_headers("application/json", len(payload)))
        cli.sendall(payload)

    def run(self):
        try:
            self.ensure_wifi()
            self.init_pipeline()

            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind(("0.0.0.0", self.port))
            srv.listen(2)
            self.srv = srv
            print("LAN MJPEG server listening on http://%s:%d/stream" % (self.ip, self.port))

            while self.running:
                os.exitpoint()
                cli = None
                try:
                    cli, addr = srv.accept()
                    self._handle_client(cli)
                except Exception as e:
                    print("HTTP err:", repr(e))
                finally:
                    if cli is not None:
                        try:
                            cli.close()
                        except Exception:
                            pass
        finally:
            self.running = False
            if self.srv is not None:
                try:
                    self.srv.close()
                except Exception:
                    pass
                self.srv = None
            self.deinit_pipeline()


if __name__ == "__main__":
    node = LanMjpegNode()
    node.run()
