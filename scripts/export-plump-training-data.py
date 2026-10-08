#!/usr/bin/env python3
"""Export the training curves shown under "How the agent was trained".

Reads the distillation run, the RL6 PPO run, the RL6 lineage round robin and
the compute totals of the whole lineage
from a plump-bot checkout, and writes a small ES module of smoothed series.
Standard library only, so it runs without the training environment.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PLUMP_BOT = ROOT.parent / "plump-bot"
OUTPUT = ROOT / "RL-environment" / "plump" / "training-data.js"


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def smoothed(
    rows: list[dict[str, str]],
    column: str,
    *,
    window: int,
    stride: int,
    start: int | None = None,
    end: int | None = None,
) -> list[list[float]]:
    """Centered moving average, sampled every ``stride`` iterations.

    Rows with an empty value are skipped rather than read as zero. Near the
    edges the window shrinks to what exists, so the first and last points are
    still averages of real updates.
    """
    points = [
        (int(row["iteration"]), float(row[column]))
        for row in rows
        if row.get(column) not in (None, "")
        and (start is None or int(row["iteration"]) > start)
        and (end is None or int(row["iteration"]) <= end)
    ]
    series: list[list[float]] = []
    half = window // 2
    for index in range(0, len(points), stride):
        lo, hi = max(0, index - half), min(len(points), index + half + 1)
        values = [value for _, value in points[lo:hi]]
        series.append([points[index][0], round(sum(values) / len(values), 4)])
    if series[-1][0] != points[-1][0]:
        lo = max(0, len(points) - 1 - half)
        values = [value for _, value in points[lo:]]
        series.append([points[-1][0], round(sum(values) / len(values), 4)])
    return series


# The deployed deeper model's whole ancestry, as (run, first, last iteration).
# Each fork resumes its parent's iteration count, so the spans do not overlap.
LINEAGE = (
    ("ppo-oracle-mps-768-v2", 0, 35900),
    ("ppo-oracle-mps-768-v3", 35900, 38700),
    ("ppo-oracle-mps-768-v4", 38700, 47600),
    ("ppo-oracle-mps-768-v4-5", 47600, 100500),
    ("distill-v5", 0, 5600),
    ("rl-v6", 5600, None),
)


def lineage_totals(runs: Path) -> dict[str, float]:
    """Wall-clock days and decisions trained across the deployed lineage."""
    seconds = 0.0
    decisions = 0
    for run, first, last in LINEAGE:
        for row in read_rows(runs / run / "metrics.csv"):
            iteration = int(row["iteration"])
            if iteration <= first or (last is not None and iteration > last):
                continue
            seconds += float(row["total_sec"] or 0)
            decisions += int(float(row.get("decisions") or 0))
    return {"days": round(seconds / 86400, 1), "decisions": decisions}


def round_robin(path: Path) -> list[dict[str, float]]:
    return [
        {
            "iteration": int(row["iteration"]),
            "run": row["run"],
            "reward": round(float(row["relative_reward"]), 4),
            "low": round(float(row["relative_reward_ci_low"]), 4),
            "high": round(float(row["relative_reward_ci_high"]), 4),
            "rounds": int(row["rounds"]),
        }
        for row in read_rows(path)
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plump-bot", type=Path, default=DEFAULT_PLUMP_BOT)
    parser.add_argument(
        "--tournament",
        default="rr-5600-to-47300-stride1000.csv",
        help="Round-robin CSV under runs/rl-v6/tournaments/.",
    )
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()

    runs = args.plump_bot / "runs"
    distill = read_rows(runs / "distill-v5" / "metrics.csv")
    rl6 = read_rows(runs / "rl-v6" / "metrics.csv")
    # RL6 forked from the distilled student at update 5600; its metrics file
    # starts there too, but be explicit so a re-fork cannot leak old rows.
    rl6_start = 5600

    data = {
        "source": {
            "distillRun": "distill-v5",
            "rlRun": "rl-v6",
            "tournament": args.tournament,
        },
        "distillKl": smoothed(
            distill, "distill_kl", window=60, stride=25, end=rl6_start
        ),
        "oracleValueRmse": smoothed(
            rl6, "critic_all_player_rmse", window=200, stride=100, start=rl6_start
        ),
        "actorValueRmse": smoothed(
            rl6, "actor_all_player_rmse", window=200, stride=100, start=rl6_start
        ),
        "suitLoss": smoothed(rl6, "loss_suit", window=400, stride=100, start=rl6_start),
        "rankBoundaryLoss": smoothed(
            rl6, "loss_rank_boundary", window=400, stride=100, start=rl6_start
        ),
        "roundRobin": round_robin(runs / "rl-v6" / "tournaments" / args.tournament),
        "totals": lineage_totals(runs),
    }
    ci_missing = [
        row["iteration"]
        for row in data["roundRobin"]
        if not row["low"] < row["reward"] < row["high"]
    ]
    if ci_missing:
        # A tournament still in progress writes placeholder intervals.
        raise SystemExit(
            f"{args.tournament} has no bootstrap interval for {len(ci_missing)} "
            "checkpoints; wait for the tournament to finish."
        )

    body = json.dumps(data, separators=(",", ":"))
    args.output.write_text(
        "// Generated by scripts/export-plump-training-data.py; do not edit by hand.\n"
        f"export const PLUMP_TRAINING_DATA = {body};\n"
    )
    print(f"wrote {args.output} ({args.output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
