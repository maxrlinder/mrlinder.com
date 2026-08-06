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

import torch
import torch.nn.functional as F
from torch import nn
from onnxruntime.quantization import QuantType, quantize_dynamic


class BrowserPlumpModel(nn.Module):
    """ONNX-friendly wrapper returning only the final sequence position."""

    def __init__(self, model: nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, tokens: torch.Tensor):
        model = self.model
        config = model.config

        # Equivalent to SeqPlumpModel.embed, expressed without boolean row
        # indexing so both normal event rows and TRICK_WIN remaining-hand rows
        # remain dynamic in ONNX.
        base = tokens[..., :12]
        hidden = model.slot_embedding(base + model.slot_offsets).sum(dim=-2)
        remaining = tokens[..., 12:]
        valid = remaining < 52
        safe = remaining.clamp_max(51)
        remaining_vectors = F.embedding(safe, model.effective_card_input_weight())
        remaining_sum = (
            remaining_vectors * valid.unsqueeze(-1).to(remaining_vectors.dtype)
        ).sum(dim=-2)
        is_trick_win = (base[..., 0] == 5).unsqueeze(-1).to(hidden.dtype)
        hidden = hidden + remaining_sum * is_trick_win
        positions = torch.arange(tokens.shape[1], device=tokens.device)
        hidden = hidden + model.pos_embedding(positions)

        # The training model uses PyTorch's grouped-query SDPA kernel. ONNX's
        # SDPA exporter does not accept GQA yet, so expand the two KV heads to
        # twelve here and spell out the same causal attention operation.
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
        bid_hit_logits = model.bid_hit_head(hidden)
        return (
            bid_logits,
            card_logits,
            value,
            trick_logits,
            suit_logits,
            bid_hit_logits,
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
        "--plump-source",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "plump-bot",
    )
    args = parser.parse_args()

    sys.path.insert(0, str(args.plump_source.resolve()))
    from plump.seq.config import SeqModelConfig
    from plump.seq.model import SeqPlumpModel, load_seq_model_state_dict

    payload = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    config = SeqModelConfig(**payload["model_config"])
    model = SeqPlumpModel(config)
    load_seq_model_state_dict(model, payload["model_state_dict"])
    model.eval()
    wrapper = BrowserPlumpModel(model).eval()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fp32_output = args.output.with_name(f"{args.output.stem}.fp32.onnx")
    sample = torch.zeros((1, config.max_seq_len, 22), dtype=torch.int64)
    # A valid all-NA-ish stream avoids out-of-range embedding lookups while
    # giving the exporter the maximum sequence shape used in production.
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
            output_names=[
                "bid_logits",
                "card_logits",
                "value",
                "trick_logits",
                "suit_logits",
                "bid_hit_logits",
            ],
            dynamic_axes={"tokens": {0: "batch", 1: "sequence"}},
            opset_version=18,
            dynamo=False,
        )

    # Dynamic int8 weight quantization keeps the complete actor architecture
    # and every auxiliary head while reducing the browser payload by ~73%.
    # The original training checkpoint is never modified.
    quantize_dynamic(
        fp32_output,
        args.output,
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul", "Gemm"],
    )
    fp32_output.unlink()

    manifest = {
        "format": "onnx",
        "checkpoint": args.checkpoint.name,
        "iteration": int(payload["iteration"]),
        "schemaVersion": int(payload["schema_version"]),
        "modelFormatVersion": int(payload["model_format_version"]),
        "quantization": "dynamic-int8",
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
