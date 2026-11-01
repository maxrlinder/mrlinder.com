"""Python parity fixtures for the browser's Hjärter engine.

Plays games with cardgym's own engine (the sibling card_playing_gym checkout,
imported read-only) and writes scripts/fixtures/hjarter-games.json: every
deal's hands, every decision's seat, phase, legal cards, the move made and
the rule-based player's choice, every engine event, and the deal results;
for the first games, every seat's token stream of every deal (the gym's
ObservationWriter), and the token layout and score codes.
`node scripts/check-hjarter.mjs` replays them through engine.js,
heuristic.js and tokens.js. Run it with the gym's interpreter (numpy):

    ../card_playing_gym/.venv/bin/python scripts/export-hjarter-fixtures.py
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
    parser.add_argument('--games', type=int, default=36, help='games at least; more until every case has come up')
    parser.add_argument('--token-games', type=int, default=12, help='games that also record every seat\'s token streams')
    args = parser.parse_args()
    sys.path.insert(0, str(args.source.resolve()))
    from cardgym.games.hjarter.cards import HEARTS, PENALTY_MASK, SUIT_MASKS, cards_of, suit_of
    from cardgym.games.hjarter.engine import HjarterEngine, Phase, Rules
    from cardgym.games.hjarter.heuristic import HeuristicPolicy
    from cardgym.games.hjarter.tokens import (
        DISTANCE_LIMIT, FIELD_VOCAB, LEAD_LIMIT, MODE_DEAL, MODE_GAME, WIDTH, ObservationWriter, distance_code, lead_code,
    )

    heuristic = HeuristicPolicy()
    rng = random.Random(20261031)

    # Seat policies: the rule-based player, random cards, and two that pile up
    # tricks (so moons come up) or shed them.
    def highest(engine):
        return max(engine.legal_cards())

    def lowest(engine):
        return min(engine.legal_cards())

    def randomly(engine):
        return rng.choice(engine.legal_cards())

    policies = {'heuristic': heuristic.act, 'random': randomly, 'highest': highest, 'lowest': lowest}
    seen = {
        'players': set(), 'pass': set(), 'directions': set(), 'moon': 0, 'jack': 0, 'heartsOnlyLead': 0,
        'forcedPenalty': 0, 'gameOver': 0, 'jackOff': 0, 'jackOn': 0,
    }

    def record(index, hands=None):
        players = 4 if hands else (3, 4, 5)[index % 3]
        pass_cards = 0 if hands else (2, 0, 3, 1, 2)[index % 5]
        jack = index % 4 in (1, 2)
        whole = index % 2 == 0 and not hands
        rules = Rules(pass_cards=pass_cards, jack_of_diamonds=jack, end_score=rng.choice((26, 40, 60)))
        seats = [rng.choice(('heuristic', 'heuristic', 'random', 'highest', 'lowest')) for _ in range(players)]
        if index % 7 == 3:
            # One seat takes everything it can, the others duck: moons.
            seats = ['lowest'] * players
            seats[rng.randrange(players)] = 'highest'
        events = []
        # A whole game's tokens carry the score; the others are single deals, as h1 trains.
        writer = ObservationWriter(players, rules, MODE_GAME if whole else MODE_DEAL) if index < args.token_games else None

        def listen(engine, event):
            events.append([
                int(event.kind), event.seat, event.card, event.giver, event.trick, event.position, event.led,
                event.winning, event.points, int(event.complete), event.next_seat, int(event.next_phase),
            ])
            if writer is not None:
                writer.on_event(engine, event)

        engine = HjarterEngine(
            rng.randrange(1 << 30), players=players, rules=rules, deals=None if whole else rng.choice((1, 2, 3)),
            deal_index=rng.randrange(4), dealer=rng.randrange(players), hands=hands, listener=listen,
        )
        game = {
            'players': players, 'rules': {'passCards': pass_cards, 'jackOfDiamonds': jack, 'endScore': rules.end_score},
            'deals': None if whole else engine.deals, 'dealIndex': engine.deal_index, 'dealer': engine.dealer,
            'seats': seats, 'hands': [], 'decisions': [], 'results': [],
        }
        dealt = 0
        while not engine.done:
            if engine.deals_played + 1 > dealt:
                game['hands'].append([cards_of(hand) for hand in engine.dealt])
                dealt += 1
            seat = engine.current
            legal = engine.legal_cards()
            hand = engine.held
            if engine.phase == Phase.PLAY and not engine.trick and engine.trick_index and not engine.broken \
                    and not hand & ~SUIT_MASKS[HEARTS]:
                seen['heartsOnlyLead'] += 1
            if engine.phase == Phase.PLAY and engine.trick and engine.trick_index == 0 \
                    and not hand & SUIT_MASKS[engine.led] and not hand & ~PENALTY_MASK:
                seen['forcedPenalty'] += 1
            action = policies[seats[seat]](engine)
            game['decisions'].append({
                'seat': seat, 'phase': int(engine.phase), 'legal': legal, 'action': action, 'heuristic': heuristic.act(engine),
            })
            engine.apply(action)
        for result in engine.results:
            game['results'].append({
                'index': result.index, 'direction': result.direction, 'passed': result.passed, 'taken': result.taken,
                'points': result.points, 'moon': result.moon, 'queen': result.queen, 'jack': result.jack, 'scores': result.scores,
            })
            seen['directions'].add((players, result.direction))
            seen['moon'] += result.moon >= 0
            seen['jack'] += result.jack >= 0
        game['events'] = events
        game['scores'] = engine.scores
        if writer is not None:
            # Every seat's stream, split where each deal starts a fresh context: streams[deal][seat].
            game['mode'] = writer.mode
            split = []
            for seat in range(players):
                rows = [list(map(int, row)) for row in writer.pending[seat]]
                starts = writer.deal_starts[seat] + [len(rows)]
                split.append([rows[a:b] for a, b in zip(starts, starts[1:])])
            game['streams'] = [list(deal) for deal in zip(*split)]
        seen['players'].add(players)
        seen['pass'].add(pass_cards)
        seen['gameOver'] += whole
        seen['jackOn' if jack else 'jackOff'] += 1
        return game

    def covered():
        return (
            seen['players'] == {3, 4, 5} and seen['pass'] == {0, 1, 2, 3} and seen['moon'] >= 2 and seen['jack'] >= 3
            and seen['heartsOnlyLead'] >= 1 and seen['forcedPenalty'] >= 1
            and {(4, 3), (4, 1), (4, 2), (3, 2), (3, 1), (5, 4), (5, 1)} <= seen['directions']
        )

    # Rare by chance: a seat void in clubs holding only penalty cards in the
    # first trick. Seat 1 has twelve hearts and Q♠, seat 3 the A♥ and spades.
    clubs, diamonds, spades, hearts = (list(range(13 * suit, 13 * suit + 13)) for suit in range(4))
    queen = spades[10]
    games = [record(0, hands=[clubs, hearts[:12] + [queen], diamonds, [hearts[12]] + [c for c in spades if c != queen]])]
    while len(games) < args.games or not covered():
        games.append(record(len(games)))
        if len(games) > 400:
            raise SystemExit(f'Coverage not reached: {seen}')
    tokens = {
        'width': WIDTH, 'fieldVocab': list(FIELD_VOCAB),
        'leadCodes': [lead_code(d) for d in range(-LEAD_LIMIT - 20, LEAD_LIMIT + 21)], 'leadFrom': -LEAD_LIMIT - 20,
        'distanceCodes': [distance_code(d) for d in range(-20, DISTANCE_LIMIT + 21)], 'distanceFrom': -20,
    }
    path = ROOT / 'scripts/fixtures/hjarter-games.json'
    path.write_text(json.dumps({'tokens': tokens, 'games': games}, separators=(',', ':')) + '\n')
    deals = sum(len(game['results']) for game in games)
    decisions = sum(len(game['decisions']) for game in games)
    streams = sum(len(deal) for game in games for deal in game.get('streams', []))
    print(f'{len(games)} games, {deals} deals, {decisions} decisions, {streams} token streams, {seen["moon"]} moons, {seen["jack"]} J♦ taken, '
          f'{seen["heartsOnlyLead"]} hearts-only leads, {seen["forcedPenalty"]} forced penalty discards in the first trick '
          f'-> {path.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
