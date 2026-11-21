#!/usr/bin/env python3
"""Build the extension icons (16, 32, 48, 128 px) from one square source image.

    python3 tools/make-icons.py icons/peermind.png

The white background outside the rounded-square artwork is made transparent (flood-filled from
the edges, so white inside the artwork is kept), the image is cropped to the artwork, and each
size is downscaled with Lanczos resampling. Requires Pillow (pip install pillow).
"""
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

SIZES = (16, 32, 48, 128)
WHITE_THRESHOLD = 40  # how far from pure white a background pixel may be


def transparent_background(img: Image.Image) -> Image.Image:
    rgb = img.convert("RGB")
    w, h = rgb.size
    # Flood-fill a marker colour from every edge pixel that is near-white.
    marker = (255, 0, 255)
    filled = rgb.copy()
    for x, y in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]:
        if all(c >= 255 - WHITE_THRESHOLD for c in filled.getpixel((x, y))):
            ImageDraw.floodfill(filled, (x, y), marker, thresh=WHITE_THRESHOLD)
    # Alpha = 0 where the marker landed; soften the edge slightly to avoid a jagged halo.
    diff = ImageChops.difference(filled, Image.new("RGB", (w, h), marker)).convert("L")
    alpha = diff.point(lambda v: 0 if v == 0 else 255).filter(ImageFilter.GaussianBlur(1.2))
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def crop_square(img: Image.Image) -> Image.Image:
    bbox = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox() or (0, 0, *img.size)
    left, top, right, bottom = bbox
    side = max(right - left, bottom - top)
    cx, cy = (left + right) // 2, (top + bottom) // 2
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(img.crop(bbox), (side // 2 - (cx - left), side // 2 - (cy - top)))
    return square


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1])
    out_dir = Path(__file__).resolve().parent.parent / "icons"
    art = crop_square(transparent_background(Image.open(src)))
    for size in SIZES:
        target = out_dir / f"icon{size}.png"
        art.resize((size, size), Image.LANCZOS).save(target, optimize=True)
        print(f"wrote {target.relative_to(out_dir.parent)}")


if __name__ == "__main__":
    main()
