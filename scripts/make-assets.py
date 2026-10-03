# -*- coding: utf-8 -*-
"""
用代码生成播放器素材，避免引入外部图片：
  assets/cover.png  640x640  演示专辑封面（深空 + 极光 + 星点）
  assets/icon.png   512x512  应用图标（圆角方块 + 音符）
  assets/tray.png   64x64    托盘图标
运行：python scripts/make-assets.py
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
os.makedirs(ASSETS, exist_ok=True)

ACCENT = (139, 124, 255)     # 紫
ACCENT2 = (79, 216, 255)     # 青
ACCENT3 = (255, 122, 198)    # 粉

rng = np.random.default_rng(20240613)


def radial(nx, ny, cx, cy, r):
    d = np.sqrt((nx - cx) ** 2 + (ny - cy) ** 2)
    return np.clip(1.0 - d / r, 0.0, 1.0) ** 2.2


def gradient_field(size):
    """深空底色 + 三处光晕 + 流动极光带"""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    nx, ny = xx / size, yy / size

    top = np.array([30, 27, 62], np.float32)
    mid = np.array([16, 14, 32], np.float32)
    bot = np.array([7, 7, 12], np.float32)

    t = ny[..., None]
    img = np.where(t < 0.55,
                   top * (1 - t / 0.55) + mid * (t / 0.55),
                   mid * (1 - (t - 0.55) / 0.45) + bot * ((t - 0.55) / 0.45))

    glows = [
        (0.20, 0.16, 0.78, ACCENT, 0.80),
        (0.88, 0.30, 0.62, ACCENT2, 0.50),
        (0.52, 0.95, 0.72, ACCENT3, 0.40),
        (0.10, 0.75, 0.55, ACCENT2, 0.22),
    ]
    for cx, cy, r, color, strength in glows:
        g = radial(nx, ny, cx, cy, r)[..., None] * strength
        img = img + np.array(color, np.float32)[None, None, :] * g

    # 极光带
    palette = [ACCENT, ACCENT2, ACCENT3, (120, 180, 255), (176, 140, 255)]
    for k in range(5):
        y0 = 0.16 + 0.17 * k
        wave = y0 + 0.055 * np.sin(nx * 2 * np.pi * (1.0 + k * 0.32) + k * 1.7)
        band = np.exp(-((ny - wave) ** 2) / (2 * 0.030 ** 2))
        fade = np.clip(1.15 - nx, 0.0, 1.0) ** 1.3
        img = img + np.array(palette[k], np.float32)[None, None, :] * (band * fade * 0.16)[..., None]

    return img


def add_stars(img, size, count=520):
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    nx, ny = xx / size, yy / size

    layer = np.zeros((size, size), np.float32)
    for _ in range(count):
        cx, cy = rng.random(), rng.random()
        r = 0.0009 + rng.random() ** 3 * 0.0055
        brightness = 0.35 + rng.random() * 0.65
        d = (nx - cx) ** 2 + (ny - cy) ** 2
        layer = np.maximum(layer, np.exp(-d / (2 * r ** 2)) * brightness)

    # 少量亮星带十字光晕
    glow = np.array(Image.fromarray((layer * 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(2.2)), np.float32) / 255.0
    layer = np.clip(layer + glow * 0.55, 0, 1)

    tint = np.array([226, 232, 255], np.float32)
    return img + tint[None, None, :] * (layer * 0.95)[..., None]


def vignette(img, size, strength=0.55):
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    nx, ny = xx / size - 0.5, yy / size - 0.5
    d = np.sqrt(nx ** 2 + ny ** 2) / 0.72
    v = np.clip(1.0 - strength * np.clip(d, 0, 1.4) ** 2.0, 0.0, 1.0)
    return img * v[..., None]


def finish(img):
    img = np.clip(img, 0, 255)
    # 轻微噪点，避免大面积渐变出现色带
    noise = rng.normal(0, 1.6, img.shape[:2])[..., None]
    img = np.clip(img + noise, 0, 255)
    return Image.fromarray(img.astype(np.uint8), "RGB")


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def draw_note(draw, size, color, scale=1.0, cx=0.5, cy=0.5):
    """画一个八分音符对"""
    s = size * scale
    ox, oy = (size - s) / 2 + (cx - 0.5) * size, (size - s) / 2 + (cy - 0.5) * size

    def X(v): return ox + v * s
    def Y(v): return oy + v * s

    r = 0.115
    h1 = (X(0.38), Y(0.72), r * s)   # 左音符头
    h2 = (X(0.70), Y(0.63), r * s)   # 右音符头
    stem_w = 0.042 * s

    draw.ellipse([h1[0] - h1[2], h1[1] - h1[2] * 0.82, h1[0] + h1[2], h1[1] + h1[2] * 0.82], fill=color)
    draw.ellipse([h2[0] - h2[2], h2[1] - h2[2] * 0.82, h2[0] + h2[2], h2[1] + h2[2] * 0.82], fill=color)

    draw.rectangle([h1[0] + h1[2] - stem_w, Y(0.245), h1[0] + h1[2], h1[1]], fill=color)
    draw.rectangle([h2[0] + h2[2] - stem_w, Y(0.155), h2[0] + h2[2], h2[1]], fill=color)
    draw.polygon([
        (h1[0] + h1[2] - stem_w, Y(0.245)),
        (h2[0] + h2[2], Y(0.155)),
        (h2[0] + h2[2], Y(0.275)),
        (h1[0] + h1[2] - stem_w, Y(0.365)),
    ], fill=color)


def build_cover(size=640):
    img = gradient_field(size)
    img = add_stars(img, size)
    img = vignette(img, size, 0.5)
    cover = finish(img)

    # 中间叠一层柔和的音符水印
    mark = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_note(ImageDraw.Draw(mark), size, (255, 255, 255, 30), scale=0.66)
    mark = mark.filter(ImageFilter.GaussianBlur(7))
    cover = Image.alpha_composite(cover.convert("RGBA"), mark).convert("RGB")

    cover.save(os.path.join(ASSETS, "cover.png"))
    print("assets/cover.png", cover.size)


def build_icon(size=512):
    img = gradient_field(size)
    img = vignette(img, size, 0.35)
    base = finish(img).convert("RGBA")

    # 左上角高光
    sheen = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).ellipse(
        [-size * 0.35, -size * 0.55, size * 0.95, size * 0.45], fill=(255, 255, 255, 26))
    base = Image.alpha_composite(base, sheen)

    draw_note(ImageDraw.Draw(base), size, (255, 255, 255, 250), scale=0.56)

    base.putalpha(rounded_mask(size, int(size * 0.225)))
    base.save(os.path.join(ASSETS, "icon.png"))
    print("assets/icon.png", base.size)

    # 托盘：圆形 + 音符
    tray = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    circle = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    ImageDraw.Draw(circle).ellipse([2, 2, 125, 125], fill=(26, 24, 48, 255))
    tray = Image.alpha_composite(tray, circle)
    draw_note(ImageDraw.Draw(tray), 128, (150, 190, 255, 255), scale=0.62)
    tray.resize((64, 64), Image.LANCZOS).save(os.path.join(ASSETS, "tray.png"))
    print("assets/tray.png (64, 64)")


if __name__ == "__main__":
    build_cover()
    build_icon()
