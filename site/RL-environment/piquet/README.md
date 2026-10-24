# Piquet playground

Static browser game at `/RL-environment/piquet/`, deployed with the rest of
`mrlinder.com` through GitHub Pages. No inference server or API key is needed.
The ONNX actor runs in a module worker with ONNX Runtime Web 1.27.0 (WASM,
single thread); the runtime downloads from jsDelivr, and the checkpoint weights
are served by this site and checked by SHA-256.

The rules are cardgym's `piquet` game (see the gym's `docs/piquet.md`): two
players, 32 cards, the exchange with the talon, point, sequence and sets,
twelve tricks, carte blanche, pique, repique and capot. You play the agent a
partie, as it was trained (`modes = ["rubicon"]`): six deals with the deal
alternating and Rubicon scoring. Each deal is a fresh context (its streams
start empty), and every token carries the score: both running totals (earlier
deals plus this deal's points so far), the lead, the deal number and the mode.
The page keeps the totals and hands them to each deal's engine.

The page reuses Rummy's shell (`../rummy/rummy.css` on top of `../rl.css`):
toolbar, switches, hand, badges, score drawer and dialogs. `piquet.css` adds the
felt: the opponent, the talon (with the cards Elder left and both sides'
discards), the declarations board and the trick. Also: an agent-difficulty
slider (the shared `../difficulty.js`), adjustable pace and auto-play.

You choose your whole exchange at once; it reaches the engine one card at a
time and then "stop", the way the agent chooses, so your token stream matches
training exactly. Single-option moves are taken automatically, as in training.

## Readouts

**Agent's move** marks every legal move with the policy's probability at
temperature 1; the agent's pick is the yellow badge. In the exchange the agent
picks one card at a time, so the readout follows its top choice until it stops
and lights up the whole exchange it would make, from whatever you have
selected so far; "Choose the agent's cards" selects them.

**Advantage** reads the actor's value head. Its zero-sum part, (v₀ − v₁) / 2,
is the training target: what the partie is expected to score for you, the
Rubicon payoff (positive when you win it), shown in whole points. A
single-deal model (manifest `valueTarget: "deal"`) predicts your points minus
your opponent's this deal instead, shown in tenths. It shows yours now and, on
every move, yours once that move is made, all from one forward pass: the
export takes a batch of one-token
continuations of the stream, each attending to the stream's keys and values.
A move's continuation is the first token it adds to your stream: your own
event (the card played, the declaration, the exchange) or, while you choose
discards, your next decision token. The value head is trained at every token,
so these are states the agent itself values. The moves' values are shifted
together so that they average, under the policy, to the value now (an
advantage function's defining property).

Two kinds of move would show you cards you cannot see in that token: an
exchange (what you draw from the talon) and conceding a declaration ("good":
your opponent shows the winning cards). For those the page re-deals every card
hidden from you among the places it could be (your opponent's hand and
discards, the talon; cards shown by carte blanche stay with your opponent),
rejecting re-deals that contradict what your opponent declared, and averages
the value over 16 (exchange) or 12 (concede) of them. Your view is identical
in every re-deal, so nothing hidden leaks. Moves the policy plays under 1% of
the time are greyed: the head learned from states the agent's own play
reaches, so its value there is an extrapolation.

**The agent's card read** (in the score sheet) shows the belief head from your
seat: for every card you cannot place, its split between your opponent's
hand, your opponent's discards and the talon.

## Training charts

`training-charts.js` draws the charts of the "How the agent was trained" and
"How it was played" windows from `training-data.js`: line charts with the
shared `../line-chart.js`, and the round robin's pair matrix of its own.
`python scripts/export-piquet-training-data.py` generates the data (standard
library only). The live agent trained in two stages: single deals (p2), then
whole parties fine-tuned from p2's checkpoint 13,600 (partie1; its
`metadata.json` names the parent), with 192 parties per update and from update
12,700 576 (the charts mark the change, found in `metrics.csv`). Each stage
reads its run's `metrics.csv` up to the checkpoint the next stage, or the page,
took. `--evals` holds `cardgym piquet evaluate --output` reports: duplicate
deals against the rule-based heuristic, for the deal stage. A stage whose run
is not on this machine keeps its section of the current `training-data.js`
(the deal stage's data, generated on the Mac, runs to update 13,000).

"How it was played" is a round robin of the single-deal agent and 19 evenly
spaced checkpoints of the partie training, written by the gym's
`tools/piquet_tournament.py --output` and read with `--tournament` (without
it, the current round robin stays):

```sh
cd ../card_playing_gym
its="1200 2400 3600 4800 5900 7100 8300 9500 10700 11900 13100 14300 15500 16700 17800 19000 20200 21400 22600"
paths=$(for i in $its; do printf 'runs/piquet/partie1/checkpoints/iter_%06d.pt ' "$i"; done)
.venv/bin/python tools/piquet_tournament.py checkpoints/piquet/p2 $paths --labels "0,${its// /,}" \
  --deals 64 --max-rounds 4 --resolution 1.25 --chunk 768 --output /tmp/piquet-rr.json
cd ../mrlinder.com
python3 scripts/export-piquet-training-data.py --tournament /tmp/piquet-rr.json
```

Every pair plays duplicate parties (each dealt twice with the seats swapped,
moves sampled as in training) in rounds of 64, until every rating's standard
error is within 1.25 points or after four rounds: up to 512 parties per pair,
97,280 in all, 35 minutes on the RTX 2070 Super with training paused. The ratings are
least-squares Rubicon points per partie relative to the single-deal agent; the
records against the field average each checkpoint's 19 pairs. A worker holds a
finished partie's trajectory (~0.7 MB) until its chunk ends, so `--chunk 768`
keeps each of the three workers near 1.4 GB of RAM.

## Updating the checkpoint

Use a Python environment with `torch`, `numpy`, `onnx` and `onnxruntime` (for
example the gym's own interpreter with `onnx` and `onnxruntime` installed to a
separate `--target` folder on `PYTHONPATH`). The sibling `card_playing_gym`
checkout is imported read-only.

```sh
python scripts/export-piquet-model.py --checkpoint ../card_playing_gym/runs/piquet/partie1/checkpoints/iter_022600.pt
npm run check
```

Without `--checkpoint`, the exporter resolves the most recently written
`runs/piquet/*/checkpoints/latest.json`. It writes a versioned FP32 actor (the
three policy heads, the value head now and after each `following` token, and
the belief head), verifies every output against native PyTorch on real deal
prefixes and each continuation against the whole extended stream, then
updates `model/manifest.json`. The manifest's `valueTarget` comes from the
run's config: `partie` for a run trained on `rubicon`, `deal` otherwise (a
release directory has no config). A single-deal checkpoint loads blind to the
score fields, so it also plays in this layout. The exporter also regenerates
the Python fixtures, `scripts/fixtures/piquet-deals.json`: whole parties, at
least eight and on until a repique, a pique and a capot have come up. Remove
the previous ONNX file only after verifying its replacement; commit the new
file and manifest together.

`node scripts/check-piquet.mjs` (part of `npm run check`) replays the Python
parties deal by deal through `engine.js`, carrying the totals as the page
does, and compares every decision's seat, head and legal actions, every token
of both seats' streams, the scores, bonuses and category winners, and each
partie's Rubicon payoff. The fixtures include carte blanche for each role,
repique, pique and capot, all six deal numbers, and totals and leads in the
ranges coded in tens. If the gym's rules or token layout change, update `engine.js`
and the manifest schema instead of just swapping the weights.
