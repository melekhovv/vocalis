"""Render the Vocalis app icon (PNG + multi-size ICO) with numpy only."""

import struct
import zlib
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent


def render(size: int) -> np.ndarray:
    s = 4  # supersampling
    n = size * s
    y, x = np.mgrid[0:n, 0:n].astype(np.float32) / n
    img = np.zeros((n, n, 4), np.float32)

    # rounded square mask
    r = 0.22
    dx = np.maximum(np.abs(x - 0.5) - (0.5 - r), 0)
    dy = np.maximum(np.abs(y - 0.5) - (0.5 - r), 0)
    inside = (dx * dx + dy * dy) <= r * r

    # violet diagonal gradient
    t = (x + y) / 2
    c0 = np.array([0.55, 0.42, 1.0])
    c1 = np.array([0.33, 0.20, 0.82])
    col = c0 * (1 - t[..., None]) + c1 * t[..., None]
    img[..., :3] = col
    img[..., 3] = inside

    # waveform bars
    heights = [0.18, 0.36, 0.56, 0.36, 0.18]
    bw = 0.075
    gap = 0.045
    total = len(heights) * bw + (len(heights) - 1) * gap
    x0 = 0.5 - total / 2
    for i, h in enumerate(heights):
        cx = x0 + i * (bw + gap) + bw / 2
        half = h / 2
        # capsule
        ddx = np.abs(x - cx)
        ddy = np.maximum(np.abs(y - 0.5) - (half - bw / 2), 0)
        bar = (ddx <= bw / 2) & ((ddx * ddx + ddy * ddy) <= (bw / 2) ** 2) | ((ddx <= bw / 2) & (np.abs(y - 0.5) <= half - bw / 2))
        img[bar & inside, :3] = 1.0

    img = img.reshape(size, s, size, s, 4).mean(axis=(1, 3))
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def png_bytes(a: np.ndarray) -> bytes:
    h, w, _ = a.shape
    raw = b"".join(b"\x00" + a[i].tobytes() for i in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    (OUT / "icon.png").write_bytes(png_bytes(render(512)))
    sizes = [16, 24, 32, 48, 64, 128, 256]
    pngs = [png_bytes(render(s)) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = b""
    for s, p in zip(sizes, pngs):
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(p), offset)
        offset += len(p)
    (OUT / "icon.ico").write_bytes(header + entries + b"".join(pngs))
    print("ok")


if __name__ == "__main__":
    main()
