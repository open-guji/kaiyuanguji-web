#!/usr/bin/env python3
"""
optimize-images.py — 把 nextjs/public/images/*.png 优化为更小的 PNG/WebP 副本。

策略：
- 大背景图（hero / toolkit / intelligence / ocr / typesetting）:
  生成 .webp（quality=80），同时重压原 PNG（pngquant 风格的 palette+optimize）。
  组件引用 .webp，PNG 留作 fallback / 浏览器兼容。
- logo（open-guji-logo）: 用作 favicon/apple-touch-icon，保留 PNG，仅重压。

运行：
  python scripts/optimize-images.py
"""
from pathlib import Path
from PIL import Image
import sys

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / "public" / "images"

# 大图：生成 webp + 重压 PNG
LARGE = ["hero.png", "toolkit.png", "intelligence.png", "ocr.png", "typesetting.png"]
# 小图（favicon）：仅重压 PNG
LOGO = ["open-guji-logo.png"]


def fmt_kb(n: int) -> str:
    return f"{n / 1024:.0f} KB"


def optimize_png_inplace(path: Path) -> tuple[int, int]:
    before = path.stat().st_size
    img = Image.open(path).convert("RGBA")
    # palette quantize: 8-bit indexed (256 colors) → 显著缩小有限色调图。
    # libimagequant 在大多数 Pillow wheel 里没启用，回退到 MEDIANCUT。
    # RGBA 只能用 FASTOCTREE 或 libimagequant；后者多数 wheel 没启用，所以走 FASTOCTREE。
    quantized = img.quantize(colors=256, method=Image.Quantize.FASTOCTREE)
    quantized.save(path, "PNG", optimize=True)
    after = path.stat().st_size
    return before, after


def make_webp(path: Path, quality: int = 80) -> tuple[int, int]:
    webp_path = path.with_suffix(".webp")
    img = Image.open(path)
    # WebP 不需要 alpha 时关掉，省字节
    if img.mode == "RGBA" and not any(p < 255 for p in img.getchannel("A").getdata()):
        img = img.convert("RGB")
    img.save(webp_path, "WEBP", quality=quality, method=6)
    return path.stat().st_size, webp_path.stat().st_size


def main() -> int:
    if not IMAGES.exists():
        print(f"❌ {IMAGES} not found", file=sys.stderr)
        return 1

    total_before = 0
    total_after = 0
    print(f"images dir: {IMAGES}\n")

    print("【大图】PNG → 重压 + 生成 WebP 副本")
    for name in LARGE:
        p = IMAGES / name
        if not p.exists():
            print(f"  ⚠ {name} 不存在，跳过")
            continue
        before_png, after_png = optimize_png_inplace(p)
        _, webp_size = make_webp(p)
        total_before += before_png
        total_after += webp_size  # 浏览器主要拉 webp
        print(
            f"  {name}: PNG {fmt_kb(before_png)} → {fmt_kb(after_png)} ({100 * after_png // before_png}%) | "
            f"WebP {fmt_kb(webp_size)} ({100 * webp_size // before_png}%)"
        )

    print("\n【logo】仅 PNG 重压")
    for name in LOGO:
        p = IMAGES / name
        if not p.exists():
            print(f"  ⚠ {name} 不存在，跳过")
            continue
        before, after = optimize_png_inplace(p)
        total_before += before
        total_after += after
        print(f"  {name}: PNG {fmt_kb(before)} → {fmt_kb(after)} ({100 * after // before}%)")

    print(
        f"\n  total served-bytes: {fmt_kb(total_before)} → {fmt_kb(total_after)} "
        f"({100 * total_after // total_before}%)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
