"""Python parity fixtures for the browser ports of cardgym's value bounds (Rummy, Piquet, Plump).

Plays games with cardgym (imported read-only from the sibling checkout) and
writes scripts/fixtures/bounds.json: states as the browser engines hold them,
each with the bounds cardgym computes for it. ``scripts/check-bounds.mjs``
holds rummy/bounds.js, piquet/bounds.js and plump/bounds.js to them.
(Hjärter's are in scripts/fixtures/hjarter-bounds.json, from
export-hjarter-fixtures.py.)

    ../card_playing_gym/.venv/bin/python scripts/export-bounds-fixtures.py
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--source', type=Path, default=ROOT.parent / 'card_playing_gym')
    args = parser.parse_args()
    sys.path.insert(0, str(args.source.resolve()))
    import numpy as np
    from cardgym.games.piquet import bounds as piquet_bounds
    from cardgym.games.piquet.selfplay import PiquetSelfPlay
    from cardgym.games.plump.bounds import relative_bounds, round_scores
    from cardgym.games.plump.selfplay import PlumpSelfPlay
    from cardgym.games.plump.tokens import Schema
    from cardgym.games.rummy.bounds import state_bounds as rummy_state_bounds
    from cardgym.games.rummy.heuristic import HeuristicPolicy
    from cardgym.games.rummy.selfplay import RummySelfPlay

    rounded = lambda bounds: [[round(float(lo), 6), round(float(hi), 6)] for lo, hi in bounds]  # noqa: E731
    out = {'rummy': [], 'piquet': [], 'plump': []}

    # Rummy: rounds played by the rule-based player (it melds and lays off), states after every step.
    policy = HeuristicPolicy()
    for seed, (players, decks) in enumerate([(2, 1), (3, 1), (3, 2), (2, 2)] * 3):
        game = RummySelfPlay(players, 7, seed=seed, decks=decks, max_turns=200)
        while True:
            engine = game.engine
            out['rummy'].append({
                'players': players, 'decks': decks, 'points': [int(p) for p in engine.points],
                'table': [int(m) for m in engine.table], 'bounds': rounded(rummy_state_bounds(engine)),
            })
            if game.done():
                break
            game.step(policy.act(engine))

    # Piquet: random play, single deals and Rubicon parties, states at every token.
    for seed in range(16):
        mode = 'rubicon' if seed % 4 == 0 else 'deal'
        game = PiquetSelfPlay(seed, mode=mode)
        rng = random.Random(seed)
        while not game.done():  # the browser's engine never adds a finished deal into its totals
            engine = game.engine
            out['piquet'].append({
                'phase': engine.phase, 'category': engine.category, 'trickIndex': engine.trick_index,
                'tricks': list(engine.tricks), 'points': list(engine.points), 'elder': engine.elder,
                'result': {'repique': engine.result.repique, 'pique': engine.result.pique},
                'totals': list(engine.totals), 'dealIndex': engine.deal_index, 'rubicon': engine.rubicon,
                'deals': engine.deals, 'bounds': rounded(piquet_bounds.state_bounds(engine)),
            })
            game.step(int(rng.choice(np.flatnonzero(game.decision().legal).tolist())))

    # Plump: random rounds, states after every step; bounds per absolute seat.
    schema = Schema(max_players=5, max_hand_size=10)
    for seed in range(24):
        players, hand = [3, 4, 5][seed % 3], 3 + seed % 8
        if players * hand > 52:
            continue
        game = PlumpSelfPlay(schema, players, hand, bidding_start=seed % players, seed=seed)
        rng = random.Random(seed)
        while True:
            state = game.env.state.current_round
            bids = {bid.player: bid.value for bid in state.bids}
            won = [state.tricks_won.get(seat, 0) for seat in range(players)]
            done = sum(won)
            scores = round_scores([bids.get(seat) for seat in range(players)], won, hand - done, hand)
            out['plump'].append({
                'players': players,
                'round': {
                    'handSize': hand, 'bids': [{'player': p, 'value': v} for p, v in bids.items()],
                    'tricksWon': won, 'tricks': [{'winner': 0}] * done,
                },
                'bounds': rounded(relative_bounds(scores)),
            })
            if game.done():
                break
            game.step(int(rng.choice(np.flatnonzero(game.decision().legal).tolist())))

    path = ROOT / 'scripts/fixtures/bounds.json'
    path.write_text(json.dumps(out, separators=(',', ':')) + '\n')
    print(' · '.join(f'{name} {len(states)} states' for name, states in out.items()), '->', path.relative_to(ROOT))


if __name__ == '__main__':
    main()
