# -*- coding: utf-8 -*-
import os, math
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "icons")          # 專案內的 icons/（相對於本腳本）
os.makedirs(OUT, exist_ok=True)
WINDIR = os.environ.get("WINDIR", r"C:\Windows")
FONT = os.path.join(WINDIR, "Fonts", "segoeuib.ttf")
FONT2 = os.path.join(WINDIR, "Fonts", "arialbd.ttf")

def font(size):
    for f in (FONT, FONT2):
        try:
            return ImageFont.truetype(f, size)
        except Exception:
            pass
    return ImageFont.load_default()

def draw_icon(px):
    S = 512
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 圆角底色
    r = int(S * 0.22)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=(88, 101, 242, 255))
    # 内部稍暗的圆角层，增加层次
    m = int(S * 0.075)
    d.rounded_rectangle([m, m, S - 1 - m, S - 1 - m], radius=int(S * 0.16), fill=(72, 82, 196, 255))
    # 放大镜圆环
    cx, cy, R = int(S * 0.46), int(S * 0.44), int(S * 0.235)
    w = int(S * 0.055)
    d.ellipse([cx - R, cy - R, cx + R, cy + R], outline=(255, 255, 255, 255), width=w)
    # 放大镜把手
    hx0 = cx + int(R * 0.72); hy0 = cy + int(R * 0.72)
    hx1 = int(S * 0.815); hy1 = int(S * 0.815)
    d.line([hx0, hy0, hx1, hy1], fill=(255, 255, 255, 255), width=int(S * 0.075))
    d.ellipse([hx1 - int(S * 0.045), hy1 - int(S * 0.045), hx1 + int(S * 0.045), hy1 + int(S * 0.045)], fill=(255, 255, 255, 255))
    # 圆环里的 AI 字样
    f = font(int(S * 0.20))
    tw = d.textlength("AI", font=f)
    d.text((cx - tw / 2, cy - S * 0.115), "AI", font=f, fill=(255, 255, 255, 255))
    # 左下角小徽章（代表“已找到提示词”）
    bx, by, br = int(S * 0.255), int(S * 0.775), int(S * 0.115)
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=(67, 181, 129, 255), outline=(255, 255, 255, 255), width=int(S * 0.018))
    if px <= 32:
        # 小尺寸简化：去掉圆环内文字更清晰
        pass
    return img.resize((px, px), Image.LANCZOS)

for size in (16, 32, 48, 128):
    im = draw_icon(size)
    im.save(os.path.join(OUT, "icon%d.png" % size))
    print("icon%d.png" % size, im.size)
