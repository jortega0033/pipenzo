"""Derive the landing page's web-sized art from the master Pipenzo assets.

The masters under src/assets/pipenzo/ are 1536px (mascots) or 1600x900 (illustrations) and
280-350 KB each. The page never shows a mascot wider than ~440 CSS px, so shipping the masters
costs weight for pixels nobody sees. This script trims transparent padding, resizes to roughly
2x the largest rendered size, and writes metadata-free WebP files into src/assets/pipenzo/web/.

It also cuts the one text-free figure out of the oversized-ticket illustration (the operator
holding the long scroll) and keys out the illustration's dark backdrop so the figure sits on the
page background without a visible rectangle. The illustration's baked-in threshold text is deliberately left out of the
crop: the page renders those numbers as real HTML instead.

Run from apps/web:  python scripts/derive-web-assets.py   (needs Pillow)
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1] / "src" / "assets" / "pipenzo"
OUT = ROOT / "web"


def save(image: Image.Image, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / name
    # exif/icc omitted on purpose: no metadata chunks in shipped files.
    image.save(target, "WEBP", quality=84, method=6)
    print(f"{target.relative_to(ROOT.parents[2])}  {image.size}  {target.stat().st_size // 1024} KB")


def trimmed_mascot(source: str, width: int) -> Image.Image:
    image = Image.open(ROOT / "mascot" / "detailed" / source).convert("RGBA")
    bbox = image.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    image = image.crop(bbox)
    height = round(image.height * width / image.width)
    return image.resize((width, height), Image.LANCZOS)


def cutout_crop(source: str, box: tuple[int, int, int, int], width: int) -> Image.Image:
    """Crop, then key out the flat dark backdrop (and its faint grid) by flood-filling from the
    crop's border. The character's near-black outline stops the fill, so the figure itself is
    never touched even where its own dark gear is close to the backdrop's colour."""
    image = Image.open(ROOT / "illustrations" / source).convert("RGB").crop(box)
    marker = (255, 0, 255)
    keyed = image.copy()
    w, h = keyed.size
    seeds = [(x, 0) for x in range(0, w, 16)] + [(x, h - 1) for x in range(0, w, 16)]
    seeds += [(0, y) for y in range(0, h, 16)] + [(w - 1, y) for y in range(0, h, 16)]
    for seed in seeds:
        if keyed.getpixel(seed) != marker and max(keyed.getpixel(seed)) < 30:
            ImageDraw.floodfill(keyed, seed, marker, thresh=18)
    mask = Image.new("L", keyed.size, 255)
    mask_px, keyed_px = mask.load(), keyed.load()
    for y in range(h):
        for x in range(w):
            if keyed_px[x, y] == marker:
                mask_px[x, y] = 0
    mask = mask.filter(ImageFilter.GaussianBlur(0.8))
    image = image.convert("RGBA")
    image.putalpha(mask)
    image = image.crop(mask.point(lambda a: 255 if a > 8 else 0).getbbox())
    height = round(image.height * width / image.width)
    return image.resize((width, height), Image.LANCZOS)


if __name__ == "__main__":
    save(trimmed_mascot("pipenzo-field-engineer-canonical-fullbody.webp", 760), "field-engineer-hero.webp")
    save(trimmed_mascot("pipenzo-inspector-review.webp", 560), "inspector-review.webp")
    save(trimmed_mascot("pipenzo-commander-routing.webp", 640), "commander-routing.webp")
    # x 10..815, y 95..895: the scroll, the operator and the case, none of the baked text
    # (the "SCOPE GATE" label ends above y 80, the headline starts right of x 840).
    save(cutout_crop("pipenzo-oversized-ticket-1600x900.webp", (10, 95, 815, 895), 560), "scroll-refuse.webp")
