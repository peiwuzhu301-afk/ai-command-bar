"""Generate a proper multi-resolution ICO (V3 format) + placeholder PNGs."""
import os
import struct
import zlib


def make_bitmap_bytes(w, h):
    """Compute BGRA rows top-to-bottom, once."""
    bg = bytes((150, 80, 42, 255))
    fg = bytes((255, 255, 255, 255))
    pad = max(1, int(w * 0.22))
    bar_w = max(1, int(w * 0.09))
    bar_h = int(h * 0.56)
    mid_y = pad + int(bar_h * 0.5)
    rows = []
    for y in range(h):
        row = bytearray()
        for x in range(w):
            inside = 1 <= x < w - 1 and 1 <= y < h - 1
            if not inside:
                row += bg
                continue
            in_left = (pad <= x < pad + bar_w) and (pad <= y < pad + bar_h)
            in_right = (w - pad - bar_w <= x < w - pad) and (pad <= y < pad + bar_h)
            in_mid = (mid_y <= y < mid_y + bar_w) and (pad <= x < w - pad - bar_w)
            row += fg if (in_left or in_right or in_mid) else bg
        rows.append(bytes(row))
    return rows


def ico_image(w, h):
    rows = make_bitmap_bytes(w, h)
    xor = b"".join(reversed(rows))
    row_and = ((w + 31) // 32) * 4
    and_data = bytes(row_and * h)
    header = struct.pack(
        "<IiiHHIIiiII",
        40, w, h * 2, 1, 32, 0,
        len(xor) + len(and_data), 0, 0, 0, 0,
    )
    return header + xor + and_data


def build_ico(sizes, out_path):
    entries = [ico_image(s, s) for s in sizes]
    out = bytearray(struct.pack("<HHH", 0, 1, len(entries)))
    offset = 6 + 16 * len(entries)
    for s, b in zip(sizes, entries):
        w = 0 if s >= 256 else s
        out += struct.pack("<BBBBHHII",
                           w, w, 0, 0, 1, 32,
                           len(b), offset)
        offset += len(b)
    out += b"".join(entries)
    with open(out_path, "wb") as f:
        f.write(bytes(out))
    print(f"wrote {out_path} ({len(out)} bytes)")


def _chunk(typ, data):
    return (struct.pack(">I", len(data)) + typ + data +
            struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))


def make_png(s, out_path):
    rows = make_bitmap_bytes(s, s)
    rows = list(reversed(rows))  # PNG is top-down but make_bitmap_bytes already returns top-down
    # Actually: ICO is bottom-up, PNG is top-down. keep top-down for PNG.
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", s, s, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + r for r in rows)
    idat = zlib.compress(raw, 6)
    with open(out_path, "wb") as f:
        f.write(sig + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b""))
    print(f"wrote {out_path}")


if __name__ == "__main__":
    base = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(os.path.dirname(base), "src-tauri", "resources")
    os.makedirs(out_dir, exist_ok=True)
    build_ico([16, 32, 48, 256], os.path.join(out_dir, "icon.ico"))
    make_png(32, os.path.join(out_dir, "32x32.png"))
    make_png(128, os.path.join(out_dir, "128x128.png"))
    make_png(256, os.path.join(out_dir, "128x128@2x.png"))
    make_png(64, os.path.join(out_dir, "icon.png"))
