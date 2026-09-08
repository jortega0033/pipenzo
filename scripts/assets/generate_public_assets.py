#!/usr/bin/env python3
"""Build Pipenzo documentation and social images from reviewed local sources.

Screenshot normalization is generated (a deterministic canvas/crop over a real browser capture);
every Pipenzo composition below is either copied verbatim from the approved pack (#239) or a
deterministic derivative of one (a crop, a labelled contact sheet of real pasted-in files) -- never
a redrawn character, per the epic's #1 rule.
"""

from __future__ import annotations

import io
from pathlib import Path

import cairosvg
from PIL import Image, ImageDraw, ImageFont
from generate_assets import assert_safe_svg


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DESKTOP_ASSETS = PROJECT_ROOT / "apps" / "desktop" / "assets"
SCREENSHOTS = PROJECT_ROOT / "docs" / "images" / "screenshots"
SOCIAL = PROJECT_ROOT / "docs" / "images" / "social"

PIPENZO_ROOT = DESKTOP_ASSETS / "pipenzo"
PIPENZO_MARKETING = PIPENZO_ROOT / "marketing"
PIPENZO_BRAND = PIPENZO_ROOT / "brand"
PIPENZO_PNG_ICONS = PIPENZO_ROOT / "app-icons" / "png"
PIPENZO_MINI = PIPENZO_ROOT / "mascot" / "mini"
PIPENZO_ILLUSTRATIONS = PIPENZO_ROOT / "illustrations"
PIPENZO_PNG_SIZES = (16, 20, 24, 32, 48, 64, 128, 256)

NAVY = "#0B1020"
INK = "#0F172A"
SLATE = "#64748B"
PAPER = "#F8FAFC"
CANVAS = "#F6F8FC"
BORDER = "#D8E1ED"

SCREENSHOT_NAMES = (
    "desktop-ready.png",
    "desktop-dark.png",
    "session-running.png",
    "session-completed.png",
    "daemon-unavailable.png",
)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/seguisb.ttf") if bold else Path("C:/Windows/Fonts/segoeui.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
        if bold
        else Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def fit_crop(image: Image.Image, target: tuple[int, int]) -> Image.Image:
    width, height = target
    ratio = max(width / image.width, height / image.height)
    resized = image.resize(
        (round(image.width * ratio), round(image.height * ratio)),
        Image.Resampling.LANCZOS,
    )
    left = (resized.width - width) // 2
    top = (resized.height - height) // 2
    return resized.crop((left, top, left + width, top + height))


def rasterize_svg(path: Path, width: int, height: int, color: str | None = None) -> Image.Image:
    source_bytes = path.read_bytes()
    assert_safe_svg(source_bytes, path)
    source = source_bytes.decode("utf-8")
    if color:
        source = source.replace("currentColor", color)
    raw = cairosvg.svg2png(
        bytestring=source.encode("utf-8"), output_width=width, output_height=height
    )
    with Image.open(io.BytesIO(raw)) as image:
        return image.convert("RGBA")


def draw_grid(draw: ImageDraw.ImageDraw, size: tuple[int, int], color: str, step: int = 48) -> None:
    width, height = size
    for x in range(0, width, step):
        draw.line((x, 0, x, height), fill=color, width=1)
    for y in range(0, height, step):
        draw.line((0, y, width, y), fill=color, width=1)


def normalize_screenshots() -> None:
    """Normalize browser captures to the production 1440x900 documentation canvas."""

    for name in SCREENSHOT_NAMES:
        path = SCREENSHOTS / name
        with Image.open(path) as source:
            image = source.convert("RGB")

        if image.size == (1440, 900):
            image.save(path, format="PNG", optimize=True)
            continue
        if image.height > 900 or image.width > 1440:
            raise ValueError(f"Unexpected capture dimensions for {path}: {image.size}")

        dark = name == "desktop-dark.png"
        background = "#080D19" if dark else "#EEF2F8"
        grid = "#0E1627" if dark else "#E8EDF6"
        canvas = Image.new("RGB", (1440, 900), background)
        draw_grid(ImageDraw.Draw(canvas), canvas.size, grid)
        x = (canvas.width - image.width) // 2
        canvas.paste(image, (x, 0))
        canvas.save(path, format="PNG", optimize=True)


def use_reviewed_source(source: Path, destination: Path) -> None:
    """Copy an already-reviewed, checked-in Pipenzo composition verbatim -- never redrawn."""

    destination.write_bytes(source.read_bytes())


def make_portfolio() -> None:
    """Portfolio/project-card art (#246): a deterministic resize of the approved GitHub social
    composition, not a redrawn composition -- the "responsive raster derivative" #239 explicitly
    allows, not new artwork. Sourced from the social preview rather than the landing-page hero:
    the landing hero (#245) bakes in a "VIEW ON GITHUB" pixel button that makes sense on the site
    it sits next to a real clickable one, but reads as a broken/fake control on a static portfolio
    thumbnail with no real button anywhere near it. Target size (1440x720) matches the source's
    own 2:1 aspect ratio exactly -- a plain resize, not a fill-crop, so no baked text ever clips.
    """

    with Image.open(PIPENZO_MARKETING / "pipenzo-github-social-preview-1280x640.png") as source:
        resized = source.convert("RGB").resize((1440, 720), Image.Resampling.LANCZOS)
    resized.save(SOCIAL / "portfolio-project.png", format="PNG", optimize=True)


def make_asset_system_preview() -> None:
    """Contributor-facing asset preview (#246): a documentation sheet of the real, checked-in
    Pipenzo pack (#239) -- the icon, lockups, and mini portraits are pasted in verbatim from
    approved files, only the labels/layout are generated. Not a new generative concept sheet."""

    canvas = Image.new("RGB", (1600, 1040), CANVAS)
    draw = ImageDraw.Draw(canvas)
    draw.text((70, 54), "Pipenzo · Asset System", fill=INK, font=font(44, bold=True))
    draw.text((70, 112), "Approved brand + mascot pack -- see docs/brand/BRAND.md", fill=SLATE, font=font(22))

    icon = Image.open(PIPENZO_PNG_ICONS / "pipenzo-icon-256.png").convert("RGBA").resize(
        (290, 290), Image.Resampling.LANCZOS
    )
    canvas.paste(icon, (70, 188), icon)
    draw.text((70, 504), "Application icon", fill=INK, font=font(22, bold=True))
    draw.text((70, 540), "Monochrome helmet + p, never the full mascot at this size", fill=SLATE, font=font(18))

    draw.rounded_rectangle((420, 188, 1520, 350), radius=20, fill=PAPER, outline=BORDER, width=2)
    light = rasterize_svg(PIPENZO_BRAND / "pipenzo-lockup-horizontal-light.svg", 720, 144)
    canvas.paste(light, (490, 197), light)
    draw.rounded_rectangle((420, 382, 1520, 544), radius=20, fill=NAVY, outline="#273449", width=2)
    dark = rasterize_svg(PIPENZO_BRAND / "pipenzo-lockup-horizontal-dark.svg", 720, 144)
    canvas.paste(dark, (490, 391), dark)

    expressions = ("neutral", "focused", "thinking", "skeptical", "waiting", "alert", "commander")
    x0, y0 = 70, 650
    for index, name in enumerate(expressions):
        x = x0 + index * 215
        draw.rounded_rectangle((x, y0, x + 185, y0 + 260), radius=16, fill=PAPER, outline=BORDER, width=2)
        with Image.open(PIPENZO_MINI / f"pipenzo-head-{name}-128.png") as source:
            portrait = source.convert("RGBA").resize((142, 142), Image.Resampling.LANCZOS)
        canvas.paste(portrait, (x + 21, y0 + 20), portrait)
        label = f"mini/{name}"
        text_width = draw.textlength(label, font=font(16, bold=True))
        draw.text((x + (185 - text_width) / 2, y0 + 180), label, fill=INK, font=font(16, bold=True))
    canvas.save(SOCIAL / "asset-system-preview.png", format="PNG", optimize=True)


def make_icon_size_preview() -> None:
    """Same production-size preview as before, re-sourced from the approved Pipenzo icon family
    (#241) instead of AgentDock's."""

    canvas = Image.new("RGB", (1180, 430), CANVAS)
    draw = ImageDraw.Draw(canvas)
    draw.text((35, 25), "Pipenzo icon at production sizes", fill=INK, font=font(26, bold=True))
    x = 35
    for size in PIPENZO_PNG_SIZES:
        card_width = max(90, size + 34)
        draw.rounded_rectangle((x, 85, x + card_width, 365), radius=14, fill=PAPER, outline=BORDER, width=2)
        with Image.open(PIPENZO_PNG_ICONS / f"pipenzo-icon-{size}.png") as source:
            icon = source.convert("RGBA")
        display_size = min(size, 210)
        if display_size != size:
            icon = icon.resize((display_size, display_size), Image.Resampling.LANCZOS)
        px = x + (card_width - display_size) // 2
        py = 105 + (220 - display_size) // 2
        canvas.paste(icon, (px, py), icon)
        label = f"{size}px"
        label_font = font(16)
        text_width = draw.textlength(label, font=label_font)
        draw.text((x + (card_width - text_width) / 2, 338), label, fill=SLATE, font=label_font)
        x += card_width + 18
    canvas.save(SOCIAL / "icon-size-preview.png", format="PNG", optimize=True)


def main() -> None:
    SOCIAL.mkdir(parents=True, exist_ok=True)
    normalize_screenshots()
    make_portfolio()
    use_reviewed_source(
        PIPENZO_MARKETING / "pipenzo-github-social-preview-1280x640.png",
        SOCIAL / "github-social-preview.png",
    )
    use_reviewed_source(
        PIPENZO_MARKETING / "pipenzo-github-social-preview-1200x630.png",
        SOCIAL / "open-graph.png",
    )
    use_reviewed_source(
        PIPENZO_MARKETING / "pipenzo-readme-hero-1600x520.webp",
        SOCIAL / "readme-hero.webp",
    )
    # docs/daemon.md's phase-machine section (#246): the same approved role strip, reused verbatim
    # rather than a second illustration invented for docs specifically.
    use_reviewed_source(
        PIPENZO_ILLUSTRATIONS / "pipenzo-workflow-roles-1800x650.png",
        SOCIAL / "pipenzo-workflow-roles.png",
    )
    make_asset_system_preview()
    make_icon_size_preview()
    print(f"Generated public assets under {SOCIAL}")


if __name__ == "__main__":
    main()
