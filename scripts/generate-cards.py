#!/usr/bin/env python3
"""Generate a 52-card deck (plus backs) as pixel-grid SVGs in the site's
System 7 / 90s-OS visual language.

Everything is drawn on a 90 x 126 integer unit grid, so every edge lands on a
whole pixel at any integer zoom. Palette is lifted straight from styles.css.

    python3 scripts/generate-cards.py [outdir]
"""

import os
import sys

# ---------------------------------------------------------------- palette ----
INK = "#11110f"
SCREEN_LIGHT = "#fbfbf7"
CHROME = "#deded7"
CHROME_DARK = "#77776f"
WHITE = "#ffffff"
STRIPE = "#a9a9a3"
DITHER = "#e8e8e3"

RED = "#c73b32"
ORANGE = "#db7a25"
YELLOW = "#d9b829"
GREEN = "#3e8a50"
BLUE = "#3276a7"
VIOLET = "#725393"
BROWN = "#6d4a3d"

SKIN = "#e8c9a8"
SKIN_DARK = "#c99b74"
GOLD_DARK = "#a8891c"

# ------------------------------------------------------------- geometry ------
W, H = 90, 126
CX, CY = W // 2, H // 2

PIP_BOX = 10           # large pip cell
COL_X = {"L": 20, "C": 40, "R": 60}
# Pip-row tops, symmetric about the card's centre line.
ROW_Y = [26, 37, 48, 58, 68, 79, 90]
HALF_Y = {"upper": 42, "lower": 74}   # extra centre pips on 7s and 8s

IDX_X = 4              # corner index block
IDX_Y = 4
IDX_SCALE = 2
IDX_GAP = 1
IDX_PIP_Y = IDX_Y + 7 * IDX_SCALE + 1   # mini pip sits under the rank

# ------------------------------------------------------------ pixel font -----
# 5 x 7 chunky glyphs.
FONT = {
    "A": ["-XXX-", "X---X", "X---X", "XXXXX", "X---X", "X---X", "X---X"],
    "J": ["--XXX", "---X-", "---X-", "---X-", "---X-", "X--X-", "-XX--"],
    "Q": ["-XXX-", "X---X", "X---X", "X---X", "X-X-X", "X--XX", "-XXXX"],
    "K": ["X---X", "X--X-", "X-X--", "XX---", "X-X--", "X--X-", "X---X"],
    "0": ["-XXX-", "X---X", "X--XX", "X-X-X", "XX--X", "X---X", "-XXX-"],
    "1": ["--X--", "-XX--", "--X--", "--X--", "--X--", "--X--", "XXXXX"],
    "2": ["-XXX-", "X---X", "----X", "---X-", "--X--", "-X---", "XXXXX"],
    "3": ["XXXXX", "----X", "---X-", "--XX-", "----X", "X---X", "-XXX-"],
    "4": ["---X-", "--XX-", "-X-X-", "X--X-", "XXXXX", "---X-", "---X-"],
    "5": ["XXXXX", "X----", "XXXX-", "----X", "----X", "X---X", "-XXX-"],
    "6": ["--XX-", "-X---", "X----", "XXXX-", "X---X", "X---X", "-XXX-"],
    "7": ["XXXXX", "----X", "---X-", "--X--", "-X---", "-X---", "-X---"],
    "8": ["-XXX-", "X---X", "X---X", "-XXX-", "X---X", "X---X", "-XXX-"],
    "9": ["-XXX-", "X---X", "X---X", "-XXXX", "----X", "---X-", "-XX--"],
    "+": ["-----", "--X--", "--X--", "XXXXX", "--X--", "--X--", "-----"],
}

# ------------------------------------------------------------- pip art -------
PIP_BIG = {
    "spades": [
        "----XX----",
        "---XXXX---",
        "--XXXXXX--",
        "-XXXXXXXX-",
        "XXXXXXXXXX",
        "XXXXXXXXXX",
        "XXX-XX-XXX",
        "-X--XX--X-",
        "---XXXX---",
        "--XXXXXX--",
    ],
    "hearts": [
        "-XXX--XXX-",
        "XXXXXXXXXX",
        "XXXXXXXXXX",
        "XXXXXXXXXX",
        "XXXXXXXXXX",
        "-XXXXXXXX-",
        "--XXXXXX--",
        "--XXXXXX--",
        "---XXXX---",
        "----XX----",
    ],
    "diamonds": [
        "----XX----",
        "---XXXX---",
        "--XXXXXX--",
        "-XXXXXXXX-",
        "-XXXXXXXX-",
        "-XXXXXXXX-",
        "-XXXXXXXX-",
        "--XXXXXX--",
        "---XXXX---",
        "----XX----",
    ],
    "clubs": [
        "---XXXX---",
        "--XXXXXX--",
        "---XXXX---",
        "XX--XX--XX",
        "XXX-XX-XXX",
        "XXXXXXXXXX",
        "-XX-XX-XX-",
        "----XX----",
        "---XXXX---",
        "--XXXXXX--",
    ],
}

PIP_SMALL = {
    "spades": [
        "---XX---",
        "--XXXX--",
        "-XXXXXX-",
        "XXXXXXXX",
        "XXXXXXXX",
        "XX-XX-XX",
        "---XX---",
        "--XXXX--",
    ],
    "hearts": [
        "-XX--XX-",
        "XXXXXXXX",
        "XXXXXXXX",
        "XXXXXXXX",
        "-XXXXXX-",
        "--XXXX--",
        "---XX---",
        "--------",
    ],
    "diamonds": [
        "---XX---",
        "--XXXX--",
        "-XXXXXX-",
        "XXXXXXXX",
        "XXXXXXXX",
        "-XXXXXX-",
        "--XXXX--",
        "---XX---",
    ],
    "clubs": [
        "--XXXX--",
        "--XXXX--",
        "XX-XX-XX",
        "XXXXXXXX",
        "-X-XX-X-",
        "---XX---",
        "--XXXX--",
        "--XXXX--",
    ],
}

# 7 x 7 index pips: smaller than the body pips so a corner never reads as part
# of the count, but still large enough to keep spade and club apart.
PIP_MINI = {
    "spades": [
        "---X---",
        "--XXX--",
        "-XXXXX-",
        "XXXXXXX",
        "XXXXXXX",
        "---X---",
        "--XXX--",
    ],
    "hearts": [
        "-XX-XX-",
        "XXXXXXX",
        "XXXXXXX",
        "XXXXXXX",
        "-XXXXX-",
        "--XXX--",
        "---X---",
    ],
    "diamonds": [
        "---X---",
        "--XXX--",
        "-XXXXX-",
        "-XXXXX-",
        "-XXXXX-",
        "--XXX--",
        "---X---",
    ],
    "clubs": [
        "--XXX--",
        "--XXX--",
        "XX-X-XX",
        "XXXXXXX",
        "-X-X-X-",
        "---X---",
        "--XXX--",
    ],
}

# ------------------------------------------------------------ court art ------
# 22 x 27 pixel portraits. Letters map through ICON_COLORS; 'a'/'b' resolve to
# the suit's accent, so each court card is tinted by its own suit.
KING = [
    ".....kk...kk...kk.....",
    "....kyyk.kyyk.kyyk....",
    "....kyyyyyyyyyyyyk....",
    "....kyyyyyyyyyyyyk....",
    "....kooooooooooook....",
    "....kkkkkkkkkkkkkk....",
    "......kssssssssk......",
    "......kssssssssk......",
    "......kskssssksk......",
    "......kssssssssk......",
    "......ksssttsssk......",
    "......ksskkkkssk......",
    ".....kwwwwwwwwwwk.....",
    ".....kwwwwwwwwwwk.....",
    "......kwwwwwwwwk......",
    ".......kwwwwwwk.......",
    "........kwwwwk........",
    "......kaaaaaaaak......",
    "....kkaaaaaaaaaakk....",
    "..kkaaaaaaaaaaaaaakk..",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kbbbbbbbbbbbbbbbbbbk.",
    ".kkkkkkkkkkkkkkkkkkkk.",
]

QUEEN = [
    "......y...yy...y......",
    ".....kyk.kyyk.kyk.....",
    "....kyyyyyyyyyyyyk....",
    "....kooooooooooook....",
    "....kkkkkkkkkkkkkk....",
    "...nnnkssssssssknnn...",
    "..nnnnkssssssssknnnn..",
    "..nnnnkskssssksknnnn..",
    "..nnnnkssssssssknnnn..",
    "..nnnnksssttsssknnnn..",
    "..nnnnksskrrkssknnnn..",
    "..nnnnkssssssssknnnn..",
    "..nnnnnkssssssknnnnn..",
    "..nnnnnnkssssknnnnnn..",
    "..nnnnnnnksskknnnnnn..",
    "..nnnnnnnssssnnnnnnn..",
    "..nnnnkaaaaaaaaknnnn..",
    "..nnkkaaaaaaaaaakknn..",
    "..kkaaaaaaaaaaaaaakk..",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kbbbbbbbbbbbbbbbbbbk.",
    ".kkkkkkkkkkkkkkkkkkkk.",
]

JACK = [
    ".......kkkkkkkk...yy..",
    "......kaaaaaaaak.yy...",
    ".....kaaaaaaaaaakyy...",
    "....kaaaaaaaaaaaakk...",
    "....kkkkkkkkkkkkkk....",
    "......kssssssssk......",
    "......kssssssssk......",
    "......kskssssksk......",
    "......kssssssssk......",
    "......ksssttsssk......",
    "......ksskkkkssk......",
    "......kssssssssk......",
    ".......kssssssk.......",
    "........kssssk........",
    "........kssssk........",
    "......kkwwwwwwkk......",
    ".....kwwwwwwwwwwk.....",
    "....kkaaaaaaaaaakk....",
    "..kkaaaaaaaaaaaaaakk..",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaaaaaaaak.",
    ".kbbbbbbbbbbbbbbbbbbk.",
    ".kkkkkkkkkkkkkkkkkkkk.",
]

COURTS = {"j": JACK, "q": QUEEN, "k": KING}

ICON_COLORS = {
    "k": INK,
    "w": WHITE,
    "g": CHROME,
    "d": CHROME_DARK,
    "s": SKIN,
    "t": SKIN_DARK,
    "y": YELLOW,
    "o": GOLD_DARK,
    "n": BROWN,
    "r": RED,
}

# suit -> (pip colour, court accent, court accent shade)
SUITS = {
    "spades": (INK, BLUE, "#255a80"),
    "hearts": (RED, RED, "#9b2b24"),
    "diamonds": (RED, ORANGE, "#a95a17"),
    "clubs": (INK, GREEN, "#2c6a3b"),
}

RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "j", "q", "k", "a"]
RANK_LABEL = {"j": "J", "q": "Q", "k": "K", "a": "A"}

# Classic pip arrangements: (column, row). Rows index ROW_Y; "u"/"l" are the
# half-step centre pips used by the 7 and the 8.
LAYOUTS = {
    "2": [("C", 0), ("C", 6)],
    "3": [("C", 0), ("C", 3), ("C", 6)],
    "4": [("L", 0), ("R", 0), ("L", 6), ("R", 6)],
    "5": [("L", 0), ("R", 0), ("C", 3), ("L", 6), ("R", 6)],
    "6": [("L", 0), ("R", 0), ("L", 3), ("R", 3), ("L", 6), ("R", 6)],
    "7": [("L", 0), ("R", 0), ("C", "u"), ("L", 3), ("R", 3), ("L", 6), ("R", 6)],
    "8": [("L", 0), ("R", 0), ("C", "u"), ("L", 3), ("R", 3), ("C", "l"),
          ("L", 6), ("R", 6)],
    "9": [("L", 0), ("R", 0), ("L", 2), ("R", 2), ("C", 3), ("L", 4), ("R", 4),
          ("L", 6), ("R", 6)],
    "10": [("L", 0), ("R", 0), ("C", 1), ("L", 2), ("R", 2), ("L", 4), ("R", 4),
           ("C", 5), ("L", 6), ("R", 6)],
}


# --------------------------------------------------------------- drawing -----
CARD_DEFS = (
    '<pattern id="dither" width="2" height="2" patternUnits="userSpaceOnUse">'
    '<rect width="2" height="2" fill="{}"/>'
    '<rect width="1" height="1" fill="{}"/>'
    '<rect x="1" y="1" width="1" height="1" fill="{}"/>'
    "</pattern>"
    '<pattern id="stripe" width="1" height="2" patternUnits="userSpaceOnUse">'
    '<rect width="1" height="2" fill="{}"/>'
    '<rect width="1" height="1" fill="{}"/>'
    "</pattern>"
).format(SCREEN_LIGHT, DITHER, DITHER, CHROME, STRIPE)


class Canvas:
    """Collects axis-aligned rects per colour, emits one path per colour."""

    def __init__(self, w=W, h=H):
        self.w = w
        self.h = h
        self.layers = []          # list of (color, [ (x,y,w,h), ... ], transform)

    def rect(self, x, y, w, h, color, transform=None):
        if w <= 0 or h <= 0:
            return
        if self.layers and self.layers[-1][0] == color \
                and self.layers[-1][2] == transform:
            self.layers[-1][1].append((x, y, w, h))
        else:
            self.layers.append((color, [(x, y, w, h)], transform))

    def raw(self, fragment):
        self.layers.append((None, fragment, None))

    def grid(self, art, x0, y0, scale, colors, transform=None):
        """Draw a pixel grid. `colors` maps a glyph char -> colour (or None)."""
        for row, line in enumerate(art):
            col = 0
            while col < len(line):
                ch = line[col]
                color = colors.get(ch)
                if color is None:
                    col += 1
                    continue
                run = 1
                while col + run < len(line) and line[col + run] == ch:
                    run += 1
                self.rect(x0 + col * scale, y0 + row * scale,
                          run * scale, scale, color, transform)
                col += run

    def body(self):
        """The drawing itself, without the <svg> wrapper."""
        out = []
        for color, payload, transform in self.layers:
            if color is None:
                out.append(payload)
                continue
            d = " ".join("M{} {}h{}v{}h-{}z".format(x, y, w, h, w)
                         for x, y, w, h in payload)
            attr = ' transform="{}"'.format(transform) if transform else ""
            out.append('<path fill="{}"{} d="{}"/>'.format(color, attr, d))
        return "\n".join(out)

    def to_svg(self, title, defs=CARD_DEFS, scale=1):
        out = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="{pw}" '
            'height="{ph}" viewBox="0 0 {w} {h}" shape-rendering="crispEdges" '
            'role="img" aria-label="{t}">'.format(
                pw=self.w * scale, ph=self.h * scale,
                w=self.w, h=self.h, t=title),
            "<title>{}</title>".format(title),
            "<defs>{}</defs>".format(defs),
            self.body(),
            "</svg>",
        ]
        return "\n".join(out) + "\n"


def card_frame(c):
    """Rounded-corner card body with a System 7 raised bevel."""
    # ink outline with 2px stepped corners
    c.rect(2, 0, W - 4, 1, INK)
    c.rect(2, H - 1, W - 4, 1, INK)
    c.rect(0, 2, 1, H - 4, INK)
    c.rect(W - 1, 2, 1, H - 4, INK)
    for x, y in ((1, 1), (W - 2, 1), (1, H - 2), (W - 2, H - 2)):
        c.rect(x, y, 1, 1, INK)
    # face
    c.rect(2, 1, W - 4, H - 2, SCREEN_LIGHT)
    c.rect(1, 2, W - 2, H - 4, SCREEN_LIGHT)
    # bevel: white top/left, grey bottom/right
    c.rect(2, 1, W - 5, 1, WHITE)
    c.rect(1, 2, 1, H - 5, WHITE)
    c.rect(3, H - 2, W - 5, 1, CHROME_DARK)
    c.rect(W - 2, 3, 1, H - 5, CHROME_DARK)


def draw_index(c, rank, suit_color, suit, transform=None):
    """Corner rank + pip, top-left (or rotated for bottom-right)."""
    label = RANK_LABEL.get(rank, rank)
    x = IDX_X
    for ch in label:
        c.grid(FONT[ch], x, IDX_Y, IDX_SCALE, {"X": suit_color}, transform)
        x += 5 * IDX_SCALE + IDX_GAP
    block_w = x - IDX_GAP - IDX_X
    pip_x = IDX_X + (block_w - 7) // 2
    c.grid(PIP_MINI[suit], pip_x, IDX_PIP_Y, 1, {"X": suit_color}, transform)


def draw_pips(c, rank, suit, suit_color):
    for col, row in LAYOUTS[rank]:
        x0 = COL_X[col]
        y0 = HALF_Y["upper" if row == "u" else "lower"] \
            if isinstance(row, str) else ROW_Y[row]
        flip = y0 + PIP_BOX // 2 > CY          # lower half reads upside down
        transform = "rotate(180 {} {})".format(x0 + PIP_BOX // 2,
                                               y0 + PIP_BOX // 2) if flip else None
        c.grid(PIP_BIG[suit], x0, y0, 1, {"X": suit_color}, transform)


def draw_ace(c, suit, suit_color):
    """Big pip sitting in an inset icon well."""
    px, py, pw, ph = 26, 44, 38, 38
    c.rect(px, py, pw, ph, INK)                                  # outline
    c.raw('<rect x="{}" y="{}" width="{}" height="{}" fill="url(#dither)"/>'
          .format(px + 1, py + 1, pw - 2, ph - 2))
    c.rect(px + 1, py + 1, pw - 2, 1, CHROME_DARK)               # inset bevel
    c.rect(px + 1, py + 2, 1, ph - 3, CHROME_DARK)
    c.rect(px + 2, py + ph - 2, pw - 3, 1, WHITE)
    c.rect(px + pw - 2, py + 2, 1, ph - 4, WHITE)
    c.grid(PIP_BIG[suit], px + 4, py + 4, 3, {"X": suit_color})


def draw_court(c, rank, suit, suit_color, accent, accent_dark):
    px, py, pw, ph = 22, 30, 46, 66
    c.rect(px, py, pw, ph, INK)
    c.rect(px + 1, py + 1, pw - 2, ph - 2, SCREEN_LIGHT)
    # striped titlebar with a rank plaque, straight off the site's windows
    c.raw('<rect x="{}" y="{}" width="{}" height="9" fill="url(#stripe)"/>'
          .format(px + 1, py + 1, pw - 2))
    c.rect(px + 1, py + 10, pw - 2, 1, INK)
    c.rect(CX - 6, py + 1, 12, 9, CHROME)
    c.grid(FONT[RANK_LABEL[rank]], CX - 3, py + 2, 1, {"X": INK})
    # portrait well
    c.raw('<rect x="{}" y="{}" width="{}" height="{}" fill="url(#dither)"/>'
          .format(px + 1, py + 11, pw - 2, ph - 12))
    colors = dict(ICON_COLORS)
    colors["a"] = accent
    colors["b"] = accent_dark
    icon_x, icon_y = px + 1, py + 11
    c.grid(COURTS[rank], icon_x, icon_y, 2, colors)
    # suit emblem on the chest
    c.grid(PIP_SMALL[suit], icon_x + 7 * 2, icon_y + 18 * 2, 2, {"X": WHITE})


def card_canvas(suit, rank):
    """Draw one card onto a fresh canvas. Returns (canvas, title).

    Split out from build_card so other artwork — the Plump logo, say — can drop
    a real card into a bigger composition instead of redrawing a lookalike.
    """
    suit_color, accent, accent_dark = SUITS[suit]
    c = Canvas()
    card_frame(c)
    if rank == "a":
        draw_ace(c, suit, suit_color)
    elif rank in COURTS:
        draw_court(c, rank, suit, suit_color, accent, accent_dark)
    else:
        draw_pips(c, rank, suit, suit_color)
    draw_index(c, rank, suit_color, suit)
    draw_index(c, rank, suit_color, suit,
               transform="rotate(180 {} {})".format(CX, CY))
    title = "{} of {}".format(
        {"j": "Jack", "q": "Queen", "k": "King", "a": "Ace"}.get(rank, rank),
        suit,
    )
    return c, title


def build_card(suit, rank):
    c, title = card_canvas(suit, rank)
    return c.to_svg(title)


def build_back(accent=BLUE, name="back"):
    c = Canvas()
    card_frame(c)
    # dithered accent field inside a ruled border
    c.rect(4, 4, W - 8, H - 8, INK)
    c.rect(5, 5, W - 10, H - 10, accent)
    c.raw('<rect x="5" y="5" width="{}" height="{}" fill="url(#backfill)"/>'
          .format(W - 10, H - 10))
    c.raw('<defs><pattern id="backfill" width="4" height="4" '
          'patternUnits="userSpaceOnUse">'
          '<rect width="2" height="2" fill="{c}"/>'
          '<rect x="2" y="2" width="2" height="2" fill="{c}"/>'
          "</pattern></defs>".format(c=SCREEN_LIGHT))
    # centre plaque: the four suits, 2 x 2
    px, py, pw, ph = 23, 41, 44, 44
    c.rect(px, py, pw, ph, INK)
    c.rect(px + 1, py + 1, pw - 2, ph - 2, CHROME)
    c.rect(px + 1, py + 1, pw - 2, 1, WHITE)
    c.rect(px + 1, py + 2, 1, ph - 3, WHITE)
    c.rect(px + 2, py + ph - 2, pw - 3, 1, CHROME_DARK)
    c.rect(px + pw - 2, py + 2, 1, ph - 4, CHROME_DARK)
    slots = [("spades", 0, 0), ("hearts", 1, 0), ("diamonds", 0, 1),
             ("clubs", 1, 1)]
    for suit, gx, gy in slots:
        color = SUITS[suit][0]
        c.grid(PIP_SMALL[suit], px + 5 + gx * 18, py + 5 + gy * 18, 2,
               {"X": color})
    return c.to_svg("Card back")


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "resources", "cards")
    os.makedirs(outdir, exist_ok=True)
    written = []
    for suit in SUITS:
        for rank in RANKS:
            path = os.path.join(outdir, "{}-{}.svg".format(suit, rank))
            with open(path, "w") as fh:
                fh.write(build_card(suit, rank))
            written.append(path)
    for name, accent in (("back", BLUE), ("back-violet", VIOLET)):
        path = os.path.join(outdir, "{}.svg".format(name))
        with open(path, "w") as fh:
            fh.write(build_back(accent, name))
        written.append(path)
    print("wrote {} files to {}".format(len(written), outdir))


if __name__ == "__main__":
    main()
