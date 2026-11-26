#!/usr/bin/env python3
"""Upload k230-cam MicroPython files onto LCSC Lushan-Pi K230 /sdcard over serial REPL."""

import argparse
import base64
import pathlib
import sys
import time
import serial

ROOT = pathlib.Path(__file__).resolve().parent


def enter_raw_repl(ser: serial.Serial) -> None:
    ser.write(b"\r\x03\x03\x02\r\n")
    time.sleep(0.3)
    ser.read_all()
    ser.write(b"\x01")
    time.sleep(0.3)
    out = ser.read_all()
    if b"raw REPL" not in out:
        ser.write(b"\r\x03\x03\x01")
        time.sleep(0.4)
        out += ser.read_all()
        if b"raw REPL" not in out:
            raise RuntimeError(f"Could not enter K230 raw REPL: {out!r}")


def exec_raw(ser: serial.Serial, code: str, timeout: float = 5.0) -> str:
    ser.write(code.encode("utf-8") + b"\x04")
    buf = b""
    deadline = time.time() + timeout
    while time.time() < deadline:
        chunk = ser.read(1024)
        if chunk:
            buf += chunk
            if buf.count(b"\x04") >= 2:
                break
    return buf.decode("utf-8", "replace")


def upload_file(ser: serial.Serial, local_path: pathlib.Path, remote_path: str) -> None:
    raw = local_path.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    chunk_size = 512
    exec_raw(ser, f"import ubinascii\nf=open({remote_path!r},'wb')\n")
    for i in range(0, len(b64), chunk_size):
        part = b64[i : i + chunk_size]
        res = exec_raw(ser, f"f.write(ubinascii.a2b_base64({part!r}))\n")
        if "Traceback" in res:
            raise RuntimeError(f"Upload failed on {remote_path}: {res}")
    exec_raw(ser, "f.close()\n")
    print(f"Uploaded {local_path.name} -> {remote_path} ({len(raw)} bytes)")


def main() -> None:
    ap = argparse.ArgumentParser(description="Deploy k230-cam to K230 /sdcard")
    ap.add_argument("--port", default="COM12", help="Serial port (default COM12)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--run", action="store_true", help="Soft-reset and tail output after upload")
    args = ap.parse_args()

    cfg_path = ROOT / "config.py"
    if not cfg_path.exists():
        print("Error: k230-cam/config.py not found. Copy config.example.py to config.py first.", file=sys.stderr)
        sys.exit(1)

    ser = serial.Serial(args.port, args.baud, timeout=0.3)
    try:
        enter_raw_repl(ser)
        upload_file(ser, ROOT / "config.py", "/sdcard/config.py")
        if (ROOT / "https_client.py").exists():
            upload_file(ser, ROOT / "https_client.py", "/sdcard/https_client.py")
        upload_file(ser, ROOT / "main.py", "/sdcard/main.py")
        if args.run:
            exec_raw(
                ser,
                "try:\n from media.display import Display\n Display.deinit()\nexcept Exception:\n pass\n"
                "try:\n from media.media import MediaManager\n MediaManager.deinit()\nexcept Exception:\n pass\n",
                timeout=3.0,
            )
        ser.write(b"\x02")
        time.sleep(0.2)
        if args.run:
            print("Soft-rebooting K230 (auto-runs /sdcard/main.py)...")
            ser.read_all()
            ser.write(b"\x04")
            deadline = time.time() + 18
            while time.time() < deadline:
                data = ser.read(1024)
                if data:
                    sys.stdout.write(data.decode("utf-8", "replace"))
                    sys.stdout.flush()
    finally:
        ser.close()


if __name__ == "__main__":
    main()
