#!/usr/bin/env python3
"""Generate the site's favicon and link-preview image.

Both use the boot screen's little computer (`.boot-computer` in styles.css)
and the site's look: the dithered lavender desktop, a window with a striped
title bar, the Chicago font. The favicon is the computer redrawn on a 32 x 32
pixel grid, so a browser tab shows it pixel for pixel on a 2x screen.

Writes, under site/:
  favicon.svg               the tab icon
  favicon.ico               16, 32 and 48 px PNGs, for browsers and crawlers without SVG icons
  apple-touch-icon.png      180 px, the computer on the desktop
  resources/og-mrlinder.png 1200 x 630, the link preview

The PNGs are screenshots from headless Chrome (pass its path with --chrome).

    python3 scripts/generate-site-images.py [--chrome PATH]
"""

import argparse
import pathlib
import struct
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# The boot computer on a 32 x 32 grid: case, screen with its smile, floppy slot
# and button, and the base. Strokes sit on half pixels, so each is one pixel wide.
FAVICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" shape-rendering="crispEdges">
  <path d="M5.5 .5h21v26h-21z" fill="#ddd" stroke="#000"/>
  <path d="M8.5 3.5h15v12h-15z" fill="#fff" stroke="#000"/>
  <path d="M13 6v2M19 6v2M16 7v3h-1M12 11h1v1h6v-1h1" fill="none" stroke="#000"/>
  <path d="M17 21.5h7M7 23.5h3" stroke="#000"/>
  <path d="M6.5 26.5h19v5h-19z" fill="#ddd" stroke="#000"/>
</svg>
"""

# The desktop pattern and the window chrome, as in styles.css.
DESKTOP = (
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4' shape-rendering='crispEdges'%3E"
    "%3Crect width='4' height='4' fill='%23b2b2cc'/%3E%3Crect width='1' height='1' fill='%23a7a7c4'/%3E"
    "%3Crect x='2' y='2' width='1' height='1' fill='%23a7a7c4'/%3E%3C/svg%3E\") 0 0 / 4px 4px repeat #b2b2cc"
)

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><style>
@font-face {{ font-family: Chicago; src: url("{font}") format("woff2"); }}
* {{ box-sizing: border-box; margin: 0; }}
html, body {{ width: {width}px; height: {height}px; overflow: hidden; }}
body {{ display: grid; place-items: center; background: {desktop}; color: #1a1a1a; }}
img {{ display: block; image-rendering: pixelated; }}
{css}
</style></head><body>{body}</body></html>
"""

OG_CSS = """
.menubar { position: fixed; top: 0; left: 0; right: 0; display: flex; height: 20px; padding: 0 10px; border-bottom: 1px solid #1a1a1a;
  background: #fff; align-items: center; gap: 16px; font: 12px/1 Chicago; }
.menubar img { width: 13px; height: 13px; }
.menubar span:last-child { margin-left: auto; }
.window { width: 392px; margin-top: 20px; border: 1px solid #1a1a1a; background: #fff; box-shadow: 2px 2px 0 #1a1a1a; }
.titlebar { display: grid; height: 20px; padding: 0 8px; border-bottom: 1px solid #1a1a1a; background-color: #fff;
  background-image: repeating-linear-gradient(to bottom, #a8a8a8 0 1px, transparent 1px 2px);
  background-position: 2px 4px; background-repeat: no-repeat; background-size: calc(100% - 4px) 11px;
  align-items: center; grid-template-columns: 11px 1fr 11px; }
.titlebar strong { padding: 0 7px; background: #fff; justify-self: center; font: 13px/19px Chicago; font-weight: normal; }
.control { position: relative; width: 11px; height: 11px; border: 1px solid #1a1a1a; background: #fff; box-shadow: 0 0 0 2px #fff; }
.control.double::after { position: absolute; top: 0; left: 0; width: 6px; height: 6px; border-right: 1px solid #1a1a1a; border-bottom: 1px solid #1a1a1a; content: ""; }
.body { display: grid; padding: 22px 26px 24px; grid-template-columns: 64px 1fr; align-items: center; gap: 4px 22px; }
.body img { width: 64px; height: 80px; grid-row: span 2; }
h1 { font: 25px/1.1 Chicago; font-weight: normal; letter-spacing: -.01em; }
p { font: 12px/1.45 Geneva, Tahoma, Verdana, sans-serif; color: #555; }
.progress { height: 12px; margin-top: 4px; border: 1px solid #1a1a1a; grid-column: 1 / -1; }
.progress span { display: block; width: 75%; height: 100%; background: #555; }
"""

OG_BODY = """
<div class="menubar"><img src="{icon}" alt=""><span>File</span><span>Edit</span><span>View</span><span>Special</span><span>mrlinder.com</span></div>
<div class="window">
  <div class="titlebar"><span class="control"></span><strong>Welcome to mrlinder.com</strong><span class="control double"></span></div>
  <div class="body">
    <img src="{computer}" alt="">
    <h1>Max Rehman Linder</h1>
    <p>AI research, applied mathematics,<br>experiments, and other things.</p>
    <div class="progress"><span></span></div>
  </div>
</div>
"""

# The boot screen's own drawing (32 x 40), for the preview's big computer.
BOOT_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40" shape-rendering="crispEdges">
  <path d="M4.5 1.5h23v31h-23z" fill="#ddd" stroke="#000"/>
  <path d="M7.5 4.5h17v14h-17z" fill="#fff" stroke="#000"/>
  <path d="M12 8v2M20 8v2M16 9v3h-1M12 14h1v1h6v-1h1" fill="none" stroke="#000"/>
  <path d="M17 26.5h7M6 29.5h3" stroke="#000"/>
  <path d="M6.5 32.5h19v5h-19z" fill="#ddd" stroke="#000"/>
</svg>
"""

TOUCH_CSS = "img { width: 128px; height: 128px; }"


def shoot(chrome, html, out, width, height, scale, tmp):
    page = tmp / f"{out.stem}.html"
    page.write_text(html)
    subprocess.run(
        [chrome, "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--default-background-color=00000000", f"--user-data-dir={tmp / 'profile'}",
         f"--force-device-scale-factor={scale}", f"--window-size={width},{height}", "--virtual-time-budget=2000",
         f"--screenshot={out}", page.as_uri()],
        check=True, capture_output=True,
    )
    size = struct.unpack(">II", out.read_bytes()[16:24])
    if size != (width * scale, height * scale):
        raise SystemExit(f"{out.name} came out {size[0]} x {size[1]}, not {width * scale} x {height * scale}.")


def ico(pngs):
    """An .ico holding PNG images, as every browser since IE 9 reads them."""
    header = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries, data = b"", b""
    for size, png in pngs:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(png), offset + len(data))
        data += png
    return header + entries + data


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--chrome", default=CHROME)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as name:
        tmp = pathlib.Path(name)
        (SITE / "favicon.svg").write_text(FAVICON_SVG)
        icon = (SITE / "favicon.svg").as_uri()
        (tmp / "boot.svg").write_text(BOOT_SVG)
        font = (SITE / "resources/fonts/ChicagoFLF.woff2").as_uri()
        page = lambda width, height, css, body: PAGE.format(font=font, width=width, height=height, desktop=DESKTOP, css=css, body=body)

        og = SITE / "resources/og-mrlinder.png"
        shoot(args.chrome, page(600, 315, OG_CSS, OG_BODY.format(icon=icon, computer=(tmp / "boot.svg").as_uri())), og, 600, 315, 2, tmp)

        shoot(args.chrome, page(180, 180, TOUCH_CSS, f'<img src="{icon}" alt="">'), SITE / "apple-touch-icon.png", 180, 180, 1, tmp)

        pngs = []
        for size in (16, 32, 48):
            out = tmp / f"favicon-{size}.png"
            css = f"body {{ background: transparent; }} img {{ width: {size}px; height: {size}px; }}"
            shoot(args.chrome, page(size, size, css, f'<img src="{icon}" alt="">').replace("<html>", '<html style="background:transparent">'), out, size, size, 1, tmp)
            pngs.append((size, out.read_bytes()))
        (SITE / "favicon.ico").write_bytes(ico(pngs))
    print("Wrote site/favicon.svg, site/favicon.ico, site/apple-touch-icon.png and site/resources/og-mrlinder.png.")


if __name__ == "__main__":
    main()
