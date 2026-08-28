from pathlib import Path
import sys

from PIL import Image


def clean(input_path: Path, output_path: Path) -> None:
    image = Image.open(input_path).convert("RGBA")
    pixels = image.load()

    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            if alpha == 0:
                continue

            # The avatar palette contains cyan and green but no magenta. Convert
            # only unmistakable key spill into a dim cyan edge while retaining
            # the matte and the generated wireframe detail.
            magenta = min(red, blue) - green
            if magenta > 18 and red > 80 and blue > 80:
                strength = min(1.0, (magenta - 18) / 100)
                target_red = min(red, int(green * 0.34))
                target_green = max(green, int(blue * 0.72))
                red = round(red + (target_red - red) * strength)
                green = round(green + (target_green - green) * strength)

            pixels[x, y] = red, green, blue, alpha

    image.save(output_path, optimize=True)
    print(f"Cleaned {output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: clean-avatar-chroma.py INPUT OUTPUT")
    clean(Path(sys.argv[1]), Path(sys.argv[2]))
