#!/usr/bin/env python3
"""Export the trained perfect-information Plump critic for browser inference.

The checkpoint is read-only. Only the oracle critic trunk, per-player value
head, and final-trick head are retained in the quantized ONNX output.
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
from onnxruntime.quantization import QuantType, quantize_dynamic
from onnxruntime.transformers.float16 import convert_float_to_float16
from onnxruntime.transformers.onnx_model import OnnxModel
from torch import nn


class BrowserPlumpOracle(nn.Module):
    """ONNX-friendly oracle critic readout at the current sequence position."""

    def __init__(self, critic: nn.Module) -> None:
        super().__init__()
        self.critic = critic

    def forward(self, tokens: torch.Tensor):
        critic = self.critic
        model = critic.backbone
        config = critic.config

        base = tokens[..., :12]
        hidden = model.slot_embedding(base + model.slot_offsets).sum(dim=-2)
        positions = torch.arange(tokens.shape[1], device=tokens.device)
        hidden = hidden + model.pos_embedding(positions)

        # Match the grouped-query causal attention used in training while
        # expanding KV heads for ONNX runtimes that do not export GQA SDPA.
        for block in model.blocks:
            batch, length, _ = hidden.shape
            fused = block.qkv_proj(block.ln_attn(hidden))
            q, k, v = fused.split(
                [
                    block.n_heads * block.head_dim,
                    block.kv_heads * block.head_dim,
                    block.kv_heads * block.head_dim,
                ],
                dim=-1,
            )
            q = q.view(batch, length, block.n_heads, block.head_dim).transpose(1, 2)
            k = k.view(batch, length, block.kv_heads, block.head_dim).transpose(1, 2)
            v = v.view(batch, length, block.kv_heads, block.head_dim).transpose(1, 2)
            k = k.repeat_interleave(block.head_group, dim=1)
            v = v.repeat_interleave(block.head_group, dim=1)
            scores = (q @ k.transpose(-1, -2)) * block.scale
            row = torch.arange(length, device=tokens.device)[:, None]
            col = torch.arange(length, device=tokens.device)[None, :]
            scores = scores.masked_fill(col > row, -1.0e9)
            attention = scores.softmax(dim=-1) @ v
            merged = attention.transpose(1, 2).reshape(batch, length, -1)
            hidden = hidden + block.out_proj(merged)
            hidden = hidden + block.mlp(block.ln_mlp(hidden))

        hidden = model.final_norm(hidden)[:, -1]
        values = critic.player_value_head(hidden)
        trick_logits = model.trick_count_head(hidden).view(
            tokens.shape[0], config.max_players, config.bid_count
        )
        return values, trick_logits


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

    sys.path.insert(0, str(args.plump_source.resolve()))
    from plump.seq.config import SeqModelConfig
    from plump.seq.model import SeqPPOOracleCritic

    payload = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    if payload.get("training_config", {}).get("ppo_critic_mode") != "oracle":
        raise ValueError("Checkpoint does not contain an oracle PPO critic.")
    config = SeqModelConfig(**payload["model_config"])
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
    sample = torch.zeros((1, config.oracle_max_seq_len, 22), dtype=torch.int64)
    sample[..., 0] = 1
    sample[..., 1] = config.player_na_id
    sample[..., 2] = config.rank_na_id
    sample[..., 3] = config.suit_na_id
    sample[..., 4] = config.card_na_id
    sample[..., 5] = config.bid_na_id
    sample[..., 6] = config.trick_na_id
    sample[..., 7] = config.pos_na_id
    sample[..., 8] = config.max_hand_size
    sample[..., 9] = config.max_players
    sample[..., 10] = config.player_na_id
    sample[..., 12:] = config.card_na_id

    with torch.inference_mode():
        torch.onnx.export(
            wrapper,
            (sample,),
            fp32_output,
            input_names=["tokens"],
            output_names=["values", "trick_logits"],
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
