"""Generate resources/icon.png — the marketplace tile.

Deliberately generic terminal iconography: a rounded dark tile with a prompt
caret. No OpenAI marks, since this extension is unofficial.
Run: py -3.12 resources/make_icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 512  # supersampled, downscaled to 128 at the end
OUT = Path(__file__).with_name("icon.png")

BG = (17, 17, 27, 255)  # Catppuccin Mocha base
BORDER = (49, 50, 68, 255)  # surface0
ACCENT = (203, 166, 247, 255)  # mauve
ACCENT_DIM = (137, 180, 250, 255)  # blue


def rounded_rect(draw: ImageDraw.ImageDraw, box, radius, fill, outline=None, width=0) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = 24
    rounded_rect(d, (pad, pad, SIZE - pad, SIZE - pad), 96, BG, BORDER, 8)

    # Title bar hairline, so it reads as a terminal window rather than a plain tile.
    d.line((pad + 40, 150, SIZE - pad - 40, 150), fill=BORDER, width=6)

    # Prompt caret: >
    caret = [(150, 230), (260, 320), (150, 410)]
    d.line(caret, fill=ACCENT, width=34, joint="curve")

    # Underscore cursor
    d.line((300, 400, 420, 400), fill=ACCENT_DIM, width=34)

    img.resize((128, 128), Image.LANCZOS).save(OUT)
    print(f"wrote {OUT} 128x128")


if __name__ == "__main__":
    main()
