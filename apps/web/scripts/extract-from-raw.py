"""One-off: extract images from already-saved raw JSON responses (avoids re-paying)."""

import base64
import json
import re
from pathlib import Path

OUT_DIR = Path(__file__).parent / "image-gen-output"
DATA_URL_RE = re.compile(r"data:image/(\w+);base64,([A-Za-z0-9+/=]+)")


def extract_images(body: dict) -> list[bytes]:
    images: list[bytes] = []
    for choice in body.get("choices", []):
        msg = choice.get("message", {})
        content = msg.get("content")
        if isinstance(content, str):
            for m in DATA_URL_RE.finditer(content):
                images.append(base64.b64decode(m.group(2)))
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict):
                    url = (part.get("image_url") or {}).get("url") or part.get("url") or ""
                    for m in DATA_URL_RE.finditer(url):
                        images.append(base64.b64decode(m.group(2)))
        for img in msg.get("images", []) or []:
            url = (img.get("image_url") or {}).get("url") or img.get("url") or ""
            for m in DATA_URL_RE.finditer(url):
                images.append(base64.b64decode(m.group(2)))
    return images


for raw_file in OUT_DIR.glob("*-raw.json"):
    label = raw_file.stem.replace("-raw", "")
    body = json.loads(raw_file.read_text())
    images = extract_images(body)
    if not images:
        print(f"[{label}] still no images found")
        continue
    for i, img_bytes in enumerate(images):
        out_path = OUT_DIR / f"{label}-{i}.png"
        out_path.write_bytes(img_bytes)
        print(f"[{label}] saved {out_path} ({len(img_bytes)} bytes)")
