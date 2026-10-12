"""Generate candidate background images for the Operations section via TokenRouter.

Reads TOKENROUTER_API_KEY from scripts/.env (gitignored). Saves raw candidates to
scripts/image-gen-output/ (also gitignored) for manual review before any of them
are cropped/optimized into src/assets for actual use.

Gemini image models only work through the multimodal chat-completions endpoint on
TokenRouter (POST /v1/chat/completions with modalities: ["text", "image"]), not
POST /v1/images/generations (that's for dedicated image models like gpt-image-*).

Usage: python generate-ops-bg.py
"""

import base64
import json
import re
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
ENV_FILE = SCRIPT_DIR / ".env"
OUT_DIR = SCRIPT_DIR / "image-gen-output"

CHAT_URL = "https://api.tokenrouter.com/v1/chat/completions"

PROMPT = (
    "Flat vector tactical topographic map, thin contour lines and route markers, "
    "minimalist military command-ops style, no text, no people, no icons, "
    "monochrome dark green line art (#3fb950) on a near-black background (#121212), "
    "clean and sparse, wide 16:9 composition, subtle and low-detail, "
    "suitable as a faint background texture behind UI content"
)

CANDIDATES = [
    {
        "label": "gemini-pro-final",
        "model": "google/gemini-3-pro-image-preview",
        "prompt": PROMPT,
    },
]

DATA_URL_RE = re.compile(r"data:image/(\w+);base64,([A-Za-z0-9+/=]+)")


def load_api_key() -> str:
    if not ENV_FILE.exists():
        raise SystemExit(f"Missing {ENV_FILE}")
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith("TOKENROUTER_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("TOKENROUTER_API_KEY not found in .env")


def extract_images(body: dict) -> list[bytes]:
    """Best-effort extraction across plausible response shapes."""
    images: list[bytes] = []
    choices = body.get("choices", [])
    for choice in choices:
        msg = choice.get("message", {})

        # Shape A: message.images = [{"image_url": {"url": "data:..."}}]
        for img in msg.get("images", []) or []:
            url = (img.get("image_url") or {}).get("url") or img.get("url")
            if url:
                m = DATA_URL_RE.match(url)
                if m:
                    images.append(base64.b64decode(m.group(2)))

        # Shape B: message.content is a list of parts, some image_url typed
        content = msg.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") in ("image_url", "image"):
                    url = (part.get("image_url") or {}).get("url") or part.get("url")
                    if url:
                        for m in DATA_URL_RE.finditer(url):
                            images.append(base64.b64decode(m.group(2)))

        # Shape C: message.content is a plain markdown string with an embedded
        # data URL, e.g. "Here's your image: ![image](data:image/png;base64,...)"
        elif isinstance(content, str):
            for m in DATA_URL_RE.finditer(content):
                images.append(base64.b64decode(m.group(2)))
    return images


def generate(api_key: str, label: str, model: str, prompt: str) -> None:
    payload = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "modalities": ["text", "image"],
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        CHAT_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    print(f"[{label}] requesting {model} ...")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(f"[{label}] HTTP {e.code}: {err_body}")
        return

    images = extract_images(body)
    if not images:
        print(f"[{label}] no images extracted, raw response saved for inspection")
        OUT_DIR.mkdir(exist_ok=True)
        (OUT_DIR / f"{label}-raw.json").write_text(json.dumps(body, indent=2))
        return

    OUT_DIR.mkdir(exist_ok=True)
    for i, img_bytes in enumerate(images):
        out_path = OUT_DIR / f"{label}-{i}.png"
        out_path.write_bytes(img_bytes)
        print(f"[{label}] saved {out_path}")


def main() -> None:
    api_key = load_api_key()
    for c in CANDIDATES:
        generate(api_key, c["label"], c["model"], c["prompt"])


if __name__ == "__main__":
    main()
