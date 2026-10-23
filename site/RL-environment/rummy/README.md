# Rummy playground

Static browser game at `/RL-environment/rummy/`, deployed with the rest of
`mrlinder.com` through GitHub Pages. No inference server or API key is needed.
The ONNX actor runs in a module worker with ONNX Runtime Web 1.27.0 (WASM,
single thread, so cross-origin isolation is not required). The runtime downloads
from jsDelivr; checkpoint weights are served by this site and checked by SHA-256.

The rules are cardgym's from run r7 on: Scandinavian rummy with 500 Rum's
discard pile and scoring. The UI supports 2–4 players, one or two decks,
7-card hands, three-card melds (further cards are lay-offs, one at a time; selecting a longer meld lays it as three plus lay-offs in one go), deep discard pickups (with the obligation to use the dug-out card
that turn, directly or at the end of a lay-off chain along a table run; a taken top card cannot be discarded again the same turn), sets, cyclic runs, lay-offs, points for every card laid, an agent-difficulty
slider (the shared `../difficulty.js`: random play, T = 1 at the centre, argmax),
two readout switches, the agent's move and your advantage (below), round scores, table totals, adjustable pace, and
auto-play. New tables clear table totals; another
round retains them. Refreshing the page clears the current game.

## Multiplayer

Peer-to-peer tables use the shared `../multiplayer.js` (Trystero, namespaced
per game). The host owns the engine, every seat's token stream and the agent.
Each guest receives only its own seat's view: its hand, public cards, the legal
moves on its turn, and the log with other players' stock draws redacted. Guests
send moves by decision id; the host checks them against the legal list before
playing them. The host also computes a guest's readouts (the agent's move and
the advantage) from that guest's own stream. If a guest leaves, the agent takes over the seat.

## Readouts

**Agent's move** marks every move with the policy's probability at temperature
1; the agent's pick is the yellow badge, and the hand cards it would play glow.
When its pick lays three and its next move adds to them, the readout looks one
decision ahead and offers the whole meld.

**Advantage** reads the actor's value head: a seat's expected points at the end
of the round minus the other seats' average (the training target, zero-sum).
It shows yours now, and on every move your advantage once that move is made,
one decision ahead, all from one forward pass: the export takes a batch of
one-token continuations of the stream, each attending to the stream's cached
keys and values. A draw, meld or lay-off leaves you deciding again, so its
value is read at that next decision token; a stock draw averages over every
card you cannot see, weighted by unseen copies, so nothing hidden leaks. A
discard ends the turn and what follows depends on hidden hands, so its token is
written as if you decided again at once. That proxy ranks discards about as
well as rollouts do but reads 4–6 points high, so the discards share an offset
set to make the moves' values average, under the policy, to the value now (an
advantage function's defining property), leaning on its typical size (5) when
the policy puts little weight on discarding. In a draw the after-states share
the head's fraction-of-a-point noise the same way. Going out scores exactly.
Moves the policy plays under 1% of the time are greyed: the head learned from
states the agent's own play reaches, so its value there is an extrapolation.

## Training charts

`training-charts.js` draws the "How the agent was trained" charts with the
shared `../line-chart.js` (also used by Plump) from `training-data.js`, which
`python scripts/export-rummy-training-data.py` generates (numpy only) from the
gym's run r7: the checkpoint round robin and the argmax comparison written by
`tools/tournament.py --output`, refitted without update 0 so ratings are points
per game above the field average, plus the hold rate and training totals up to
the checkpoint in `model/manifest.json`. Re-run it after publishing a new
checkpoint or tournament.

## Updating the checkpoint

Use a Python environment with `torch`, `numpy`, `onnx`, and `onnxruntime`
(for example the gym's own interpreter with `onnx` and `onnxruntime` installed
to a separate `--target` folder on `PYTHONPATH`).
The sibling `card_playing_gym` checkout is imported read-only; its training
process and environment do not need to be changed.

```sh
python scripts/export-rummy-model.py
# Or pin an exact checkpoint:
python scripts/export-rummy-model.py --checkpoint ../card_playing_gym/runs/rummy/r7/checkpoints/iter_025900.pt
npm run check
```

Without `--checkpoint`, the exporter resolves the most recently written
`runs/rummy/*/checkpoints/latest.json` once. It writes a versioned FP32 actor
(schema 3: candidate logits, the value head now, and the value head after each
`following` token), then verifies every output against native PyTorch on real
decision sequences, each continuation against the whole extended stream,
before updating `model/manifest.json`. It also regenerates `rules-data.js` and the
Python game fixtures. Check the generated manifest for provenance, source and
artifact hashes, and numerical validation results. Remove the previous ONNX
file only after verifying its replacement; commit the new file and manifest
together. The browser reads the manifest without caching and caches immutable
versioned weights normally.

`node scripts/check-rummy.mjs` replays Python traces through the JS engine and
compares every decision token, opponent-turn token, ordered legal action,
candidate feature (including the cards each pickup takes), and final score.
It checks card conservation and all 589 melds and extensions. This check is also
part of `npm run check`. If the training representation or rules change, update
the browser engine and manifest schema instead of just swapping the weights.

Each seat's stream interleaves a decision token before each of its own
decisions with a turn token for every completed opponent turn, as in training.
The actor sees only its private hand plus public information. Histories are retained separately for
each seat. UI rendering never advances the observation writer. A model failure
pauses the game and allows retry; it does not substitute a different policy.
