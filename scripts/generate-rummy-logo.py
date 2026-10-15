#!/usr/bin/env python3
"""Generate the Rummy menu logo as a pixel-grid SVG.

A sibling of scripts/generate-plump-logo.py: same felt, same table edge, same
real deck cards and display alphabet, so the two tiles read as one set in the
games directory. Drawn on a 360 x 205 grid and emitted at 2x (720 x 410).

The fanned hand is a run, 7-8-9 of hearts, and the chips are what laying it
earns: every card put on the table scores its points, so the run is +24.

    python3 scripts/generate-rummy-logo.py [outfile]
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
DISPLAY["R"] = [
    "XXXXXXX-",
    "XXXXXXXX",
    "XX----XX",
    "XX----XX",
    "XX----XX",
    "XXXXXXXX",
    "XXXXXXX-",
    "XX--XX--",
    "XX---XX-",
    "XX---XX-",
    "XX----XX",
    "XX----XX",
    "XX----XX",
]
DISPLAY["Y"] = [
    "XX----XX",
    "XX----XX",
    "XX----XX",
    "XX----XX",
    "XX----XX",
    "XXXXXXXX",
    "-XXXXXX-",
    "---XX---",
    "---XX---",
    "---XX---",
    "---XX---",
    "---XX---",
    "---XX---",
]

# 5 x 7 chip letters, in the style of the card indices.
cards.FONT.update({
    "R": ["XXXX-", "X---X", "X---X", "XXXX-", "X-X--", "X--X-", "X---X"],
    "U": ["X---X", "X---X", "X---X", "X---X", "X---X", "X---X", "-XXX-"],
    "N": ["X---X", "XX--X", "X-X-X", "X--XX", "X---X", "X---X", "X---X"],
})

# A run in hand, stepped like the Plump fan: the 7 and 8 show their corner
# indices and the 9 reads whole.
FAN = [("hearts", "7", 18, 54), ("hearts", "8", 40, 44), ("hearts", "9", 62, 34)]

CHIPS = ["RUN", "+24"]

TEXT_X = 166


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
    for letter in "RUMMY":
        c.grid(DISPLAY[letter], x + 6, 64, 3, {"X": INK})
        c.grid(DISPLAY[letter], x, 58, 3, {"X": cards.SCREEN_LIGHT})
        x += 34
    width = 4 * 34 + 24 + 6

    chip_x = TEXT_X
    for label in CHIPS:
        chip_x += plump.chip(c, chip_x, 124, label, True, scale=3) + 6
    width = max(width, chip_x - 6 - TEXT_X)
    c.rect(TEXT_X, 110, width, 2, YELLOW)

    return c.to_svg("Rummy", defs=plump.DEFS, scale=plump.SCALE)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else str(
        _here.parent / "RL-environment" / "rummy-logo.svg")
    pathlib.Path(out).write_text(build())
    print("wrote", out)


if __name__ == "__main__":
    main()
