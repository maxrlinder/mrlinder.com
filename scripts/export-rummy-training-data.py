"""Write site/RL-environment/rummy/training-data.js for the Rummy training charts.

Reads the sibling card_playing_gym checkout read-only: run r7's metrics, its
checkpoint round robin (tools/tournament.py --output JSON) and an argmax
tournament of late checkpoints. Ratings are refitted without the untrained
update 0, by weighted least squares on the pair means with the ratings summing
to zero, so each point is points per game above the field average.
Training totals run up to the checkpoint in model/manifest.json.

Usage: python scripts/export-rummy-training-data.py
Requires numpy.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RUN = ROOT.parent / "card_playing_gym" / "runs" / "rummy" / "r7"
OUTPUT = ROOT / "site" / "RL-environment" / "rummy" / "training-data.js"
MANIFEST = ROOT / "site" / "RL-environment" / "rummy" / "model" / "manifest.json"
Z95 = 1.959964


def centered_ratings(pairs: list[dict], labels: list[str]) -> tuple[np.ndarray, np.ndarray]:
    """Ratings with zero mean from independent pair means (A - B) and their errors."""

    index = {label: i for i, label in enumerate(labels)}
    rows, target, weight = [], [], []
    for pair in pairs:
        if pair["a"] not in index or pair["b"] not in index:
            continue
        row = np.zeros(len(labels))
        row[index[pair["a"]]], row[index[pair["b"]]] = 1.0, -1.0
        rows.append(row)
        target.append(pair["mean"])
        weight.append(1.0 / pair["se"] ** 2)
    # r = C z keeps sum(r) = 0 with free parameters z.
    basis = np.vstack([np.eye(len(labels) - 1), -np.ones(len(labels) - 1)])
    design = np.array(rows) @ basis
    weights = np.array(weight)
    covariance = np.linalg.inv(design.T @ (design * weights[:, None]))
    ratings = basis @ covariance @ design.T @ (weights * np.array(target))
    errors = np.sqrt(np.diag(basis @ covariance @ basis.T))
    return ratings, errors


def ladder(path: Path, labels: list[str]) -> tuple[list[dict], dict]:
    data = json.loads(path.read_text())
    ratings, errors = centered_ratings(data["pairs"], labels)
    games = data["games"] / len(data["pairs"]) * (len(labels) - 1)
    points = [
        {
            "iteration": int(label.split("@")[0]),
            "rating": round(float(rating), 3),
            "low": round(float(rating - Z95 * error), 3),
            "high": round(float(rating + Z95 * error), 3),
        }
        for label, rating, error in zip(labels, ratings, errors)
    ]
    return points, {"file": path.name, "games": int(round(games)), "rounds": data["rounds"]}


def read_metrics(path: Path) -> dict[int, dict[str, str]]:
    rows: dict[int, dict[str, str]] = {}
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            rows[int(row["iteration"])] = row  # a resumed run rewrites later rows
    return rows


def smoothed(rows: dict[int, dict[str, str]], column: str, *, start: int, end: int, window: int, stride: int) -> list:
    points = []
    for at in range(start + stride, end + 1, stride):
        values = [
            float(rows[i][column])
            for i in range(max(start + 1, at - window + 1), at + 1)
            if i in rows and rows[i].get(column) not in (None, "", "nan")
        ]
        if values:
            points.append([at, round(sum(values) / len(values), 4)])
    return points


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", type=Path, default=DEFAULT_RUN)
    parser.add_argument("--tournament", default="tournament_028200.json")
    parser.add_argument("--argmax", default="argmax_late_028200.json")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()

    tournament = json.loads((args.run / args.tournament).read_text())
    field = [label for label in tournament["labels"] if label != "0"]
    round_robin, round_robin_source = ladder(args.run / args.tournament, field)
    untrained = next(p for p in tournament["pairs"] if p["a"] == "0" and p["b"] == field[0])

    argmax_labels = [label for label in json.loads((args.run / args.argmax).read_text())["labels"] if label.endswith("@T0")]
    argmax, argmax_source = ladder(args.run / args.argmax, argmax_labels)

    live = json.loads(MANIFEST.read_text())["iteration"]
    metrics = read_metrics(args.run / "metrics.csv")
    upto = [i for i in metrics if i <= live]
    hold_start = 16100  # the hold-or-play gate starts here

    data = {
        "source": {
            "run": args.run.name,
            "tournament": round_robin_source,
            "argmax": argmax_source,
            "untrainedGap": {"iteration": int(field[0]), "points": round(-untrained["mean"], 1)},
        },
        "roundRobin": round_robin,
        "argmax": argmax,
        "holdRate": smoothed(metrics, "hold_rate", start=hold_start, end=live, window=200, stride=100),
        "holdRateEndgame": smoothed(metrics, "hold_rate_endgame", start=hold_start, end=live, window=200, stride=100),
        "totals": {
            "liveCheckpoint": live,
            "hours": round(sum(float(metrics[i]["iteration_sec"]) for i in upto) / 3600, 1),
            "games": int(sum(float(metrics[i]["games"]) for i in upto)),
            "decisions": int(sum(float(metrics[i]["decisions"]) for i in upto)),
        },
    }
    for row in data["roundRobin"] + data["argmax"]:
        if not row["low"] < row["rating"] < row["high"]:
            raise AssertionError(f"Interval does not contain its rating: {row}")
    args.output.write_text(
        "// Generated by scripts/export-rummy-training-data.py; do not edit by hand.\n"
        f"export const RUMMY_TRAINING_DATA = {json.dumps(data, separators=(',', ':'))};\n"
    )
    print(f"Wrote {args.output.relative_to(ROOT)}: {len(round_robin)} round-robin points, live checkpoint {live}.")


if __name__ == "__main__":
    main()
