"""Derive the smaller launcher icon sizes from icons/512.png."""
import pathlib
from PIL import Image

root = pathlib.Path(__file__).resolve().parent.parent
src = Image.open(root / "icons" / "512.png").convert("RGBA")

for size in (256, 128, 96, 64, 48, 32, 24, 16):
    src.resize((size, size), Image.LANCZOS).save(root / "icons" / f"{size}.png")
    print(f"icons/{size}.png")

src.save(root / "icon.png")
print("icon.png")
