from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "build" / "axiom-icon-source.png"
PNG_OUTPUT = ROOT / "build" / "axiom-icon.png"
ICO_OUTPUT = ROOT / "build" / "axiom.ico"


def main() -> None:
    image = Image.open(SOURCE).convert("RGBA")
    image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    offset = ((1024 - image.width) // 2, (1024 - image.height) // 2)
    canvas.alpha_composite(image, offset)

    canvas.save(PNG_OUTPUT, optimize=True)
    canvas.save(
        ICO_OUTPUT,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    print(f"Created {PNG_OUTPUT}")
    print(f"Created {ICO_OUTPUT}")


if __name__ == "__main__":
    main()
