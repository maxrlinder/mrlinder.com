# Hjärter playground

Static browser game at `/RL-environment/hjarter/`, deployed with the rest of
`mrlinder.com` through GitHub Pages. Hjärter is Swedish Hearts for three to
five players. No inference server or API key is needed: the ONNX actor runs
in a module worker with ONNX Runtime Web 1.27.0 (WASM, single thread); the
runtime downloads from jsDelivr, and the checkpoint weights are served by
this site and checked by SHA-256.

The rules are cardgym's `hjarter` game: the gym's `docs/hjarter-rules.md`
records them and their sources (the common Swedish rules and a regular
table's house rules). Pass two cards (right, left, across with four players,
then none), 2♣ leads (3♣ with five players, when the 2♣ is removed), no
penalty cards in the first trick, hearts lead only once broken, hearts 1 and
Q♠ 13, and the moon gives everyone else 26. The setup screen sets every rule
the gym varies: the player count, the cards passed (0-3), the jack of
diamonds (−10) and the end score (50, 100 or 150).

The computer seats always play the self-play agent, a checkpoint of a run
still in training, at an adjustable difficulty (the shared
`../difficulty.js`); there is no other choice of computer player. Auto-play
plays your hand with the agent's best card. The gym's rule-based player
(`heuristic.js`, a port of `cardgym/games/hjarter/heuristic.py`) only steps
in if the agent fails mid-game, and the check replays its choices against
the gym. The setup's notice says what the agent has trained on, from its
manifest; the "How the agent was trained" window shows how.

The page reuses Rummy's shell (`../rummy/rummy.css` on top of `../rl.css`):
toolbar, hand, score drawer and dialogs. `hjarter.css` adds the felt: the
opponents round the far side of the oval, clockwise from your left (in a row
above the trick on phones), and the trick in the middle, each card towards
whoever played it. Also: adjustable pace and auto-play.

Everyone chooses their pass at once; the passes reach the engine in seat
order, as in the gym, where nobody sees anything of another seat's pass.
A person plays every card themselves, even a single legal one (the opening
club, a forced follow), unless auto-play has their hand; the computer seats
play theirs at once. In training, single-option moves never reach the policy.

## Engine

`engine.js` is a port of `cardgym/games/hjarter/engine.py`: the same card
numbering (`suit * 13 + rank`, suits ♣ ♦ ♠ ♥), the same events, the same
scoring. The page plays each deal as a one-deal engine started from the
totals so far, with the deal number giving the passing direction.

`node scripts/check-hjarter.mjs` (part of `npm run check`) replays games
played by the gym's engine through `engine.js`, `heuristic.js` and
`tokens.js`: every decision's seat, phase and legal cards, the rule-based
player's choice, every event, each deal's points, moon, Q♠ and J♦, and for
the first twelve games every seat's token stream of every deal (whole games
with the score in their tokens, and single deals). The fixtures cover
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

## Agent

`tokens.js` is a port of the gym's token builder
(`cardgym/games/hjarter/tokens.py`): every seat's stream of the deal, one
token per card event, rules and score on every token, built from the
engine's events as they happen. The policy reads the acting seat's stream;
its last token says who acts next. Each deal is a fresh context. The
critic's oracle stream stays in the gym.

The page builds the agent's tokens the way it trained (the manifest's
`training.mode`). Run h1 trains single deals (`mode = "deal"`), whose tokens
carry no score: the page gives each deal the context of a fresh deal (all
scores zero, the training's end score), so the agent plays every deal for
its own points. A whole-game agent (`mode = "game"`, run g1) gets the real
totals and end score. The rules fields carry the table's real rules; h1
trains passing two cards only, and at 4 players its checkpoint 10,500 beat
the rule-based players by +3.8 points per deal passing two, and by +2.9 to
+3.3 passing none, one or three (`cardgym hjarter evaluate --pass-cards`,
512 deals each).

The agent plays the computer seats at the difficulty slider's temperature
(0 to 100: uniform, as trained, argmax) and your hand on auto-play at
argmax. Single-option moves never reach it, as in training. If the agent
fails mid-game, the rule-based player takes over and the menubar says so.
In multiplayer, only the host loads the agent; it plays the computer seats
and the seat of a friend who leaves.

### Readouts

Two switches over the table, as in the other games, read the agent on your
turns. *Agent's move* puts the policy's odds (temperature 1) on your cards,
yellow on its pick, frames the cards its move uses, says it in the status
line, and notes in the log whether it agreed with your move. While you pass,
the frames and the status are the agent's own pass (its best card, then its
best given that one), and the odds are for your next card after the ones
you have chosen. Your pass is your turn even while seats ahead of you are
still passing: the page writes the turn token, and a pass token for each
card you have chosen, on a copy of your stream, exactly as the engine will.
*Advantage* reads the value probe at your stream's last token: it reads
every seat from yours, as the other seats' average points this deal minus
its own, so your advantage is your seat's value minus the seats' mean,
positive when you are expected to take fewer points than the table.

The switches load the agent if the computer seats did not need it. In
multiplayer a guest's readouts are requests the host answers from the
guest's own stream; the host loads its agent on the first.

## Updating the checkpoint

Use a Python environment with `torch`, `numpy`, `onnx` and `onnxruntime` (for
example the gym's own interpreter with `onnx` and `onnxruntime` installed to a
separate `--target` folder on `PYTHONPATH`). The sibling `card_playing_gym`
checkout is imported read-only.

```sh
python scripts/export-hjarter-model.py
npm run check
```

Without `--checkpoint`, the exporter takes the most recently written
`runs/hjarter/*/checkpoints/latest.json`, checks the checkpoint against the
pointer's hash (a live run writes the next one beside it), and writes a
versioned FP32 actor: the pass and play heads (52 card logits each, masked
by the page to the legal cards) and the per-seat value probe in points this
deal, read at the stream's last token (a whole-game agent's deal-value head:
its main value head is the game's final place, which Advantage does not
show). It verifies every output against native PyTorch on real decision
streams (every player count, both heads, both jack rules,
every passing count, single-deal and whole-game contexts) and then through
ONNX Runtime, and only then writes `model/manifest.json`, with the training
config read from the checkpoint. Remove the previous ONNX file after
verifying its replacement; commit the new file and manifest together, and
replace rather than add (`README.md`, "Large files").

### Automatic updates

While a run trains, `scripts/hjarter-autopublish.py` keeps the site on its
latest checkpoint. Start it detached beside the gym's `tools/train_cuda.sh`:

```sh
setsid nohup python3 scripts/hjarter-autopublish.py >> tmp/hjarter-autopublish.log 2>&1 &
```

Every 2 hours (`--every`) it reads the run's (`--run`, default h1)
`checkpoints/latest.json`. If that checkpoint is newer than the model on
`origin/main`, it exports it in a detached worktree (`tmp/autopublish`, so
the main checkout is never touched), removes the previous ONNX file,
refreshes the training charts' data (below; if that fails, the charts keep
their data and the model still goes out), runs `scripts/check.mjs`, and
pushes `main`. When `main`'s tip is its own previous update (the model and
the charts' data only), the new commit replaces it (same parent, `--force-with-lease`), so
history keeps one auto-published model. Anything else at the tip gets a
normal commit on top. If the main checkout is on `main` at the old tip, with
no local changes to the model directory or the charts' data, it moves that checkout's `main` to the
new commit too. It stops after the cycle that finds the training
supervisor gone, publishing that last checkpoint first. A failed cycle is
logged and retried at the next one. `--once --dry-run` runs one cycle
without committing or pushing.

It needs `onnx` and `onnxruntime` for the gym's interpreter in
`tmp/export-deps` (git-ignored). Install them without dependencies, so they
cannot shadow the gym's numpy:

```sh
uv pip install --python ../card_playing_gym/.venv/bin/python --target tmp/export-deps \
  --no-deps onnx onnxruntime protobuf ml_dtypes flatbuffers coloredlogs humanfriendly
```

It pushes over SSH with the machine's key (`--push-url`; `origin` is HTTPS,
which a detached process has no credentials for).

## Training charts

`training-charts.js` draws the two charts of the "How the agent was trained"
window from `training-data.js` with the shared `../line-chart.js`, and fills
the copy's numbers from the same data (the live checkpoint from
`model/manifest.json`). `python3 scripts/export-hjarter-training-data.py`
generates the data (standard library only) from the sibling gym checkout.
The live agent trained in two stages: single deals (h1), then whole games
to 100 fine-tuned from h1's checkpoint 22,250 (g1; its `metadata.json` names
the `for-games` release it started from, whose `info.json` names h1). Each
stage reads its run's `metrics.csv` up to the checkpoint the next stage, or
the page, took.

* **Stage 1**, a round robin of h1's checkpoints: the reports of `cardgym
  hjarter evaluate A --opponent B --output` in `runs/hjarter/h1/evals/rr_*/`
  (A in one seat, B in the others, 3-5 players, jack off and on, every deal
  with A in every seat), each pair's margin from both seatings, fitted to one
  rating per checkpoint in points per deal over the untrained network
  (weighted least squares). The chart leaves out the untrained network.
* **Stage 2**, a round robin of g1's checkpoints in whole games to 100:
  `runs/hjarter/g1/evals/rr_*/iter_A_vs_B[_jack].json` (ten checkpoints, 0
  to 7,000, 256 seeds), each checkpoint's average place per game over all
  its games, in one seat against every other checkpoint (no fit: the user
  asked for the plain average). Update 0 is the release g1 started from. The
  caption also quotes the latest checkpoint against that release, every
  1,000 updates from the run's eval watcher
  (`runs/hjarter/g1/evals/iter_N_vs_h1-games_512[_jack].json`, 512 seeds),
  and without a round robin the chart draws that series instead.

The autopublisher regenerates the data with each model, so the copy's
numbers follow the run; the round robins grow only when one is run again. A run that is not on this machine keeps its section of
the current `training-data.js`.

`npm run check` also checks the manifest against `tokens.js` (the token
width and every field's vocabulary) and the ONNX file against the
manifest's size and hash. If the gym's token layout changes, update
`tokens.js`, regenerate the fixtures and re-export, rather than just
swapping the weights.
