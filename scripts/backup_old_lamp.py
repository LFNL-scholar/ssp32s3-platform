#!/usr/bin/env python3
"""
Read-only backup & extractor for the old `light-control` SPIFFS partition
(offset 0x190000, size 0x270000 on 4MB layout).

Usage:
  # 1. Read directly from connected ESP32-S3 (read-only, never writes to flash):
  python3 scripts/backup_old_lamp.py [--port /dev/cu.usbmodemXXXX]

  # 2. Or extract from an already dumped SPIFFS binary:
  python3 scripts/backup_old_lamp.py --image backup_old_lamp/old_spiffs.bin
"""

from __future__ import annotations

import argparse
import os
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path

SPIFFS_OFFSET = 0x190000
SPIFFS_SIZE = 0x270000

# Standard ESP-IDF SPIFFS geometry defaults
PAGE_SIZE = 256
BLOCK_SIZE = 4096
OBJ_NAME_LEN = 32
META_LEN = 4

# SPIFFS flags (active low bits)
SPIFFS_PH_FLAG_USED = 1 << 0
SPIFFS_PH_FLAG_FINAL = 1 << 1
SPIFFS_PH_FLAG_INDEX = 1 << 2
SPIFFS_PH_FLAG_DELET = 1 << 7
SPIFFS_OBJ_ID_IX_FLAG = 1 << 15

RF_MAGIC = 0x49444631  # "IDF1"
HIST_MAGIC = 0x48535432  # "HST2"


def find_esptool_cmd() -> list[str]:
    eim_py = Path.home() / ".espressif/tools/python/v5.5.4/venv/bin/python"
    if eim_py.exists():
        return [str(eim_py), "-m", "esptool"]
    eim_py61 = Path.home() / ".espressif/tools/python/v6.1/venv/bin/python"
    if eim_py61.exists():
        return [str(eim_py61), "-m", "esptool"]
    if shutil.which("esptool.py"):
        return ["esptool.py"]
    if shutil.which("esptool"):
        return ["esptool"]
    return [sys.executable, "-m", "esptool"]


def dump_spiffs_from_board(port: str | None, out_bin: Path) -> None:
    out_bin.parent.mkdir(parents=True, exist_ok=True)
    cmd = find_esptool_cmd() + ["--chip", "esp32s3"]
    if port:
        cmd += ["--port", port]
    cmd += [
        "--baud", "460800",
        "read_flash",
        hex(SPIFFS_OFFSET),
        hex(SPIFFS_SIZE),
        str(out_bin),
    ]
    print(f"==> Running read-only flash dump:\n    {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    print(f"==> Saved SPIFFS backup to {out_bin} ({out_bin.stat().st_size} bytes)")


def extract_spiffs(image_bytes: bytes) -> dict[str, bytes]:
    """
    Minimal ESP-IDF SPIFFS reader (page=256, block=4096, obj_id=uint16, span_ix=uint16).
    Reconstructs active (non-deleted) files from object index headers and data pages.
    """
    pages_per_block = BLOCK_SIZE // PAGE_SIZE
    num_blocks = len(image_bytes) // BLOCK_SIZE
    # Lookup pages per block: each block stores 2-byte obj_id per page in leading lookup pages
    # With block=4096, page=256 => 16 pages/block => 32 bytes lookup + 4 bytes magic/erase => 1 lookup page
    lu_pages = max(1, (pages_per_block * 2 + 4 + PAGE_SIZE - 1) // PAGE_SIZE)

    # Collect active object headers (span_ix == 0, index flag == 0) and data pages (index flag == 1)
    # Page header layout (5 bytes): uint16 obj_id, uint16 span_ix, uint8 flags
    # Object index header page layout (ESP-IDF default):
    #   offset 0..4:  p_hdr (5 bytes)
    #   offset 5..7:  alignment padding (3 bytes) -> aligned to 4
    #   offset 8..11: uint32 size
    #   offset 12:    uint8 type (1 = file)
    #   offset 13..44: char name[32]
    #   offset 45..48: meta[4] (padded to 4-byte boundary -> 49..51)
    obj_headers: dict[int, tuple[str, int]] = {}
    data_pages: dict[tuple[int, int], bytes] = {}

    for blk in range(num_blocks):
        blk_off = blk * BLOCK_SIZE
        for pg in range(lu_pages, pages_per_block):
            pg_off = blk_off + pg * PAGE_SIZE
            page = image_bytes[pg_off : pg_off + PAGE_SIZE]
            if len(page) < PAGE_SIZE:
                continue

            obj_id_raw, span_ix, flags = struct.unpack_from("<HHB", page, 0)
            # Active low flags:
            # USED=0 means used; DELET=1 means NOT deleted; FINAL=0 means finalized
            if (flags & SPIFFS_PH_FLAG_USED) != 0:
                continue
            if (flags & SPIFFS_PH_FLAG_DELET) == 0:
                continue
            if obj_id_raw in (0x0000, 0xFFFF):
                continue

            is_index = (flags & SPIFFS_PH_FLAG_INDEX) == 0
            obj_id = obj_id_raw & ~SPIFFS_OBJ_ID_IX_FLAG

            if is_index and span_ix == 0:
                # Object index header
                size, ftype = struct.unpack_from("<IB", page, 8)
                raw_name = page[13 : 13 + OBJ_NAME_LEN]
                name = raw_name.split(b"\x00", 1)[0].decode("utf-8", errors="replace").lstrip("/")
                if name and size != 0xFFFFFFFF:
                    obj_headers[obj_id] = (name, size)
            elif not is_index:
                # Data page payload starts right after 5-byte page header
                data_pages[(obj_id, span_ix)] = page[5:]

    files: dict[str, bytes] = {}
    data_per_page = PAGE_SIZE - 5
    for obj_id, (name, size) in obj_headers.items():
        chunks: list[bytes] = []
        n_pages = (size + data_per_page - 1) // data_per_page if size > 0 else 0
        missing = False
        for s_ix in range(n_pages):
            chunk = data_pages.get((obj_id, s_ix))
            if chunk is None:
                missing = True
                break
            chunks.append(chunk)
        if missing:
            print(f"[WARN] Skipping incomplete file '{name}' (obj_id={obj_id}, size={size})")
            continue
        content = b"".join(chunks)[:size]
        files[name] = content

    return files


def verify_rf_file(name: str, data: bytes) -> bool:
    # struct { uint32 magic, version, count; float mhz, bw, rate; uint32 crc; } = 28 bytes
    if len(data) < 28:
        print(f"  [FAIL] {name}: too short ({len(data)} bytes)")
        return False
    magic, version, count, mhz, bw, rate, crc = struct.unpack_from("<IIIfffI", data, 0)
    expected_size = 28 + count * 4
    if magic != RF_MAGIC or version != 1 or len(data) != expected_size:
        print(f"  [FAIL] {name}: invalid header (magic=0x{magic:08x}, ver={version}, len={len(data)}, expected={expected_size})")
        return False
    calc_crc = zlib.crc32(data[:24], 0)
    calc_crc = zlib.crc32(data[28:], calc_crc) & 0xFFFFFFFF
    if calc_crc != crc:
        print(f"  [FAIL] {name}: CRC mismatch (stored=0x{crc:08x}, calc=0x{calc_crc:08x})")
        return False
    pulses = struct.unpack_from(f"<{count}i", data, 28)
    dur_ms = sum(abs(p) for p in pulses) / 1000.0
    print(f"  [OK]   {name}: {count} pulses, {mhz:.2f} MHz / {bw:.0f} kHz / {rate:.1f} kBaud, {dur_ms:.1f} ms (CRC32 valid)")
    return True


def verify_history_file(name: str, data: bytes) -> bool:
    if len(data) == 0 or len(data) % 32 != 0:
        return False
    n = len(data) // 32
    valid = 0
    for i in range(n):
        rec = data[i * 32 : (i + 1) * 32]
        magic, cause, on, _res, start, end, crc, _res2 = struct.unpack("<IBBHqqII", rec)
        calc = zlib.crc32(rec[:24], 0) & 0xFFFFFFFF
        if magic == HIST_MAGIC and calc == crc and end >= start:
            valid += 1
    if valid > 0:
        print(f"  [OK]   {name}: {valid}/{n} valid 32-byte lamp history records")
        return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Backup and extract old light-control SPIFFS data")
    parser.add_argument("--port", "-p", help="Serial port (e.g. /dev/cu.usbmodemXXXX); auto-detected if omitted")
    parser.add_argument("--image", "-i", type=Path, help="Use an existing SPIFFS binary dump instead of reading from board")
    parser.add_argument("--out", "-o", type=Path, default=Path("backup_old_lamp"), help="Backup output directory")
    parser.add_argument("--seed", type=Path, default=Path("data_seed"), help="Directory to place verified files for new platform import")
    args = parser.parse_args()

    out_dir: Path = args.out
    extracted_dir = out_dir / "extracted"
    extracted_dir.mkdir(parents=True, exist_ok=True)

    if args.image:
        img_path = args.image
    else:
        img_path = out_dir / "old_spiffs.bin"
        dump_spiffs_from_board(args.port, img_path)

    raw = img_path.read_bytes()
    files = extract_spiffs(raw)
    if not files:
        print("No active files found in SPIFFS image.")
        return 1

    print(f"==> Extracted {len(files)} file(s) from SPIFFS:")
    args.seed.mkdir(parents=True, exist_ok=True)
    rf_ok = False
    for name, content in sorted(files.items()):
        dest = extracted_dir / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)

        if name.endswith(".rf"):
            if verify_rf_file(name, content):
                (args.seed / Path(name).name).write_bytes(content)
                if Path(name).name == "power_sample_1.rf":
                    rf_ok = True
        elif verify_history_file(name, content):
            (args.seed / Path(name).name).write_bytes(content)
        else:
            print(f"  [INFO] {name}: {len(content)} bytes (saved to {dest})")

    if rf_ok:
        print(f"\n==> Success! Verified power_sample_1.rf copied to {args.seed}/power_sample_1.rf")
    else:
        print("\n[WARN] power_sample_1.rf was not found or failed verification. You can still learn it from the new web UI.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
