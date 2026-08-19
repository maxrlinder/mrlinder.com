#!/usr/bin/env python3
"""Generate token-stream fixtures pinning the browser builder to training.

The browser rebuilds the schema-v6 token stream in JavaScript. Nothing at
runtime would notice if it drifted from the stream the checkpoint was trained
on -- the model would simply play worse, quietly. So the training project's own
``build_seat_tokens`` produces the expected rows here, and
``check-plump-tokens.mjs`` asserts the JavaScript reproduces them exactly.

Each case carries the game object in the shape ``buildTokens`` consumes, so the
fixture doubles as the specification of that shape.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

import numpy as np

# The deployed browser configuration. Every field here shapes the token stream
# and must match the checkpoint's model_config.
BROWSER_MODEL_CONFIG = {
    "max_players": 5,
    "max_hand_size": 10,
    "trick_win_token": True,
    "turn_token": "bid",
}

# (players, hand size, seed) -- three seat counts and hand sizes spanning the
# trained curriculum, including both ends of it. (5, 10) is the largest round
# the site can deal, and so the only shape that exercises the last row of the
# model's position table.
SCENARIOS = (
    (3, 3, 11),
    (3, 10, 12),
    (4, 5, 13),
    (4, 7, 14),
    (5, 4, 15),
    (5, 9, 16),
    (5, 10, 17),
)


def js_card(card) -> dict:
    return {"suit": card.suit.value, "rank": int(card.rank)}


def js_events(events, event_type) -> list[dict]:
    """The public event log in the browser's shape."""

    rows = []
    for event in events:
        if event.type == event_type.BID:
            rows.append({"type": "bid", "player": event.player, "bid": event.bid})
        elif event.type == event_type.PLAY:
            rows.append(
                {
                    "type": "play",
                    "player": event.player,
                    "card": js_card(event.card),
                    "trickIndex": event.trick_index,
                    "position": event.position_in_trick,
                }
            )
        elif event.type == event_type.TRICK_WIN:
            rows.append(
                {
                    "type": "trick_win",
                    "player": event.player,
                    "trickIndex": event.trick_index,
                }
            )
    return rows


def js_tricks(round_state) -> list[dict]:
    """``round.tricks`` as the browser keeps it."""

    return [
        {
            "plays": [
                {
                    "player": play.player,
                    "card": js_card(play.card),
                    "position": play.position,
                }
                for play in trick.plays
            ],
            "winner": trick.winner,
        }
        for trick in round_state.tricks
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--plump-source",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "plump-bot",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent / "fixtures" / "plump-tokens.json",
    )
    args = parser.parse_args()

    sys.path.insert(0, str(args.plump_source.resolve()))
    from plump.cards import sort_cards
    from plump.env import PlumpEnv
    from plump.seq.config import (
        NEXT_BID,
        NEXT_NONE,
        NEXT_PLAY,
        NUM_CARDS,
        SLOT_NA_PATTERN,
        SLOT_REMAINING_HAND_START,
        SeqModelConfig,
    )
    from plump.seq.tokens import (
        build_seat_tokens,
        oracle_hand_token,
        set_na_patterns,
    )
    from plump.state import EventType, GameConfig, Phase

    config = SeqModelConfig(**BROWSER_MODEL_CONFIG)

    def oracle_reference(events, num_players, hand_size, hands, start, pending):
        """The oracle stream for a possibly in-progress round.

        ``build_oracle_tokens`` covers completed games only: it never appends a
        pending-decision TURN token, because training reads the critic at
        recorded decision positions of a finished game. The browser needs a
        readout at *now*, so it extends the oracle stream the same way it
        extends the actor stream. This composes exactly the primitives
        ``build_oracle_tokens`` composes, with the pending decision carried
        through.
        """

        pending_actor, pending_phase = pending
        canonical = build_seat_tokens(
            config,
            events,
            observer=0,
            num_players=num_players,
            hand_size=hand_size,
            initial_hand=hands[0],
            bidding_start_player=start,
            pending_actor=pending_actor,
            pending_phase=pending_phase,
        )
        cards = [
            oracle_hand_token(config, num_players, hand_size, owner, card)
            for owner in range(num_players)
            for card in sort_cards(hands[owner])
        ]
        oracle = np.concatenate(
            (
                canonical[:1],
                np.asarray(cards, dtype=np.int64),
                canonical[1 + hand_size :],
            ),
            axis=0,
        )
        # Remaining-hand snapshots belong to an observer stream only; the
        # oracle derives every current hand from its full-deal prefix.
        oracle[:, SLOT_REMAINING_HAND_START:SLOT_NA_PATTERN] = NUM_CARDS
        set_na_patterns(oracle, config)
        return oracle

    cases = []
    for num_players, hand_size, seed in SCENARIOS:
        env = PlumpEnv(
            GameConfig(num_players=num_players, hand_sizes=[hand_size]),
            seed=seed,
        )
        env.reset(seed=seed)
        rng = random.Random(seed)
        round_state = env.state.current_round
        hands = {
            player: list(cards)
            for player, cards in round_state.initial_hands.items()
        }
        start = round_state.bidding_start_player

        step = 0
        while True:
            phase = env.state.phase
            in_round = phase in (Phase.BIDDING, Phase.PLAYING)
            # Snapshot every other action plus the terminal state: enough
            # coverage of bid/play/trick-win boundaries without a fixture so
            # large it stops being reviewable.
            if step % 2 == 0 or not in_round:
                events = list(env.state.event_log)
                pending_actor = env.state.current_player if in_round else None
                pending_phase = (
                    NEXT_BID
                    if phase == Phase.BIDDING
                    else NEXT_PLAY
                    if phase == Phase.PLAYING
                    else NEXT_NONE
                )
                cases.append(
                    {
                        "name": f"p{num_players}-h{hand_size}-step{step}-{phase.value}",
                        "numPlayers": num_players,
                        "round": {
                            "handSize": hand_size,
                            "biddingStart": start,
                            "initialHands": [
                                [js_card(card) for card in hands[player]]
                                for player in range(num_players)
                            ],
                            "events": js_events(events, EventType),
                            "phase": phase.value,
                            "currentPlayer": pending_actor,
                            "tricks": js_tricks(round_state),
                        },
                        "expected": {
                            str(observer): build_seat_tokens(
                                config,
                                events,
                                observer=observer,
                                num_players=num_players,
                                hand_size=hand_size,
                                initial_hand=hands[observer],
                                bidding_start_player=start,
                                pending_actor=pending_actor,
                                pending_phase=pending_phase,
                            ).tolist()
                            for observer in range(num_players)
                        },
                        "expectedOracle": oracle_reference(
                            events,
                            num_players,
                            hand_size,
                            hands,
                            start,
                            (pending_actor, pending_phase),
                        ).tolist(),
                    }
                )
            if not in_round:
                break
            env.step(rng.choice(env.legal_actions()))
            step += 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Written compactly: indenting puts every one of ~470k token integers on its
    # own line, which costs about 8MB for a generated file nobody reads by eye.
    args.output.write_text(
        json.dumps(
            {"modelConfig": BROWSER_MODEL_CONFIG, "cases": cases},
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    size_mb = args.output.stat().st_size / 1e6
    print(f"Wrote {len(cases)} token fixtures ({size_mb:.1f}MB) to {args.output}")


if __name__ == "__main__":
    main()
