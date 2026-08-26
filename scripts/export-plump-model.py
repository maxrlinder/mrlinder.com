#!/usr/bin/env python3
"""Export a Plump training checkpoint as a small browser inference model.

The training checkpoint contains optimizer, critic, league, and RNG state. This
script keeps only the actor forward pass and writes a dynamic-length ONNX model
plus a tiny manifest consumed by the website.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import onnx
import torch
import torch.nn.functional as F
from torch import nn
from onnxruntime.quantization import QuantType, quantize_dynamic
from onnxruntime.transformers.float16 import convert_float_to_float16
from onnxruntime.transformers.onnx_model import OnnxModel

ACTOR_OUTPUT_NAMES = (
    "bid_logits",
    "card_logits",
    "value",
    "trick_logits",
    "suit_logits",
    "rank_boundary_logits",
    "next_winner_logits",
    "player_values",
)


class BrowserPlumpModel(nn.Module):
    """ONNX-friendly wrapper returning only the final sequence position.

    The trunk is the training model's own ``forward_hidden``; only the handful
    of operations ONNX cannot lower are swapped out, by ``onnx_export_patches``.
    Transcribing the architecture here instead is how the previous version of
    this script came to silently predate the bid-pressure fields, per-layer
    embeddings, and attention value embeddings.
    """

    def __init__(self, model: nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, tokens: torch.Tensor):
        model = self.model
        config = model.config

        hidden = model.forward_hidden(tokens)[:, -1]
        bid_logits = model.bid_head(hidden)
        card_logits = F.linear(
            hidden,
            model.effective_card_output_weight(),
            model.card_head.bias,
        )
        value = model.value_head(hidden).squeeze(-1)
        trick_logits = model.trick_count_head(hidden).view(
            tokens.shape[0], config.max_players, config.bid_count
        )
        suit_logits = model.suit_presence_head(hidden).view(
            tokens.shape[0], config.belief_opponents, 4
        )
        rank_boundary_logits = model.rank_boundary_head(hidden).view(
            tokens.shape[0], config.belief_opponents + 1, 4, 2
        )
        next_winner_logits = model.next_winner_head(hidden)
        player_values = model.player_value_head(hidden)
        return (
            bid_logits,
            card_logits,
            value,
            trick_logits,
            suit_logits,
            rank_boundary_logits,
            next_winner_logits,
            player_values,
        )


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
    from plump.seq.model import SeqPlumpModel, load_seq_model_state_dict

    payload = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    config = SeqModelConfig(**payload["model_config"])
    assert_exportable(config)
    model = SeqPlumpModel(config)
    load_seq_model_state_dict(model, payload["model_state_dict"])
    model.eval()
    wrapper = BrowserPlumpModel(model).eval()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fp32_output = (
        args.output
        if args.precision == "fp32"
        else args.output.with_name(f"{args.output.stem}.source-fp32.onnx")
    )
    # A legal token row at the maximum production sequence length: legal so no
    # embedding lookup runs out of range, maximum so the traced position table
    # covers every shape the browser can ask for.
    sample = sample_tokens(config, config.max_seq_len)

    with torch.inference_mode(), onnx_export_patches():
        torch.onnx.export(
            wrapper,
            (sample,),
            fp32_output,
            input_names=["tokens"],
            output_names=list(ACTOR_OUTPUT_NAMES),
            dynamic_axes={"tokens": {0: "batch", 1: "sequence"}},
            opset_version=18,
            dynamo=False,
        )

    if args.precision == "int8":
        # Dynamic int8 weight quantization keeps the complete actor architecture
        # and every browser-consumed auxiliary head while reducing the payload.
        quantize_dynamic(
            fp32_output,
            args.output,
            weight_type=QuantType.QInt8,
            op_types_to_quantize=["MatMul", "Gemm"],
        )
        fp32_output.unlink()
    elif args.precision == "fp16":
        # Keep normalization and probability normalization in FP32. The model
        # inputs and public outputs retain their original types as well.
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
        "checkpoint": args.checkpoint.name,
        "iteration": int(payload["iteration"]),
        "schemaVersion": int(payload["schema_version"]),
        "modelFormatVersion": int(payload["model_format_version"]),
        "precision": args.precision,
        "quantization": "dynamic-int8" if args.precision == "int8" else "none",
        "outputs": list(ACTOR_OUTPUT_NAMES),
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
