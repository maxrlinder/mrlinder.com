#!/usr/bin/env python3
"""Generate the Hjärter menu logo as a pixel-grid SVG.

A sibling of scripts/generate-plump-logo.py, generate-rummy-logo.py and
generate-piquet-logo.py: same felt, table edge, real deck cards and display
alphabet, so the tiles read as one set in the games directory. Drawn on a
360 x 205 grid and emitted at 2x.

The fanned hand is the moon: the queen of spades and the top hearts. Take
every penalty card and you score 0 while everyone else takes 26, which is
what the chips say.

    python3 scripts/generate-hjarter-logo.py [outfile]
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
rummy = _load("rummy_logo", "generate-rummy-logo.py")
piquet = _load("piquet_logo", "generate-piquet-logo.py")
cards = plump.cards

W, H = plump.W, plump.H
YELLOW = cards.YELLOW
INK = cards.INK

# The display letters PLUMP does not already have, borrowed where a sibling drew them.
DISPLAY = dict(plump.DISPLAY)
DISPLAY["R"] = rummy.DISPLAY["R"]
DISPLAY["E"] = piquet.DISPLAY["E"]
DISPLAY["T"] = piquet.DISPLAY["T"]
DISPLAY["H"] = ["XX----XX"] * 5 + ["XXXXXXXX"] * 2 + ["XX----XX"] * 6
DISPLAY["J"] = ["--XXXXXX", "--XXXXXX"] + ["-----XX-"] * 8 + ["XX---XX-", "XXXXXXX-", "-XXXXX--"]
DISPLAY["A"] = [
    "-XXXXXX-",
    "XXXXXXXX",
    "XX----XX",
    "XX----XX",
    "XX----XX",
    "XX----XX",
    "XXXXXXXX",
    "XXXXXXXX",
    "XX----XX",
    "XX----XX",
    "XX----XX",
    "XX----XX",
    "XX----XX",
]
# The umlaut, drawn above the A.
DOTS = ["XX----XX", "XX----XX"]

# The moon in hand, stepped like the Plump fan: the king and ace of hearts
# show their corner indices and the queen of spades reads whole.
FAN = [("hearts", "k", 16, 54), ("hearts", "a", 36, 44), ("spades", "q", 56, 34)]

# (label, made?): you score 0, everyone else 26.
CHIPS = [("0", True), ("+26", False)]

TEXT_X = 158
STEP = 26


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
    for letter in "HJARTER":
        c.grid(DISPLAY[letter], x + 6, 64, 3, {"X": INK})
        c.grid(DISPLAY[letter], x, 58, 3, {"X": cards.SCREEN_LIGHT})
        if letter == "A":
            c.grid(DOTS, x + 6, 64 - 12, 3, {"X": INK})
            c.grid(DOTS, x, 58 - 12, 3, {"X": cards.SCREEN_LIGHT})
        x += STEP
    width = 6 * STEP + 24 + 6

    chip_x = TEXT_X
    for label, made in CHIPS:
        chip_x += plump.chip(c, chip_x, 124, label, made, scale=3) + 6
    width = max(width, chip_x - 6 - TEXT_X)
    c.rect(TEXT_X, 110, width, 2, YELLOW)

    return c.to_svg("Hjärter", defs=plump.DEFS, scale=plump.SCALE)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else str(
        _here.parent / "site" / "RL-environment" / "hjarter-logo.svg")
    pathlib.Path(out).write_text(build())
    print("wrote", out)


if __name__ == "__main__":
    main()
