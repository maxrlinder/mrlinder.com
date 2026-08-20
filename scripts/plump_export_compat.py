"""ONNX-export patches for the Plump sequence model.

The training model is written for PyTorch eager execution on MPS: it uses
``embedding_bag`` with per-sample weights, boolean row indexing to skip work on
non-TRICK_WIN rows, and SDPA's grouped-query path. None of the three survive an
ONNX export -- the first two produce data-dependent shapes, and the exporter has
no GQA attention op.

Earlier versions of the exporters solved this by transcribing the whole forward
pass by hand. That transcription then silently fell behind the model: it knows
nothing about the bid-pressure fields, the NA-pattern row, per-layer embeddings,
or attention value embeddings that schema-v6 format-6 checkpoints rely on.

So instead of a second copy of the architecture, this module patches exactly the
three offending operations and lets the real ``SeqPlumpModel`` code run. Anything
added to the trunk from here on is exported without touching this file.
"""

from __future__ import annotations

from contextlib import contextmanager

import torch
import torch.nn.functional as F


@contextmanager
def onnx_export_patches(plump_source_on_path: bool = True):
    """Make ``SeqPlumpModel.forward_hidden`` traceable by ``torch.onnx.export``.

    ``plump_source_on_path`` is a readability marker: the caller must already
    have inserted the plump-bot checkout on ``sys.path`` so these imports
    resolve to the same modules the checkpoint was trained with.
    """

    assert plump_source_on_path
    from plump.seq.config import (
        BASE_TOKEN_WIDTH,
        CORE_TOKEN_WIDTH,
        NUM_CARDS,
        NUM_RANKS,
        SLOT_CARD,
        SLOT_NA_PATTERN,
        SLOT_RANK,
        SLOT_REMAINING_HAND_START,
        SLOT_SUIT,
        SLOT_TYPE,
        TOKEN_TRICK_WIN,
    )
    from plump.seq.model import DecoderBlock, SeqPlumpModel

    def embedding_bag_sum(indices, weight, *, valid=None):
        """``F.embedding_bag`` equivalent with a statically known output shape.

        The eager version exists to avoid materializing the wide
        ``[..., slots, dim]`` temporary. A one-shot browser export does not care
        about that temporary, and ``embedding_bag``'s ``per_sample_weights``
        does not export.
        """

        vectors = F.embedding(indices, weight)
        if valid is not None:
            vectors = vectors * valid.unsqueeze(-1).to(vectors.dtype)
        return vectors.sum(dim=-2)

    def embed_sum(self, tokens, start: int = 0):
        core = tokens[..., :CORE_TOKEN_WIDTH]
        pressure = tokens[..., CORE_TOKEN_WIDTH:BASE_TOKEN_WIDTH]
        core_na = self.base_slot_na_ids[:CORE_TOKEN_WIDTH]
        pressure_na = self.base_slot_na_ids[CORE_TOKEN_WIDTH:BASE_TOKEN_WIDTH]
        x = embedding_bag_sum(
            core + self.slot_offsets,
            self.slot_embedding.weight,
            valid=(core_na < 0) | (core != core_na),
        )
        x = x + embedding_bag_sum(
            pressure + self.bid_pressure_offsets,
            self.bid_pressure_embedding.weight,
            valid=(pressure_na < 0) | (pressure != pressure_na),
        )
        x = x + self.na_pattern_embedding(tokens[..., SLOT_NA_PATTERN])

        # Eager code selects TRICK_WIN rows before gathering. Gather every row
        # and zero the rest instead: the row count is the dynamic sequence axis,
        # so a boolean select would bake the trace's row count into the graph.
        remaining = tokens[..., SLOT_REMAINING_HAND_START:SLOT_NA_PATTERN]
        hand_sum = embedding_bag_sum(
            remaining.clamp_max(NUM_CARDS - 1),
            self.effective_card_input_weight(),
            valid=remaining < NUM_CARDS,
        )
        is_trick_win = (core[..., SLOT_TYPE] == TOKEN_TRICK_WIN).unsqueeze(-1)
        x = x + hand_sum * is_trick_win.to(hand_sum.dtype)

        positions = torch.arange(
            start, start + tokens.shape[1], device=tokens.device
        )
        return x + self.pos_embedding(positions)

    def packed_token_conditioning(self, tokens, table, na_patterns):
        base = tokens[..., :BASE_TOKEN_WIDTH]
        packed = embedding_bag_sum(
            base + self.conditioning_slot_offsets,
            table.weight,
            valid=(self.base_slot_na_ids < 0) | (base != self.base_slot_na_ids),
        )
        packed = packed + na_patterns(tokens[..., SLOT_NA_PATTERN])

        remaining = tokens[..., SLOT_REMAINING_HAND_START:SLOT_NA_PATTERN]
        valid = remaining < NUM_CARDS
        safe = remaining.clamp_max(NUM_CARDS - 1)
        card_rows = torch.stack(
            (
                safe + self.conditioning_slot_offsets[SLOT_CARD],
                safe.remainder(NUM_RANKS)
                + self.conditioning_slot_offsets[SLOT_RANK],
                safe.div(NUM_RANKS, rounding_mode="floor")
                + self.conditioning_slot_offsets[SLOT_SUIT],
            ),
            dim=-1,
        )
        hand_sum = embedding_bag_sum(
            card_rows.flatten(-2),
            table.weight,
            valid=valid.unsqueeze(-1).expand_as(card_rows).flatten(-2),
        )
        is_trick_win = (base[..., SLOT_TYPE] == TOKEN_TRICK_WIN).unsqueeze(-1)
        return packed + hand_sum * is_trick_win.to(hand_sum.dtype)

    def forward_full(self, x, *, value_embedding=None, value_gate_weight=None):
        if value_gate_weight is not None:
            raise NotImplementedError(
                "The full-sequence path never gates value embeddings; a "
                "checkpoint that does would need this export path revisited."
            )
        q, k, v = self._qkv(self.ln_attn(x), value_embedding, None)
        # SDPA's enable_gqa has no ONNX lowering, so broadcast the KV heads and
        # spell the causal attention out. The browser runs one sequence at a
        # time, where the memory this costs is irrelevant.
        k = k.repeat_interleave(self.head_group, dim=1)
        v = v.repeat_interleave(self.head_group, dim=1)
        scores = (q @ k.transpose(-1, -2)) * self.scale
        length = x.shape[1]
        row = torch.arange(length, device=x.device)[:, None]
        col = torch.arange(length, device=x.device)[None, :]
        scores = scores.masked_fill(col > row, -1.0e9)
        return self._finish(x, scores.softmax(dim=-1) @ v)

    # Read through __dict__ rather than the class: attribute access unwraps the
    # staticmethod descriptor on _embedding_bag_sum, and restoring the bare
    # function would silently turn it into an instance method.
    originals = tuple(
        (owner, name, vars(owner)[name])
        for owner, name in (
            (SeqPlumpModel, "_embedding_bag_sum"),
            (SeqPlumpModel, "_embed_sum"),
            (SeqPlumpModel, "_packed_token_conditioning"),
            (DecoderBlock, "forward_full"),
        )
    )
    SeqPlumpModel._embedding_bag_sum = staticmethod(embedding_bag_sum)
    SeqPlumpModel._embed_sum = embed_sum
    SeqPlumpModel._packed_token_conditioning = packed_token_conditioning
    DecoderBlock.forward_full = forward_full
    try:
        yield
    finally:
        for owner, name, original in originals:
            setattr(owner, name, original)


def assert_exportable(config) -> None:
    """Reject checkpoint features this export path has not been validated on.

    Nothing is currently rejected. ``embedding_rms_norm`` was, until the v4
    checkpoints turned it on: it runs inside ``SeqPlumpModel.embed``, above the
    patched ``_embed_sum``, and lowers to ordinary elementwise ops, so the only
    open question was numerical. ``check-plump-onnx.py`` answers that one
    directly against the checkpoint, which is a stronger guarantee than a
    feature list -- so new trunk features belong here only if they are known to
    be unexportable, not merely new.
    """

    return None


def sample_tokens(config, length: int) -> torch.Tensor:
    """One legal token row repeated to ``length``, for tracing the graph.

    Built through the training project's own token builder rather than by
    writing literal column values: the NA-pattern slot must hold a pattern id
    the model has an embedding row for, and pattern 0 is reserved for padding.
    """

    from plump.seq.config import TOKEN_WIDTH
    from plump.seq.tokens import card_from_id, prefix_tokens

    hand = [card_from_id(index) for index in range(config.max_hand_size)]
    rows = prefix_tokens(
        config,
        observer=0,
        num_players=config.max_players,
        hand_size=config.max_hand_size,
        initial_hand=hand,
        bidding_start_player=0,
    )
    tokens = torch.tensor(rows[0], dtype=torch.int64)
    assert tokens.shape == (TOKEN_WIDTH,)
    return tokens.view(1, 1, TOKEN_WIDTH).expand(1, length, TOKEN_WIDTH).clone()
