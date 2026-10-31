"""Python parity fixtures for the browser's Hjärter engine.

Plays games with cardgym's own engine (the sibling card_playing_gym checkout,
imported read-only) and writes scripts/fixtures/hjarter-games.json: every
deal's hands, every decision's seat, phase, legal cards, the move made and
the rule-based player's choice, every engine event, and the deal results.
`node scripts/check-hjarter.mjs` replays them through engine.js and
heuristic.js. Standard library only, besides the gym.

    python3 scripts/export-hjarter-fixtures.py
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
    args = parser.parse_args()
    sys.path.insert(0, str(args.source.resolve()))
    from cardgym.games.hjarter.cards import HEARTS, PENALTY_MASK, SUIT_MASKS, cards_of, suit_of
    from cardgym.games.hjarter.engine import HjarterEngine, Phase, Rules
    from cardgym.games.hjarter.heuristic import HeuristicPolicy

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
        engine = HjarterEngine(
            rng.randrange(1 << 30), players=players, rules=rules, deals=None if whole else rng.choice((1, 2, 3)),
            deal_index=rng.randrange(4), dealer=rng.randrange(players), hands=hands,
            listener=lambda e, ev: events.append([
                int(ev.kind), ev.seat, ev.card, ev.giver, ev.trick, ev.position, ev.led, ev.winning, ev.points,
                int(ev.complete), ev.next_seat, int(ev.next_phase),
            ]),
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
    path = ROOT / 'scripts/fixtures/hjarter-games.json'
    path.write_text(json.dumps(games, separators=(',', ':')) + '\n')
    deals = sum(len(game['results']) for game in games)
    decisions = sum(len(game['decisions']) for game in games)
    print(f'{len(games)} games, {deals} deals, {decisions} decisions, {seen["moon"]} moons, {seen["jack"]} J♦ taken, '
          f'{seen["heartsOnlyLead"]} hearts-only leads, {seen["forcedPenalty"]} forced penalty discards in the first trick '
          f'-> {path.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
