"""Generate gofit.today app icons (bowl + tilted leaf sprig) with Pillow.

The mark is defined in the same 48-unit space as app/Logo.tsx so the icon and the
in-app logo stay identical. Bezier curves are sampled into polygons/polylines
because Pillow has no native path support.

Run: python scripts/make_icons.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "..", "assets")

GREEN_TOP = (14, 138, 85)   # #0E8A55
GREEN_BOT = (6, 74, 46)     # #064A2E
WHITE = (255, 255, 255, 255)
VEIN = (11, 122, 75, 150)

VB = 48.0  # design viewBox (matches Logo.tsx)


def _cubic(p0, p1, p2, p3, steps=48):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = (u * u * u * p0[0] + 3 * u * u * t * p1[0]
             + 3 * u * t * t * p2[0] + t * t * t * p3[0])
        y = (u * u * u * p0[1] + 3 * u * u * t * p1[1]
             + 3 * u * t * t * p2[1] + t * t * t * p3[1])
        pts.append((x, y))
    return pts


def vgradient(size, top, bot):
    img = Image.new("RGB", (size, size), top)
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        r = int(top[0] + (bot[0] - top[0]) * t)
        g = int(top[1] + (bot[1] - top[1]) * t)
        b = int(top[2] + (bot[2] - top[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b)
    return img.convert("RGBA")


def draw_mark(size, pad=0.14):
    """Render the white bowl+leaf mark centered with `pad` margin, supersampled."""
    SS = 4
    W = size * SS

    def T(x, y):
        span = W * (1 - 2 * pad)
        return (W * pad + (x / VB) * span, W * pad + (y / VB) * span)

    def sc(v):
        return v / VB * W * (1 - 2 * pad)

    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # ---- Leaf blade: two cubic segments -> closed polygon ----
    leaf = _cubic((23.5, 24), (21.5, 16), (26, 9.5), (33.5, 7))
    leaf += _cubic((33.5, 7), (33, 14), (30, 21), (23.5, 24))
    d.polygon([T(*p) for p in leaf], fill=WHITE)

    # ---- Bowl body (lower half circle) + rim ellipse ----
    bx0, by0 = T(8.5, 10.5)
    bx1, by1 = T(39.5, 41.5)
    d.pieslice([bx0, by0, bx1, by1], 0, 180, fill=WHITE)
    rx0, ry0 = T(8.5, 22.6)
    rx1, ry1 = T(39.5, 29.4)
    d.ellipse([rx0, ry0, rx1, ry1], fill=WHITE)

    # ---- Leaf midrib vein ----
    midrib = _cubic((23.5, 24), (26.5, 19), (30.5, 12.5), (32.5, 8.5))
    d.line([T(*p) for p in midrib], fill=VEIN,
           width=max(2, int(sc(1.5))), joint="curve")

    # ---- Bowl inner shadow arc ----
    inner = _cubic((11, 27.6), (16, 32.6), (32, 32.6), (37, 27.6))
    d.line([T(*p) for p in inner], fill=VEIN,
           width=max(2, int(sc(1.4))), joint="curve")

    return layer.resize((size, size), Image.LANCZOS)


def compose_icon(size):
    bg = vgradient(size, GREEN_TOP, GREEN_BOT)
    bg.alpha_composite(draw_mark(size, pad=0.16))
    return bg


def main():
    os.makedirs(ASSETS, exist_ok=True)

    compose_icon(1024).save(os.path.join(ASSETS, "icon.png"))
    print("icon.png 1024")

    # Android adaptive foreground: transparent, extra padding for the safe zone.
    draw_mark(1024, pad=0.26).save(os.path.join(ASSETS, "adaptive-icon.png"))
    print("adaptive-icon.png 1024")

    # Splash: white mark on transparent (Expo tints with backgroundColor).
    draw_mark(512, pad=0.18).save(os.path.join(ASSETS, "splash-icon.png"))
    print("splash-icon.png 512")

    compose_icon(196).save(os.path.join(ASSETS, "favicon.png"))
    print("favicon.png 196")

    print("done ->", os.path.abspath(ASSETS))


if __name__ == "__main__":
    main()
