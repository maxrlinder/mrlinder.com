#!/usr/bin/env python3
"""Generate the Piquet menu logo as a pixel-grid SVG.

A sibling of scripts/generate-plump-logo.py and generate-rummy-logo.py: same
felt, table edge, real deck cards and display alphabet, so the tiles read as
one set in the games directory. Drawn on a 360 x 205 grid and emitted at 2x.

The fanned hand is the four aces, a quatorze, the best set in Piquet, and the
chips are what declaring it scores.

    python3 scripts/generate-piquet-logo.py [outfile]
"""

import importlib.util
import pathlib
import sys

_here = pathlib.Path(__file__).resolve().parent


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, _here / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plump = _load("plump_logo", "generate-plump-logo.py")
cards = plump.cards

W, H = plump.W, plump.H
YELLOW = cards.YELLOW
INK = cards.INK

# The display letters PLUMP does not already have.
DISPLAY = dict(plump.DISPLAY)
DISPLAY["I"] = ["XXXXXXXX", "XXXXXXXX"] + ["---XX---"] * 9 + ["XXXXXXXX", "XXXXXXXX"]
DISPLAY["Q"] = [
    "-XXXXXX-",
    "XXXXXXXX",
    "XX----XX",
    "XX----XX",
    "XX----XX",
    "XX----XX",
    "XX----XX",
    "XX----XX",
    "XX-XX-XX",
    "XX--XXXX",
    "XX---XXX",
    "XXXXXXXX",
    "-XXXXX-X",
]
DISPLAY["E"] = ["XXXXXXXX", "XXXXXXXX"] + ["XX------"] * 3 + ["XXXXXX--"] * 2 + ["XX------"] * 4 + ["XXXXXXXX", "XXXXXXXX"]
DISPLAY["T"] = ["XXXXXXXX", "XXXXXXXX"] + ["---XX---"] * 11

# 5 x 7 chip letters, in the style of the card indices.
cards.FONT.update({
    "C": ["-XXX-", "X---X", "X----", "X----", "X----", "X---X", "-XXX-"],
    "E": ["XXXXX", "X----", "X----", "XXXX-", "X----", "X----", "XXXXX"],
    "S": ["-XXXX", "X----", "X----", "-XXX-", "----X", "----X", "XXXX-"],
})

# Four aces, stepped like the Plump fan: three show their corner indices and
# the ace of clubs reads whole.
FAN = [("spades", "a", 14, 58), ("hearts", "a", 32, 48), ("diamonds", "a", 50, 38), ("clubs", "a", 68, 28)]

CHIPS = ["ACES", "+14"]

TEXT_X = 168
STEP = 29


def build():
    c = cards.Canvas(W, H)
    c.raw('<rect width="{}" height="{}" fill="url(#felt)"/>'.format(W, H))
    c.rect(0, 0, W, 2, INK)
    c.rect(0, H - 2, W, 2, INK)
    c.rect(0, 2, 2, H - 4, INK)
    c.rect(W - 2, 2, 2, H - 4, INK)
    c.rect(10, 10, W - 20, 2, YELLOW)
    c.rect(10, H - 12, W - 20, 2, YELLOW)
    c.rect(10, 12, 2, H - 24, YELLOW)
    c.rect(W - 12, 12, 2, H - 24, YELLOW)

    for suit, rank, x, y in FAN:
        plump.deck_card(c, x, y, suit, rank)

    x = TEXT_X
    for letter in "PIQUET":
        c.grid(DISPLAY[letter], x + 6, 64, 3, {"X": INK})
        c.grid(DISPLAY[letter], x, 58, 3, {"X": cards.SCREEN_LIGHT})
        x += STEP
    width = 5 * STEP + 24 + 6

    chip_x = TEXT_X
    for label in CHIPS:
        chip_x += plump.chip(c, chip_x, 124, label, True, scale=3) + 6
    width = max(width, chip_x - 6 - TEXT_X)
    c.rect(TEXT_X, 110, width, 2, YELLOW)

    return c.to_svg("Piquet", defs=plump.DEFS, scale=plump.SCALE)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else str(
        _here.parent / "site" / "RL-environment" / "piquet-logo.svg")
    pathlib.Path(out).write_text(build())
    print("wrote", out)


if __name__ == "__main__":
    main()
