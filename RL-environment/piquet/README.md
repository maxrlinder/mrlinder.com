# Piquet playground

Static browser game at `/RL-environment/piquet/`, deployed with the rest of
`mrlinder.com` through GitHub Pages. No inference server or API key is needed.
The ONNX actor runs in a module worker with ONNX Runtime Web 1.27.0 (WASM,
single thread); the runtime downloads from jsDelivr, and the checkpoint weights
are served by this site and checked by SHA-256.

The rules are cardgym's `piquet` game (see the gym's `docs/piquet.md`): two
players, 32 cards, the exchange with the talon, point, sequence and sets,
twelve tricks, carte blanche, pique, repique and capot. You play the agent one
deal at a time, as it was trained (`modes = ["deal"]`); the page keeps the
partie around it: six deals with the deal alternating and Rubicon scoring, or
endless deals with a running total. Token fields for partie totals, the deal
number and the mode therefore stay 0, exactly as in training.

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
is your expected points minus your opponent's at the end of the deal (the
training target). It shows yours now and, on every move, yours once that move
is made, all from one forward pass: the export takes a batch of one-token
continuations of the stream, each attending to the stream's keys and values.
A move's continuation is the first token it adds to your stream: your own
event (the card played, the declaration, the exchange) or, while you choose
discards, your next decision token. The value head is trained at every token,
so these are states the agent itself values; before any correction the
moves' values average, under the policy, to within about a point of the value
now. They are shifted together to match it exactly (an advantage function's
defining property).

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

`training-charts.js` draws the "How the agent was trained" charts with the
shared `../line-chart.js` from `training-data.js`, which
`python scripts/export-piquet-training-data.py --evals <dir>` generates
(standard library only) from the run's `metrics.csv` up to the published
checkpoint and a directory of `cardgym piquet evaluate --output` reports
(duplicate deals against the rule-based heuristic), for example:

```sh
cd ../card_playing_gym
for i in 000000 000200 000500 001000 002000 003000 004000 006000 008000 010000 013000; do
  .venv/bin/python -m cardgym piquet evaluate runs/piquet/p2/checkpoints/iter_$i.pt --deals 512 --output /tmp/piquet-eval/iter_$i.json
done
```

## Updating the checkpoint

Use a Python environment with `torch`, `numpy`, `onnx` and `onnxruntime` (for
example the gym's own interpreter with `onnx` and `onnxruntime` installed to a
separate `--target` folder on `PYTHONPATH`). The sibling `card_playing_gym`
checkout is imported read-only.

```sh
python scripts/export-piquet-model.py --checkpoint ../card_playing_gym/runs/piquet/p2/checkpoints/iter_013000.pt
npm run check
npm run build
```

Without `--checkpoint`, the exporter resolves the most recently written
`runs/piquet/*/checkpoints/latest.json`. It writes a versioned FP32 actor (the
three policy heads, the value head now and after each `following` token, and
the belief head), verifies every output against native PyTorch on real deal
prefixes and each continuation against the whole extended stream, then
updates `model/manifest.json`. It also regenerates the Python fixtures,
`scripts/fixtures/piquet-deals.json`. Remove the previous ONNX file only after
verifying its replacement; commit the new file and manifest together.

`node scripts/check-piquet.mjs` (part of `npm run check`) replays the Python
deals through `engine.js` and compares every decision's seat, head and legal
actions, every token of both seats' streams, and the scores, bonuses and
category winners; the fixtures include carte blanche for each role, repique,
pique and capot. If the gym's rules or token layout change, update `engine.js`
and the manifest schema instead of just swapping the weights.
