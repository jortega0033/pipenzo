#!/usr/bin/env python3
"""Regenerate AgentDock desktop icons from the canonical application-icon SVG.

Optional maintainer tool. Requires Python 3.11+ and dependencies pinned in
``scripts/assets/requirements.txt``. It performs no network access.
"""

from __future__ import annotations

import io
import re
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

import cairosvg
from PIL import Image


PROJECT_ROOT = Path(__file__).resolve().parents[2]
ASSET_ROOT = PROJECT_ROOT / "apps" / "desktop" / "assets"
SOURCE = ASSET_ROOT / "brand" / "agent-dock-app-icon.svg"
ICON_ROOT = ASSET_ROOT / "app-icons"
PNG_ROOT = ICON_ROOT / "png"

PNG_SIZES = (16, 24, 32, 44, 48, 64, 128, 256, 512, 1024)
ICO_SIZES = ((16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256))

# Pipenzo's own canonical icon family (see #239). This is additive: it derives Pipenzo's
# monochrome helmet+p PNG/ICO/ICNS outputs from the approved asset pack's SVG source without
# touching the AgentDock family above, which apps/desktop still consumes until #241 rewires
# electron-builder.yml/index.html/AgentDockMark.tsx to the Pipenzo files generated here.
PIPENZO_ROOT = ASSET_ROOT / "pipenzo"
PIPENZO_SOURCE = PIPENZO_ROOT / "app-icons" / "pipenzo-app-icon-helmet-p-monochrome.svg"
PIPENZO_ICON_ROOT = PIPENZO_ROOT / "app-icons"
PIPENZO_PNG_ROOT = PIPENZO_ICON_ROOT / "png"
PIPENZO_PNG_SIZES = (16, 20, 24, 32, 48, 64, 128, 256, 512, 1024)
PIPENZO_ICO_SIZES = ((16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256))

BLOCKED_ELEMENTS = {
    "animate",
    "animatemotion",
    "animatetransform",
    "embed",
    "foreignobject",
    "iframe",
    "image",
    "object",
    "script",
    "set",
    "style",
    "use",
}
EXTERNAL_REFERENCE = re.compile(r"(?i)(?:https?|file|ftp):|data:|url\s*\(")
LOCAL_FRAGMENT_REFERENCE = re.compile(
    r"(?i)url\s*\(\s*(['\"]?)#([a-z_][\w:.-]*)\1\s*\)"
)
LOCAL_PATH = re.compile(r"(?i)(?:[a-z]:[\\/]|/(?:home|users|tmp)/)")
CSS_IMPORT = re.compile(r"(?i)@import\b")


def local_name(value: str) -> str:
    return value.rsplit("}", 1)[-1].lower()


def has_unsafe_reference(value: str) -> bool:
    without_local_fragments = LOCAL_FRAGMENT_REFERENCE.sub("", value)
    return bool(
        "\\" in value
        or EXTERNAL_REFERENCE.search(without_local_fragments)
        or LOCAL_PATH.search(without_local_fragments)
        or CSS_IMPORT.search(without_local_fragments)
    )


def local_fragment_ids(value: str) -> set[str]:
    return {match.group(2) for match in LOCAL_FRAGMENT_REFERENCE.finditer(value)}


def assert_safe_svg(svg: bytes, source: Path = SOURCE) -> None:
    """Reject source features that could resolve external or active content."""

    upper = svg.upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper or b"<?XML-STYLESHEET" in upper:
        raise ValueError(f"Unsafe XML declaration in {source}")

    root = ET.fromstring(svg)
    if local_name(root.tag) != "svg":
        raise ValueError(f"Expected SVG root in {source}")

    identifiers = [element.attrib["id"] for element in root.iter() if "id" in element.attrib]
    if any(not identifier for identifier in identifiers):
        raise ValueError(f"Empty SVG id in {source}")
    if len(identifiers) != len(set(identifiers)):
        raise ValueError(f"Duplicate SVG id in {source}")
    known_ids = set(identifiers)

    for element in root.iter():
        element_name = local_name(element.tag)
        if element_name in BLOCKED_ELEMENTS:
            raise ValueError(f"Blocked <{element_name}> element in {source}")

        for text in (element.text, element.tail):
            if text and has_unsafe_reference(text):
                raise ValueError(f"Blocked external or local text reference in {source}")
            missing_ids = local_fragment_ids(text or "") - known_ids
            if missing_ids:
                raise ValueError(f"Missing local references {sorted(missing_ids)} in {source}")

        for raw_name, value in element.attrib.items():
            attribute_name = local_name(raw_name)
            normalized = str(value).strip()
            if attribute_name.startswith("on"):
                raise ValueError(f"Blocked event attribute {attribute_name} in {source}")
            if attribute_name in {"href", "src"} and not normalized.startswith("#"):
                raise ValueError(f"Blocked reference {attribute_name}={normalized!r} in {source}")
            if has_unsafe_reference(normalized):
                raise ValueError(f"Blocked external or local reference in {source}")
            missing_ids = local_fragment_ids(normalized) - known_ids
            if (
                attribute_name in {"href", "src"}
                and normalized.startswith("#")
                and normalized[1:] not in known_ids
            ):
                missing_ids.add(normalized[1:])
            if missing_ids:
                raise ValueError(f"Missing local references {sorted(missing_ids)} in {source}")


def rasterize(svg: bytes, size: int) -> Image.Image:
    rendered = cairosvg.svg2png(bytestring=svg, output_width=size, output_height=size)
    with Image.open(io.BytesIO(rendered)) as image:
        return image.convert("RGBA")


def build_ico(png_root: Path, ico_sizes=ICO_SIZES, name_fn=lambda size: f"icon-{size}.png") -> bytes:
    """Build an ICO whose frames come from the exact-size committed PNGs."""

    payloads: list[tuple[int, bytes]] = []
    for width, height in ico_sizes:
        if width != height:
            raise ValueError(f"ICO frame must be square: {(width, height)}")
        payloads.append((width, (png_root / name_fn(width)).read_bytes()))

    header = struct.pack("<HHH", 0, 1, len(payloads))
    offset = len(header) + (16 * len(payloads))
    entries = bytearray()
    images = bytearray()

    for size, payload in payloads:
        encoded_size = 0 if size == 256 else size
        entries.extend(
            struct.pack(
                "<BBBBHHII",
                encoded_size,
                encoded_size,
                0,
                0,
                1,
                32,
                len(payload),
                offset,
            )
        )
        images.extend(payload)
        offset += len(payload)

    return header + bytes(entries) + bytes(images)


def generate_icon_family(
    source: Path,
    png_root: Path,
    icon_root: Path,
    png_sizes: tuple[int, ...],
    ico_sizes: tuple[tuple[int, int], ...],
    ico_name: str,
    icns_name: str,
    png_name_fn=lambda size: f"icon-{size}.png",
) -> None:
    svg = source.read_bytes()
    assert_safe_svg(svg, source)

    png_root.mkdir(parents=True, exist_ok=True)
    images: dict[int, Image.Image] = {}
    try:
        for size in png_sizes:
            image = rasterize(svg, size)
            images[size] = image
            image.save(png_root / png_name_fn(size), format="PNG", optimize=True)

        (icon_root / ico_name).write_bytes(build_ico(png_root, ico_sizes, png_name_fn))
        images[1024].save(icon_root / icns_name, format="ICNS")
    finally:
        for image in images.values():
            image.close()

    print(f"Generated {len(png_sizes)} PNGs, ICO, and ICNS under {icon_root}")


def main() -> None:
    generate_icon_family(
        SOURCE,
        PNG_ROOT,
        ICON_ROOT,
        PNG_SIZES,
        ICO_SIZES,
        "agent-dock.ico",
        "agent-dock.icns",
    )
    generate_icon_family(
        PIPENZO_SOURCE,
        PIPENZO_PNG_ROOT,
        PIPENZO_ICON_ROOT,
        PIPENZO_PNG_SIZES,
        PIPENZO_ICO_SIZES,
        "pipenzo.ico",
        "pipenzo.icns",
        png_name_fn=lambda size: f"pipenzo-icon-{size}.png",
    )


if __name__ == "__main__":
    main()
