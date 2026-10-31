# Hjärter playground

Static browser game at `/RL-environment/hjarter/`, deployed with the rest of
`mrlinder.com` through GitHub Pages. Hjärter is Swedish Hearts for three to
five players.

The rules are cardgym's `hjarter` game: the gym's `docs/hjarter-rules.md`
records them and their sources (the common Swedish rules and a regular
table's house rules). Pass two cards (right, left, across with four players,
then none), 2♣ leads (3♣ with five players, when the 2♣ is removed), no
penalty cards in the first trick, hearts lead only once broken, hearts 1 and
Q♠ 13, and the moon gives everyone else 26. The setup screen sets every rule
the gym varies: the player count, the cards passed (0-3), the jack of
diamonds (−10) and the end score (50, 100 or 150).

The self-play agent is still in training. Until it is exported, the computer
seats play the gym's rule-based players (`heuristic.js`, a port of
`cardgym/games/hjarter/heuristic.py`): the textbook game, or random legal
cards. There are no agent readouts and no training section yet.

The page reuses Rummy's shell (`../rummy/rummy.css` on top of `../rl.css`):
toolbar, hand, score drawer and dialogs. `hjarter.css` adds the felt: the
opponents round the far side of the oval, clockwise from your left (in a row
above the trick on phones), and the trick in the middle, each card towards
whoever played it. Also: adjustable pace and auto-play.

Everyone chooses their pass at once; the passes reach the engine in seat
order, as in the gym, where nobody sees anything of another seat's pass.
Single-option moves (the opening club, a forced follow) are played
automatically, as in training.

## Engine

`engine.js` is a port of `cardgym/games/hjarter/engine.py`: the same card
numbering (`suit * 13 + rank`, suits ♣ ♦ ♠ ♥), the same events, the same
scoring. The page plays each deal as a one-deal engine started from the
totals so far, with the deal number giving the passing direction.

`node scripts/check-hjarter.mjs` (part of `npm run check`) replays games
played by the gym's engine through `engine.js` and `heuristic.js`: every
decision's seat, phase and legal cards, the rule-based player's choice,
every event, and each deal's points, moon, Q♠ and J♦. The fixtures cover
three to five players, every passing count and direction, both jack
variants, moons, a hearts-only lead and a first-trick hand of only penalty
cards. To regenerate them with the gym's interpreter:

```sh
../card_playing_gym/.venv/bin/python scripts/export-hjarter-fixtures.py
```

If the gym's rules change, update `engine.js` and regenerate the fixtures.

## Multiplayer

A peer-to-peer table through the shared `../multiplayer.js` (Trystero,
namespaced per game): the host and up to four friends, with the computer in
the seats nobody takes. The host sets the rules, deals, checks every move and
plays the computer seats. A guest receives only its seat's view: its own
hand, every seat's card count, the trick and the cards played, its own pass
and the cards passed to it, and its legal cards on its turn. Other seats'
hands, their passes and what they were passed stay on the host (the log
shows another seat's pass as a count). A guest sends its pass (checked: its
own cards, the right number, once) and its moves (checked against the
legal cards and the decision they answer). If a friend leaves, the computer
takes their seat and the game plays on.

## When the agent is ready

The gym's tokens (`cardgym/games/hjarter/tokens.py`) are built from the
engine's events, which `engine.js` already emits in the same order with the
same fields. Port the token builder, add an exporter and a model worker as
Piquet's (`../piquet/README.md`), extend the check to compare tokens, and
replace `heuristicCard` for the computer seats with the agent.
