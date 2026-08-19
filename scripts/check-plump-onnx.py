#!/usr/bin/env python3
"""Check the deployed ONNX artifacts against the PyTorch checkpoint.

``check-plump-tokens.mjs`` proves the browser builds the right token stream.
This proves the browser's *model* answers that stream the way training does --
covering the export shim, which no JavaScript test can reach.

Both are needed: a correct stream through a broken graph and a broken stream
through a correct graph fail in the same silent way, with an agent that simply
plays worse.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

# fp32 export is a faithful reproduction; the remaining gap is float
# associativity. fp16 keeps only normalization and softmax in fp32, so its
# logits move by a few thousandths -- fine as long as no decision flips.
TOLERANCE = {"fp32": 2e-3, "fp16": 5e-2}


def live_manifests(model_config_js: Path) -> dict[str, str]:
    """Read the manifest filenames the site actually serves.

    Parsed out of model-config.js rather than passed in, so this checks what is
    deployed instead of whatever was most recently exported.
    """

    source = model_config_js.read_text(encoding="utf-8")
    found = dict(
        re.findall(r'(fp32|fp16|oracleManifest):\s*"([^"]+\.json)"', source)
    )
    missing = {"fp32", "fp16", "oracleManifest"} - set(found)
    if missing:
        raise SystemExit(f"Could not read {sorted(missing)} from {model_config_js}")
    return found


def run_session(path: Path, tokens: np.ndarray) -> dict[str, np.ndarray]:
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    outputs = session.run(None, {"tokens": tokens})
    return {
        output.name: value
        for output, value in zip(session.get_outputs(), outputs)
    }


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument(
        "--plump-source", type=Path, default=root.parent / "plump-bot"
    )
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=root / "scripts" / "fixtures" / "plump-tokens.json",
    )
    parser.add_argument(
        "--cases",
        type=int,
        default=12,
        help="How many fixture cases to check (they are sampled evenly).",
    )
    args = parser.parse_args()

    sys.path.insert(0, str(args.plump_source.resolve()))
    from plump.seq.config import SeqModelConfig
    from plump.seq.model import (
        SeqPPOOracleCritic,
        SeqPlumpModel,
        load_seq_model_state_dict,
    )

    model_dir = root / "RL-environment" / "plump" / "model"
    manifests = live_manifests(root / "RL-environment" / "plump" / "model-config.js")

    payload = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    config = SeqModelConfig(**payload["model_config"])
    model = SeqPlumpModel(config)
    load_seq_model_state_dict(model, payload["model_state_dict"])
    model.eval()
    critic = SeqPPOOracleCritic(config)
    critic.load_state_dict(payload["critic_state_dict"])
    critic.eval()

    graphs = {}
    for key, manifest_name in manifests.items():
        manifest = json.loads((model_dir / manifest_name).read_text())
        if manifest["modelConfig"] != payload["model_config"]:
            raise SystemExit(
                f"{manifest_name} was exported from a different architecture "
                "than the checkpoint under test."
            )
        if manifest["iteration"] != int(payload["iteration"]):
            raise SystemExit(
                f"{manifest_name} is iteration {manifest['iteration']}, but the "
                f"checkpoint is {int(payload['iteration'])}."
            )
        graphs[key] = model_dir / manifest["file"]

    fixtures = json.loads(args.fixtures.read_text())
    cases = fixtures["cases"]
    stride = max(1, len(cases) // args.cases)
    cases = cases[::stride]

    worst: dict[str, float] = {}
    with torch.inference_mode():
        for case in cases:
            actor_rows = np.asarray(case["expected"]["0"], dtype=np.int64)[None]
            oracle_rows = np.asarray(case["expectedOracle"], dtype=np.int64)[None]

            reference = model.forward_full(torch.from_numpy(actor_rows))
            ref_bid = reference.bid_logits[:, -1].numpy()
            ref_card = reference.card_logits[:, -1].numpy()
            ref_values, _ = critic.forward_value_and_trick(
                torch.from_numpy(oracle_rows)
            )
            ref_values = ref_values[:, -1].numpy()

            for key in ("fp32", "fp16"):
                out = run_session(graphs[key], actor_rows)
                tolerance = TOLERANCE[key]
                for name, expected, actual in (
                    ("bid", ref_bid, out["bid_logits"]),
                    ("card", ref_card, out["card_logits"]),
                ):
                    gap = float(np.abs(expected - actual).max())
                    worst[f"actor-{key}-{name}"] = max(
                        worst.get(f"actor-{key}-{name}", 0.0), gap
                    )
                    if gap > tolerance:
                        raise SystemExit(
                            f"{case['name']}: actor {key} {name} logits differ "
                            f"by {gap:.3e} (limit {tolerance:.0e})"
                        )
                    if expected.argmax(-1) != actual.argmax(-1):
                        raise SystemExit(
                            f"{case['name']}: actor {key} {name} argmax differs "
                            f"-- the browser would pick a different action."
                        )

            out = run_session(graphs["oracleManifest"], oracle_rows)
            gap = float(np.abs(ref_values - out["values"]).max())
            worst["oracle-values"] = max(worst.get("oracle-values", 0.0), gap)
            if gap > TOLERANCE["fp32"]:
                raise SystemExit(
                    f"{case['name']}: oracle values differ by {gap:.3e}"
                )

    print(f"Checked {len(cases)} fixture states against {args.checkpoint.name}:")
    for name, gap in sorted(worst.items()):
        print(f"  {name:<22} max|diff| = {gap:.3e}")
    print("ONNX artifacts match the checkpoint.")


if __name__ == "__main__":
    main()
