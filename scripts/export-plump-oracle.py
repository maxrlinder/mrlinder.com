#!/usr/bin/env python3
"""Export the trained perfect-information Plump critic for browser inference.

The checkpoint is read-only. The oracle critic trunk and all trained oracle
readouts are retained in the ONNX output: per-player value, final-trick count,
remaining-card order, and next-trick winner.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import onnx
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from onnxruntime.transformers.float16 import convert_float_to_float16
from onnxruntime.transformers.onnx_model import OnnxModel
from torch import nn

ORACLE_OUTPUT_NAMES = (
    "values",
    "trick_logits",
    "card_order_logits",
    "next_winner_logits",
)


class BrowserPlumpOracle(nn.Module):
    """ONNX-friendly oracle critic readout at the current sequence position.

    As with the actor exporter, the trunk is the training model's own
    ``forward_hidden`` under ``onnx_export_patches`` rather than a second,
    drift-prone transcription of it.
    """

    def __init__(self, critic: nn.Module) -> None:
        super().__init__()
        self.critic = critic

    def forward(self, tokens: torch.Tensor):
        critic = self.critic
        model = critic.backbone
        config = critic.config

        hidden = model.forward_hidden(tokens)[:, -1]
        values = critic.player_value_head(hidden)
        trick_logits = model.trick_count_head(hidden).view(
            tokens.shape[0], config.max_players, config.bid_count
        )
        card_order_logits = critic.card_order_head(hidden)
        next_winner_logits = model.next_winner_head(hidden)
        return values, trick_logits, card_order_logits, next_winner_logits


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--precision",
        choices=("fp32", "fp16", "int8"),
        default="int8",
        help="Weight precision for the browser artifact (default: int8).",
    )
    parser.add_argument(
        "--plump-source",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "plump-bot",
    )
    args = parser.parse_args()

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.path.insert(0, str(args.plump_source.resolve()))
    from plump_export_compat import (
        assert_exportable,
        onnx_export_patches,
        sample_tokens,
    )
    from plump.seq.config import SeqModelConfig
    from plump.seq.model import SeqPPOOracleCritic

    payload = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    if payload.get("training_config", {}).get("ppo_critic_mode") != "oracle":
        raise ValueError("Checkpoint does not contain an oracle PPO critic.")
    config = SeqModelConfig(**payload["model_config"])
    assert_exportable(config)
    critic = SeqPPOOracleCritic(config)
    critic.load_state_dict(payload["critic_state_dict"])
    critic.eval()
    wrapper = BrowserPlumpOracle(critic).eval()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fp32_output = (
        args.output
        if args.precision == "fp32"
        else args.output.with_name(f"{args.output.stem}.source-fp32.onnx")
    )
    # The critic's prefix holds every player's cards, so its position table --
    # and therefore its trace length -- is longer than the actor's.
    sample = sample_tokens(config, config.oracle_max_seq_len)

    with torch.inference_mode(), onnx_export_patches():
        torch.onnx.export(
            wrapper,
            (sample,),
            fp32_output,
            input_names=["tokens"],
            output_names=list(ORACLE_OUTPUT_NAMES),
            dynamic_axes={"tokens": {0: "batch", 1: "sequence"}},
            opset_version=18,
            dynamo=False,
        )

    if args.precision == "int8":
        quantize_dynamic(
            fp32_output,
            args.output,
            weight_type=QuantType.QInt8,
            op_types_to_quantize=["MatMul", "Gemm"],
        )
        fp32_output.unlink()
    elif args.precision == "fp16":
        converted = convert_float_to_float16(
            onnx.load(fp32_output),
            keep_io_types=True,
            op_block_list=["LayerNormalization", "Softmax"],
        )
        converted_model = OnnxModel(converted)
        converted_model.topological_sort(is_deterministic=True)
        onnx.save(converted_model.model, args.output)
        fp32_output.unlink()

    manifest = {
        "format": "onnx",
        "kind": "perfect-information-oracle-critic",
        "checkpoint": args.checkpoint.name,
        "iteration": int(payload["iteration"]),
        "schemaVersion": int(payload["schema_version"]),
        "modelFormatVersion": int(payload["model_format_version"]),
        "precision": args.precision,
        "quantization": "dynamic-int8" if args.precision == "int8" else "none",
        "outputs": list(ORACLE_OUTPUT_NAMES),
        "modelConfig": payload["model_config"],
        "file": args.output.name,
        "bytes": args.output.stat().st_size,
        "sha256": sha256(args.output),
    }
    args.output.with_suffix(".json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
