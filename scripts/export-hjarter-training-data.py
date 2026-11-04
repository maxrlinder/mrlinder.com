#!/usr/bin/env python3
"""Write site/RL-environment/hjarter/training-data.js for the "How the agent was trained" charts.

The live agent (model/manifest.json) trained in two stages: single deals, then
whole games to 100 fine-tuned from a single-deal checkpoint (the run's
metadata.json names the `cardgym hjarter for-games` release it started from,
whose info.json names the run and checkpoint behind it). Each stage reads its
run's metrics.csv up to the checkpoint the next stage, or the page, took.

The deal stage's chart is a round robin of checkpoints: the JSON reports of
`cardgym hjarter evaluate A --opponent B --output` in the run's
evals/rr_*/iter_A_vs_B[_jack].json (A in one seat, B in the others, 3-5
players), fitted to one rating per checkpoint in points per deal over the
untrained network. The game stage's chart is every checkpoint against the
release it started from: evals/iter_N_vs_<release>_512[_jack].json, written
by the run's eval watcher (512 seeds, whole games, 3-5 players). Only
checkpoints up to the live one count. A run that is not on this machine keeps
its section of the current training-data.js. Standard library only.

Usage: python3 scripts/export-hjarter-training-data.py [--source ../card_playing_gym]
"""
import argparse
import csv
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'site/RL-environment/hjarter/training-data.js'
PREFIX = 'export const HJARTER_TRAINING_DATA = '
PLAYERS = ('3', '4', '5')
# The actor's parameters (8.6M trunk, card heads, value probes and side heads); the
# exported ONNX holds the same weights.
PARAMETERS = 8_651_016


def solve(matrix, vector):
    """Gauss-Jordan: the solution of matrix x = vector and the inverse of matrix."""
    n = len(vector)
    rows = [list(map(float, row)) + [float(vector[i])] + [float(i == j) for j in range(n)] for i, row in enumerate(matrix)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(rows[r][col]))
        rows[col], rows[pivot] = rows[pivot], rows[col]
        scale = rows[col][col]
        rows[col] = [value / scale for value in rows[col]]
        for r in range(n):
            if r != col and rows[r][col]:
                factor = rows[r][col]
                rows[r] = [a - factor * b for a, b in zip(rows[r], rows[col])]
    return [row[n] for row in rows], [row[n + 1:] for row in rows]


def ratings(iterations, margins):
    """Least squares ratings r_a - r_b = margin (weights 1 / variance), the first iteration at 0."""
    free = iterations[1:]
    index = {iteration: i for i, iteration in enumerate(free)}
    normal = [[0.0] * len(free) for _ in free]
    rhs = [0.0] * len(free)
    for (a, b), (margin, variance) in margins.items():
        row = [0.0] * len(free)
        if a in index:
            row[index[a]] += 1
        if b in index:
            row[index[b]] -= 1
        weight = 1 / variance
        for i, x in enumerate(row):
            rhs[i] += weight * x * margin
            for j, y in enumerate(row):
                normal[i][j] += weight * x * y
    solution, inverse = solve(normal, rhs)
    return {iterations[0]: (0.0, 0.0), **{it: (solution[i], math.sqrt(inverse[i][i])) for it, i in index.items()}}


def round_robin(evals):
    """One rating per checkpoint from every pair's margin, both seatings, over all and per player count."""
    reports = {}
    for path in sorted(evals.glob('rr_*/iter_*_vs_*.json')):
        match = re.fullmatch(r'iter_(\d+)_vs_(\d+)(_jack)?\.json', path.name)
        if match:
            # A later round robin's report of the same pairing replaces an earlier one's.
            reports[int(match[1]), int(match[2]), bool(match[3])] = json.loads(path.read_text())['players']
    iterations = sorted({a for a, _, _ in reports} | {b for _, b, _ in reports})

    def margins(players):
        pairs = {}
        for a in iterations:
            for b in iterations:
                if a >= b:
                    continue
                cells = []
                for jack in (False, True):
                    x, y = reports.get((a, b, jack)), reports.get((b, a, jack))
                    if x is None or y is None:
                        continue
                    for p in players:
                        cells.append(((x[p]['model_return'] - y[p]['model_return']) / 2,
                                      (x[p]['stderr'] ** 2 + y[p]['stderr'] ** 2) / 4))
                if len(cells) == 2 * len(players):
                    pairs[a, b] = (sum(m for m, _ in cells) / len(cells), sum(v for _, v in cells) / len(cells) ** 2)
        return pairs

    overall = ratings(iterations, margins(PLAYERS))
    each = {p: ratings(iterations, margins((p,))) for p in PLAYERS}
    pairs = margins(PLAYERS)
    return dict(
        anchor=iterations[0], pairs=len(pairs),
        checkpoints=[dict(iteration=it, rating=round(overall[it][0], 3), stderr=round(overall[it][1], 3),
                          players={p: round(each[p][it][0], 2) for p in PLAYERS}) for it in iterations],
    )


def game_evals(evals, release, until):
    """The placement of each checkpoint, in one seat against the release in the others, both jack rules."""
    rows = [dict(iteration=0, placement=0.0, stderr=0.0,
                 players={p: dict(placement=0.0, wins=round(1 / int(p), 4)) for p in PLAYERS})]
    for path in sorted(evals.glob(f'iter_*_vs_{release}_512.json')):
        jack = path.with_name(path.stem + '_jack.json')
        iteration = int(path.name[5:11])
        if not jack.exists() or iteration > until:
            continue
        cells = [json.loads(path.read_text())['players'], json.loads(jack.read_text())['players']]
        returns = [c[p]['model_return'] for c in cells for p in PLAYERS]
        variance = sum(c[p]['stderr'] ** 2 for c in cells for p in PLAYERS)
        rows.append(dict(
            iteration=iteration, placement=round(sum(returns) / len(returns), 4),
            stderr=round(math.sqrt(variance) / len(returns), 4), seeds=512,
            players={p: dict(placement=round(sum(c[p]['model_return'] for c in cells) / 2, 4),
                             stderr=round(math.sqrt(sum(c[p]['stderr'] ** 2 for c in cells)) / 2, 4),
                             wins=round(sum(c[p]['win_share'] for c in cells) / 2, 4),
                             points=round(sum(c[p]['model_points_per_deal'] for c in cells) / 2, 2),
                             table=round(sum(c[p]['opponent_points_per_deal'] for c in cells) / 2, 2))
                     for p in PLAYERS},
        ))
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', type=Path, default=ROOT.parent / 'card_playing_gym')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'site/RL-environment/hjarter/model/manifest.json').read_text())
    runs = args.source / 'runs/hjarter'
    previous = json.loads(OUT.read_text().split(PREFIX, 1)[1].rstrip().rstrip(';')) if OUT.exists() else {}

    def metrics(run, until):
        with open(runs / run / 'metrics.csv') as handle:
            return [row for row in csv.DictReader(handle) if int(row['iteration']) <= until]

    def totals(rows):
        deals = sum(float(r['games']) * float(r.get('deals_per_game') or 1) for r in rows)
        return dict(hours=round(sum(float(r['iteration_sec']) for r in rows) / 3600, 2),
                    games=int(sum(float(r['games']) for r in rows)), deals=int(deals),
                    decisions=int(sum(float(r['decisions']) for r in rows)), updates=len(rows))

    def deal_stage(run, until):
        if not (runs / run / 'metrics.csv').exists():
            print(f'{run}: no metrics.csv here, keeping the deal stage of {OUT.name}')
            return previous['deal']
        return dict(run=run, until=until, totals=totals(metrics(run, until)), roundRobin=round_robin(runs / run / 'evals'))

    run, live = manifest['run'], manifest['iteration']
    if manifest['training']['mode'] != 'game':
        data = dict(source=dict(run=run, liveCheckpoint=live), deal=deal_stage(run, live))
    elif not (runs / run / 'metrics.csv').exists():
        print(f'{run}: no metrics.csv here, keeping {OUT.name}')
        data = previous
    else:
        # g1's parent is a for-games release; its info.json names the release, then the run, it came from.
        release = Path(json.loads((runs / run / 'metadata.json').read_text())['parent'])
        info = json.loads((release / 'info.json').read_text())['source']
        while 'run' not in info:
            info = json.loads((Path(info['source']) / 'info.json').read_text())['source']
        base, base_iteration = info['run'], int(re.search(r'\d+', info['checkpoint'])[0])
        data = dict(
            source=dict(run=run, liveCheckpoint=live, base=base, baseCheckpoint=base_iteration, opponent=release.name),
            deal=deal_stage(base, base_iteration),
            game=dict(run=run, until=live, totals=totals(metrics(run, live)),
                      evals=game_evals(runs / run / 'evals', release.name, live)),
        )
    data['parameters'] = PARAMETERS
    OUT.write_text('// Generated by scripts/export-hjarter-training-data.py; do not edit by hand.\n'
                   + PREFIX + json.dumps(data, separators=(',', ':'), ensure_ascii=False) + ';\n')
    stages = ', '.join(f'{name} {stage["totals"]["updates"]} updates' for name in ('deal', 'game') if (stage := data.get(name)))
    evals = len(data.get('game', {}).get('evals', [])) - 1
    print(f'{OUT.relative_to(ROOT)}: {stages}; {len(data["deal"]["roundRobin"]["checkpoints"])} round-robin checkpoints, '
          f'{max(evals, 0)} game evals')


if __name__ == '__main__':
    main()
