#!/usr/bin/env python3
"""Export the cardgym Hjärter actor for the browser.

Usage: python scripts/export-hjarter-model.py [--checkpoint path/to/iter_N.pt]
Requires torch, numpy, onnx and onnxruntime; see site/RL-environment/hjarter/README.md.
"""
import argparse
import hashlib
import json
import random
import sys
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def export_patches():
    """Lower ops the ONNX exporter lacks; keep the training architecture and weights."""
    import cardgym.games.hjarter.model as module
    from cardgym.nn.trunk import DecoderBlock, RMSNorm
    old = module._bag, DecoderBlock.forward_full, RMSNorm.forward

    def trunk_norm(self, x):
        return (x.float() * torch.rsqrt(x.float().square().mean(-1, keepdim=True) + self.eps)).to(x.dtype) * self.weight

    def attention(self, x, value_embedding=None):
        q, k, v = self._qkv(self.ln_attn(x), value_embedding)
        k, v = (t.repeat_interleave(self.head_group, dim=1) for t in (k, v))
        scores = (q @ k.transpose(-1, -2)) * self.scale
        pos = torch.arange(x.shape[1], device=x.device)
        scores = scores.masked_fill(pos[None, :] > pos[:, None], -1e9)
        return self._finish(x, scores.softmax(-1) @ v)

    module._bag = lambda ids, weight, scale: scale * F.embedding(ids, weight).sum(-2)
    DecoderBlock.forward_full = attention
    RMSNorm.forward = trunk_norm
    try:
        yield
    finally:
        module._bag, DecoderBlock.forward_full, RMSNorm.forward = old


class BrowserActor(nn.Module):
    """The pass and play heads (52 card logits each; the page masks them to the
    legal cards) and the per-seat value probe, at the stream's last token."""

    def __init__(self, actor):
        super().__init__()
        self.actor = actor

    def forward(self, tokens):
        actor = self.actor
        hidden = actor.forward_hidden(tokens)[:, -1]
        return actor.card_heads['pass'](hidden), actor.card_heads['play'](hidden), actor.player_values(hidden)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT.parent / 'card_playing_gym')
    parser.add_argument('--checkpoint', type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.source.resolve()))
    from cardgym.games.hjarter.engine import HjarterEngine, Rules
    from cardgym.games.hjarter.game import HjarterGameConfig
    from cardgym.games.hjarter.heuristic import HeuristicPolicy
    from cardgym.games.hjarter.model import HjarterActor, HjarterModelConfig
    from cardgym.games.hjarter.tokens import FIELD_VOCAB, MAX_LENGTH, MODE_DEAL, MODE_GAME, WIDTH, ObservationWriter
    from cardgym.rl.checkpoint import load_checkpoint, load_weights

    if args.checkpoint is None:
        # The most recent run's latest checkpoint, checked against its pointer: a live
        # run writes the next one beside it.
        latest = max((args.source / 'runs/hjarter').glob('*/checkpoints/latest.json'), key=lambda p: p.stat().st_mtime)
        pointer = json.loads(latest.read_text())
        args.checkpoint = latest.parent / pointer['path']
        if hashlib.sha256(args.checkpoint.read_bytes()).hexdigest() != pointer['sha256']:
            raise SystemExit(f'{args.checkpoint} does not match {latest}.')
    payload = load_weights(args.checkpoint, 'hjarter')
    # What the agent trained on: single deals or whole games, the player counts and rules.
    # A release directory has no training config: assume single deals.
    try:
        game = load_checkpoint(args.checkpoint)['config']['game']
    except Exception:
        game = {}
    game = HjarterGameConfig(**{key: tuple(value) if isinstance(value, list) else value for key, value in game.items()})
    torch.set_num_threads(4)
    actor = HjarterActor(HjarterModelConfig(**payload['model'])).eval()
    actor.load_state_dict(payload['actor'])
    wrapper = BrowserActor(actor).eval()
    out = ROOT / 'site/RL-environment/hjarter/model'
    out.mkdir(parents=True, exist_ok=True)

    # Model samples: seats' streams at their decisions in deals played by the
    # rule-based player salted with random cards, as the agent would see them:
    # every player count, both heads, both jack rules, every passing count, and
    # single-deal and whole-game contexts.
    heuristic = HeuristicPolicy()
    rng = random.Random(1101)
    samples = []
    for index in range(18):
        players = (3, 4, 5)[index % 3]
        rules = Rules(pass_cards=(2, 2, 0, 1, 3, 2)[index % 6], jack_of_diamonds=index % 4 in (1, 2), end_score=100)
        mode = MODE_GAME if index % 5 == 4 else MODE_DEAL
        scores = [rng.randrange(0, 90) for _ in range(players)] if mode == MODE_GAME else None
        writer = ObservationWriter(players, rules, mode)
        engine = HjarterEngine(rng.randrange(1 << 30), players=players, rules=rules, deal_index=rng.randrange(4),
                               dealer=rng.randrange(players), scores=scores, listener=writer.on_event)
        while not engine.done:
            legal = engine.legal_cards()
            if len(legal) > 1 and rng.random() < 0.3:
                samples.append(np.asarray(writer.pending[engine.current], dtype=np.int64)[None])
            engine.apply(rng.choice(legal) if rng.random() < 0.3 else heuristic.act(engine))
    print(f'{len(samples)} model samples, longest stream {max(s.shape[1] for s in samples)}')

    with torch.inference_mode():
        expected = []
        for tokens in samples:
            hidden = actor.forward_hidden(torch.from_numpy(tokens))[:, -1]
            expected.append([actor.policy_logits(hidden, 'pass').numpy(), actor.policy_logits(hidden, 'play').numpy(),
                             actor.player_values(hidden).numpy()])

    file = out / f'hjarter-{args.checkpoint.parent.parent.name}-{payload["iteration"]}-fp32.onnx'
    outputs = ['pass_logits', 'play_logits', 'value']
    # Logits to within 5e-5; values are tens of points.
    tolerance = dict(pass_logits=5e-5, play_logits=5e-5, value=2e-3)
    with torch.inference_mode(), export_patches():
        for tokens, wanted in zip(samples, expected):
            for name, actual, target in zip(outputs, wrapper(torch.from_numpy(tokens)), wanted):
                np.testing.assert_allclose(actual.numpy(), target, atol=tolerance[name] * 0.6, rtol=3e-5, err_msg=name)
        torch.onnx.export(wrapper, (torch.from_numpy(samples[0]),), file, input_names=['tokens'], output_names=outputs,
                          dynamic_axes={'tokens': {1: 'sequence'}}, opset_version=18, dynamo=False)
    import onnx
    import onnxruntime as ort
    onnx.checker.check_model(str(file))
    session = ort.InferenceSession(str(file), providers=['CPUExecutionProvider'])
    error = dict.fromkeys(outputs, 0.0)
    for tokens, wanted in zip(samples, expected):
        for name, actual, target in zip(outputs, session.run(outputs, {'tokens': tokens}), wanted):
            error[name] = max(error[name], float(np.max(np.abs(target - actual))))
            np.testing.assert_allclose(actual, target, atol=tolerance[name], rtol=5e-5, err_msg=name)
    # Only publish the pointer after export and numerical verification succeed.
    manifest = dict(
        format='onnx', schemaVersion=1, tokenWidth=WIDTH, fieldVocab=list(FIELD_VOCAB), maxStream=MAX_LENGTH,
        iteration=payload['iteration'], run=args.checkpoint.parent.parent.name, checkpoint=args.checkpoint.name,
        modelConfig=payload['model'], file=file.name, bytes=file.stat().st_size,
        sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
        sourceSha256=hashlib.sha256(args.checkpoint.read_bytes()).hexdigest(), precision='fp32', outputs=outputs,
        valueSeats=5,
        # The page builds the agent's tokens as it trained: a single-deal agent sees every
        # deal as fresh (no score, the end score it trained with), a whole-game agent the score.
        training=dict(mode=game.mode, players=list(game.player_counts), passCards=list(game.pass_cards),
                      jackOfDiamonds=list(game.jack_of_diamonds), endScore=game.end_score),
        validation=dict(samples=len(samples), maxAbsoluteError=error),
    )
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({k: v for k, v in manifest.items() if k != 'fieldVocab'}, indent=2))


if __name__ == '__main__':
    main()
