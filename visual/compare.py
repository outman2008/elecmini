#!/usr/bin/env python3
"""
P4-D 截图对比：Pillow 像素差异 + 感知差异（感知哈希），阈值判定，产出报告。

用法：
  python3 visual/compare.py --a visual/baselines/critical-chromium.png \
                            --b visual/candidates/critical-chrome.png \
                            --out visual/results/diff.json --threshold 2.0

判定：
  - pixel_diff_percent：逐像素 RGB 差异占比（任一通道差 > tolerance 记为差异）
  - phash_distance：感知哈希汉明距离（0~64），衡量结构相似度
  - pass：pixel_diff_percent <= threshold
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from PIL import Image, ImageChops
except ImportError:
    print(json.dumps({"error": "Pillow 未安装"}))
    sys.exit(3)


def phash(img, hash_size=8, highfreq=4):
    """感知哈希：灰度 + DCT 简化（缩放后取低频），返回 64bit 整数。"""
    im = img.convert("L").resize((hash_size * highfreq, hash_size * highfreq), Image.LANCZOS)
    px = list(im.getdata())
    w = hash_size * highfreq
    # 用分区均值近似 DCT 低频（避免依赖 numpy/scipy）
    block = highfreq
    bits = []
    vals = []
    for by in range(hash_size):
        for bx in range(hash_size):
            s = 0
            for y in range(block):
                for x in range(block):
                    s += px[(by * block + y) * w + (bx * block + x)]
            vals.append(s / (block * block))
    avg = sum(vals) / len(vals)
    for v in vals:
        bits.append(1 if v > avg else 0)
    n = 0
    for b in bits:
        n = (n << 1) | b
    return n


def hamming(a, b):
    return bin(a ^ b).count("1")


def compare(a_path, b_path, tolerance=24):
    a = Image.open(a_path).convert("RGB")
    b = Image.open(b_path).convert("RGB")
    if a.size != b.size:
        # 尺寸不一致：以基线尺寸为准缩放候选（记录该事实）
        b = b.resize(a.size, Image.LANCZOS)
        size_mismatch = True
    else:
        size_mismatch = False

    diff = ImageChops.difference(a, b)
    px_a = list(diff.getdata())
    total = len(px_a)
    changed = 0
    for r, g, bl in px_a:
        if r > tolerance or g > tolerance or bl > tolerance:
            changed += 1
    pct = round(changed / total * 100, 4) if total else 0.0

    ha, hb = phash(a), phash(b)
    return {
        "size": list(a.size),
        "sizeMismatch": size_mismatch,
        "tolerance": tolerance,
        "pixelDiffPercent": pct,
        "changedPixels": changed,
        "totalPixels": total,
        "phashDistance": hamming(ha, hb),
        "phashMax": 64,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", required=True, help="基线截图")
    ap.add_argument("--b", required=True, help="候选截图")
    ap.add_argument("--out", default=None)
    ap.add_argument("--threshold", type=float, default=2.0)
    ap.add_argument("--tolerance", type=int, default=24)
    args = ap.parse_args()

    if not Path(args.a).exists() or not Path(args.b).exists():
        print(json.dumps({"error": "截图文件不存在", "a": args.a, "b": args.b}))
        sys.exit(3)

    m = compare(args.a, args.b, args.tolerance)
    m["pass"] = m["pixelDiffPercent"] <= args.threshold
    m["thresholdPercent"] = args.threshold
    m["a"] = args.a
    m["b"] = args.b
    m["generatedAt"] = datetime.now(timezone.utc).isoformat()
    m["note"] = "仅对比同一 headless 浏览器渲染的页面；跨引擎真实对比需各平台宿主采集（见 P4 报告限制）"

    out = json.dumps(m, indent=2, ensure_ascii=False)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(out, encoding="utf-8")
    print(out)
    sys.exit(0 if m["pass"] else 2)


if __name__ == "__main__":
    main()
