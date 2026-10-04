"""Draw the Ellashop app icon using Pillow only."""
# Draws the Windows icon from simple shapes using Pillow.
# The build script embeds the resulting icon in the desktop application.

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent.parent
SIZE = 1024


def main():
    gradient = Image.new("RGBA", (SIZE, SIZE))
    pixels = gradient.load()
    for y in range(SIZE):
        for x in range(SIZE):
            t = min(1, max(0, (x * 0.42 + y * 0.58) / (SIZE - 1)))
            pixels[x, y] = (round(30 + 93 * t), round(187 - 102 * t),
                            round(177 + 63 * t), 255)

    mask = Image.new("L", (SIZE, SIZE))
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((24, 24, 1000, 1000), radius=230, fill=255)
    icon = Image.new("RGBA", (SIZE, SIZE))
    icon.paste(gradient, (0, 0), mask)
    draw = ImageDraw.Draw(icon)
    draw.ellipse((236, 236, 788, 788), outline="white", width=56)
    draw.ellipse((335, 335, 689, 689), outline=(255, 255, 255, 190), width=12)
    font_path = Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf")
    try:
        font = ImageFont.truetype(str(font_path), 275)
    except OSError:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 275)
    box = draw.textbbox((0, 0), "E", font=font, stroke_width=0)
    draw.text(((SIZE - (box[2] - box[0])) / 2 - box[0],
               (SIZE - (box[3] - box[1])) / 2 - box[1] - 9),
              "E", font=font, fill="white")

    png = ROOT / "app" / "static" / "icon.png"
    ico = ROOT / "windows" / "ellashop.ico"
    icon.resize((512, 512), Image.Resampling.LANCZOS).save(png)
    icon.save(ico, format="ICO", sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
    print(png)
    print(ico)


if __name__ == "__main__":
    main()
