# Card deck

A full 52-card deck plus two backs, drawn in the site's System 7 / 90s-OS
language: same palette as `styles.css`, 1px ink outlines, raised bevels, striped
titlebars, dithered fills.

## Files

- `{suit}-{rank}.svg` — 52 faces. Suits: `spades`, `hearts`, `diamonds`,
  `clubs`. Ranks: `2`–`10`, `j`, `q`, `k`, `a`.
- `back.svg` (blue), `back-violet.svg` — card backs.
- `preview.html` — contact sheet of the whole deck.

## How they're built

Everything is pixel art on a 90 × 126 integer grid with
`shape-rendering="crispEdges"`, so edges stay sharp at any integer zoom and
nothing depends on a font being installed — ranks use a built-in 5 × 7 pixel
font. No external references, so they work as `<img src>`, CSS
`background-image`, or inline.

Suit accents follow the site's spectrum rule: spades blue, hearts red, diamonds
orange, clubs green. Pip colour stays traditional (red/black), so the accent is
only used for court robes and the backs.

Regenerate after editing the art:

```sh
python3 scripts/generate-cards.py            # writes into this directory
python3 scripts/generate-cards.py /some/dir   # or somewhere else
```

## Using them

Cards have no intrinsic pixel size worth respecting — scale with CSS and let the
aspect ratio do the work:

```css
.card {
  width: 90px;
  aspect-ratio: 90 / 126;
  box-shadow: 2px 2px 0 #8c8c86; /* matches .mac-window's shadow */
}
```

```js
const src = (suit, rank) => `/resources/cards/${suit}-${rank}.svg`;
```
