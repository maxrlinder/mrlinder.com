#!/usr/bin/env python3
"""Write site/RL-environment/piquet/training-data.js for the "How the agent was trained" charts.

The live agent (model/manifest.json) trained in two stages: single deals,
then whole Rubicon parties fine-tuned from a single-deal checkpoint (the
run's metadata.json names it). Each stage reads its run's metrics.csv up to
the checkpoint the next stage (or the page) took. The deal stage also reads
the JSON reports of `cardgym piquet evaluate --output` in --evals (duplicate
deals against the rule-based heuristic); the partie stage the checkpoint
round robin of the gym's `tools/piquet_tournament.py --output` (--tournament)
for the "How it was played" window. A stage whose run is not on this
machine, or a round robin not given, keeps its section of the current
training-data.js. Numpy-free.

Usage: python scripts/export-piquet-training-data.py [--evals path/to/reports] [--tournament rr.json]
"""
import argparse
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'site/RL-environment/piquet/training-data.js'
PREFIX = 'export const PIQUET_TRAINING_DATA = '


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT.parent / 'card_playing_gym')
    parser.add_argument('--evals', type=Path, help='directory of evaluate --output reports')
    parser.add_argument('--tournament', type=Path, help='tools/piquet_tournament.py --output report')
    parser.add_argument('--bucket', type=int, default=100, help='updates per point of the self-play curves')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'site/RL-environment/piquet/model/manifest.json').read_text())
    runs = args.source / 'runs/piquet'
    reports = [json.loads(path.read_text()) for path in sorted(args.evals.glob('*.json'))] if args.evals else []
    previous = json.loads(OUT.read_text().split(PREFIX, 1)[1].rstrip().rstrip(';')) if OUT.exists() else {}

    def metrics(run, until):
        with open(runs / run / 'metrics.csv') as handle:
            return [row for row in csv.DictReader(handle) if int(row['iteration']) <= until]

    def curve(rows, key):
        points, bucket = [], []
        for row in rows:
            bucket.append(float(row[key]))
            if int(row['iteration']) % args.bucket == 0:
                points.append([int(row['iteration']), round(sum(bucket) / len(bucket), 4)])
                bucket = []
        return points

    def totals(rows):
        return dict(hours=round(sum(float(r['iteration_sec']) for r in rows) / 3600, 2),
                    games=int(sum(float(r['games']) for r in rows)),
                    decisions=int(sum(float(r['decisions']) for r in rows)), updates=len(rows))

    def batches(rows):
        """[first update, parties per update] wherever the batch size changes."""
        points = []
        for row in rows:
            games = int(float(row['games']))
            if not points or points[-1][1] != games:
                points.append([int(row['iteration']), games])
        return points

    def round_robin(path):
        """Ratings, records against the field and the pair matrix of the checkpoint round robin."""
        report = json.loads(path.read_text())
        labels = report['labels']
        index = {label: i for i, label in enumerate(labels)}
        payoff = [[None] * len(labels) for _ in labels]
        stderr = [[None] * len(labels) for _ in labels]
        for pair in report['pairs']:
            a, b = index[pair['a']], index[pair['b']]
            payoff[a][b], payoff[b][a] = round(pair['payoff'], 2), round(-pair['payoff'], 2)
            stderr[a][b] = stderr[b][a] = round(pair['payoff_se'], 2)
        checkpoints = [dict(iteration=int(label), rating=round(rating, 3), stderr=round(se, 3),
                            wins=round(field['wins'], 4), margin=round(field['margin'], 2),
                            rubicons=round(field['rubicons'], 4), rubiconed=round(field['rubiconed'], 4))
                       for label, rating, se, field in zip(labels, report['ratings'], report['rating_se'], report['field'])]
        return dict(file=path.name, parties=report['parties'], perPair=2 * report['duplicates_per_pair'],
                    checkpoints=checkpoints, payoff=payoff, stderr=stderr)

    def deal_stage(run, until):
        if not (runs / run / 'metrics.csv').exists():
            print(f'{run}: no metrics.csv here, keeping the deal stage of {OUT.name}')
            return previous['deal']
        rows = metrics(run, until)
        heuristic = [dict(iteration=r['iteration'], margin=round(r['model_return'], 3), stderr=round(r['stderr'], 3),
                          elder=round(r['elder_margin'], 3), younger=round(r['younger_margin'], 3),
                          wins=round(r['win_rate'], 4), deals=r['games'])
                     for r in sorted(reports, key=lambda r: r['iteration'])
                     if r['opponent'] == 'heuristic' and r.get('mode', 'deal') == 'deal']
        return dict(run=run, until=until, totals=totals(rows), heuristic=heuristic,
                    elderMargin=curve(rows, 'elder_margin'), pointsPerDeal=curve(rows, 'points_per_deal'),
                    pique=curve(rows, 'pique_rate'), repique=curve(rows, 'repique_rate'), capot=curve(rows, 'capot_rate'))

    run, live = manifest['run'], manifest['iteration']
    if manifest.get('valueTarget') != 'partie':
        data = dict(source=dict(run=run, liveCheckpoint=live, bucket=args.bucket), deal=deal_stage(run, live))
    else:
        metadata = json.loads((runs / run / 'metadata.json').read_text())
        base, base_iteration = Path(metadata['parent']).parent.parent.name, metadata['parent_iteration']
        rows = metrics(run, live)
        tournament = round_robin(args.tournament) if args.tournament else previous.get('partie', {}).get('roundRobin')
        data = dict(
            source=dict(run=run, liveCheckpoint=live, bucket=args.bucket, base=base, baseCheckpoint=base_iteration),
            deal=deal_stage(base, base_iteration),
            partie=dict(totals=totals(rows), batches=batches(rows), payoff=curve(rows, 'partie_payoff'),
                        rubicon=curve(rows, 'rubicon_rate'), roundRobin=tournament),
        )
    data['parameters'] = 9_078_030
    OUT.write_text('// Generated by scripts/export-piquet-training-data.py; do not edit by hand.\n'
                   + PREFIX + json.dumps(data, separators=(',', ':')) + ';\n')
    stages = ', '.join(f'{name} {stage["totals"]["updates"]} updates' for name in ('deal', 'partie') if (stage := data.get(name)))
    print(f'{OUT.relative_to(ROOT)}: {stages}')


if __name__ == '__main__':
    main()
