#!/usr/bin/env python3
"""Generate the Plump menu logo as a pixel-grid SVG.

The fanned cards are the real deck cards, drawn by scripts/generate-cards.py and
dropped into the composition at 1:1 — the logo and resources/cards/ are the same
artwork, not lookalikes. Drawn on a 360 x 205 grid and emitted at 2x, i.e.
720 x 410 — the same box as the existing menu tile.

The score chips are specific to Plump's scoring (see RL-environment/plump/
game.js): make your bid exactly and you score 10 + bid, a made nil scores 5, and
missing scores nothing at all — you get plumped.

    python3 scripts/generate-plump-logo.py [outfile]
"""

import importlib.util
import pathlib
import sys

_spec = importlib.util.spec_from_file_location(
    "cards", pathlib.Path(__file__).with_name("generate-cards.py"))
cards = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cards)

INK = cards.INK
CHROME = cards.CHROME
CHROME_DARK = cards.CHROME_DARK
SCREEN_LIGHT = cards.SCREEN_LIGHT
WHITE = cards.WHITE
YELLOW = cards.YELLOW
RED = cards.RED

FELT = "#3e8a50"          # table green, matching the existing tile
FELT_DARK = "#2e7240"
CHIP_PRESSED = "#c9c9c2"

W, H = 360, 205
SCALE = 2

# The felt, plus the deck's own patterns — the embedded cards reference them.
DEFS = (
    '<pattern id="felt" width="4" height="4" patternUnits="userSpaceOnUse">'
    '<rect width="4" height="4" fill="{}"/>'
    '<rect width="1" height="1" fill="{}"/>'
    '<rect x="2" y="2" width="1" height="1" fill="{}"/>'
    "</pattern>"
).format(FELT, FELT_DARK, FELT_DARK) + cards.CARD_DEFS

# 8 x 13 display alphabet, 2px strokes. Only the letters PLUMP needs.
DISPLAY = {
    "P": [
        "XXXXXXX-",
        "XXXXXXXX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XXXXXXXX",
        "XXXXXXX-",
        "XX------",
        "XX------",
        "XX------",
        "XX------",
        "XX------",
        "XX------",
    ],
    "L": [
        "XX------",
        "XX------",
        "XX------",
        "XX------",
        "XX------",
        "XX------",
        "XX------",
        "XX------",
        "XX------",
        "XX------",
        "XX------",
        "XXXXXXXX",
        "XXXXXXX-",
    ],
    "U": [
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XXXXXXXX",
        "-XXXXXX-",
    ],
    "M": [
        "XX----XX",
        "XXX--XXX",
        "XXXXXXXX",
        "XX-XX-XX",
        "XX-XX-XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
        "XX----XX",
    ],
}

# The hand is the logo's joke: two certain tricks and a certain loser, i.e. a
# hand you bid 2 on — which is the +12 chip. Stacked so the ace reads whole and
# the two behind it show only their corner indices, which is what a fanned hand
# actually looks like (and what the indices are for).
FAN = [("clubs", "5", 20, 54), ("hearts", "k", 42, 44), ("spades", "a", 64, 34)]

# (label, made?) — Plump's whole scoring table in three chips.
CHIPS = [("+05", True), ("0", False), ("+12", True)]


def deck_card(c, x, y, suit, rank):
    """Drop a real card from the deck onto the felt, with a hard drop shadow."""
    c.rect(x + 4, y + 4, cards.W, cards.H, INK)
    card, _ = cards.card_canvas(suit, rank)
    c.raw('<g transform="translate({} {})">{}</g>'.format(x, y, card.body()))


def chip(c, x, y, label, made, scale=2):
    """Score chip: raised when you made your bid, pressed when you plumped."""
    glyph_w, gap, pad = 5 * scale, 1 * scale, scale + 1
    content = len(label) * glyph_w + (len(label) - 1) * gap
    w, h = content + pad * 2, 7 * scale + pad * 2
    face = CHROME if made else CHIP_PRESSED
    c.rect(x, y, w, h, INK)
    c.rect(x + 1, y + 1, w - 2, h - 2, face)
    if made:                                   # raised: light top-left
        c.rect(x + 1, y + 1, w - 3, 1, WHITE)
        c.rect(x + 1, y + 2, 1, h - 4, WHITE)
        c.rect(x + 2, y + h - 2, w - 3, 1, CHROME_DARK)
        c.rect(x + w - 2, y + 2, 1, h - 4, CHROME_DARK)
    else:                                      # pressed: shadow top-left
        c.rect(x + 1, y + 1, w - 3, 1, CHROME_DARK)
        c.rect(x + 1, y + 2, 1, h - 4, CHROME_DARK)
        c.rect(x + 2, y + h - 2, w - 3, 1, WHITE)
        c.rect(x + w - 2, y + 2, 1, h - 4, WHITE)
    color = INK if made else RED
    gx = x + pad
    for ch in label:
        c.grid(cards.FONT[ch], gx, y + pad, scale, {"X": color})
        gx += glyph_w + gap
    return w


TEXT_X = 172        # left edge of the wordmark / chip column


def build():
    c = cards.Canvas(W, H)
    c.raw('<rect width="{}" height="{}" fill="url(#felt)"/>'.format(W, H))
    # table edge: ink rim, gold hairline inside it
    c.rect(0, 0, W, 2, INK)
    c.rect(0, H - 2, W, 2, INK)
    c.rect(0, 2, 2, H - 4, INK)
    c.rect(W - 2, 2, 2, H - 4, INK)
    c.rect(10, 10, W - 20, 2, YELLOW)
    c.rect(10, H - 12, W - 20, 2, YELLOW)
    c.rect(10, 12, 2, H - 24, YELLOW)
    c.rect(W - 12, 12, 2, H - 24, YELLOW)

    # the hand, stepped up towards the wordmark
    for suit, rank, x, y in FAN:
        deck_card(c, x, y, suit, rank)

    # wordmark: cream on felt with a hard ink shadow
    x = TEXT_X
    for letter in "PLUMP":
        c.grid(DISPLAY[letter], x + 6, 64, 3, {"X": INK})
        c.grid(DISPLAY[letter], x, 58, 3, {"X": SCREEN_LIGHT})
        x += 30
    c.rect(TEXT_X, 110, 153, 2, YELLOW)

    # score chips
    x = TEXT_X
    for label, made in CHIPS:
        x += chip(c, x, 124, label, made, scale=3) + 6

    return c.to_svg("Plump", defs=DEFS, scale=SCALE)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else str(
        pathlib.Path(__file__).resolve().parent.parent
        / "RL-environment" / "plump-logo.svg")
    pathlib.Path(out).write_text(build())
    print("wrote", out)


if __name__ == "__main__":
    main()
