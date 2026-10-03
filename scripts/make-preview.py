# -*- coding: utf-8 -*-
"""
把截图合成一张「桌面预览图」。
- 散落模式下 overlay.png 就是整屏，直接垫在壁纸上
- 底部字幕条模式下 overlay.png 是一条窄窗，贴到画面底部居中
运行：python scripts/make-preview.py
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "shots")

FALLBACK = (1600, 900)


def backdrop(size):
    """用封面图做大面积模糊，做出深色壁纸的观感"""
    W, H = size
    cover = Image.open(os.path.join(ROOT, "assets", "cover.png")).convert("RGB")
    bg = cover.resize((max(2, W // 4), max(2, H // 4)), Image.LANCZOS).resize((W, H), Image.BICUBIC)
    bg = bg.filter(ImageFilter.GaussianBlur(max(8, W // 60)))

    arr = np.asarray(bg, np.float32)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    nx, ny = xx / W, yy / H
    vig = np.clip(1.15 - 0.85 * (((nx - 0.5) ** 2 + (ny - 0.5) ** 2) ** 0.8) * 2.2, 0.16, 1.0)
    arr = arr * vig[..., None] * 0.58 + np.array([6, 7, 12], np.float32)[None, None, :]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


def paste_with_shadow(canvas, img, xy, blur=26, alpha=170, offset=(0, 14)):
    mask = img.split()[3] if img.mode == "RGBA" else Image.new("L", img.size, 255)
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow.paste(Image.new("RGBA", img.size, (0, 0, 0, alpha)),
                 (xy[0] + offset[0], xy[1] + offset[1]), mask)
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(blur)))
    canvas.alpha_composite(img, xy)


def taskbar(canvas):
    W, H = canvas.size
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    y = H - 46
    draw.rectangle([0, y, W, H], fill=(16, 16, 23, 208))
    draw.line([(0, y), (W, y)], fill=(255, 255, 255, 18), width=1)
    for i in range(4):
        cx = 40 + i * 54
        draw.rounded_rectangle([cx - 16, y + 11, cx + 16, y + 35], radius=7,
                               fill=(255, 255, 255, 24 + i * 5))
    canvas.alpha_composite(layer)


def main():
    overlay = Image.open(os.path.join(SHOTS, "overlay.png")).convert("RGBA")
    player = Image.open(os.path.join(SHOTS, "player.png")).convert("RGBA")

    fullscreen = overlay.width >= 1200 and overlay.height >= 700
    canvas = backdrop(overlay.size if fullscreen else FALLBACK).convert("RGBA")
    taskbar(canvas)

    if fullscreen:
        # 散落模式：字幕本来就铺满整屏，直接叠上去
        canvas.alpha_composite(overlay, (0, 0))
        # 播放器窗口找个不压住歌词的角落放
        px = 70
        py = max(40, (canvas.height - player.height) // 2 - 40)
        paste_with_shadow(canvas, player, (px, py))
    else:
        paste_with_shadow(canvas, player, (150, 110))
        ox = (canvas.width - overlay.width) // 2
        oy = canvas.height - 46 - overlay.height - 46
        paste_with_shadow(canvas, overlay, (ox, oy), blur=30, alpha=140, offset=(0, 8))

    out = os.path.join(SHOTS, "preview.png")
    canvas.convert("RGB").save(out, quality=95)
    print("shots/preview.png", canvas.size, "(fullscreen overlay)" if fullscreen else "(bar overlay)")


if __name__ == "__main__":
    main()
