#!/usr/bin/env python3
"""Export the cardgym Rummy actor, rule tables, and Python parity fixtures.

Usage: python scripts/export-rummy-model.py [--checkpoint path/to/iter_N.pt]
Requires torch, numpy, onnx and onnxruntime; see RL-environment/rummy/README.md.
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
    """Lower unsupported ops; keep the actual training architecture and weights."""
    import cardgym.games.rummy.model as module
    from cardgym.nn.trunk import DecoderBlock
    old = module._bag, module.FusedRMSNorm.forward, DecoderBlock.forward_full

    def norm(self, x):
        return x * torch.rsqrt(x.float().square().mean(-1, keepdim=True) + self.eps) * self.weight

    def attention(self, x, value_embedding=None):
        q, k, v = self._qkv(self.ln_attn(x), value_embedding)
        k, v = (t.repeat_interleave(self.head_group, dim=1) for t in (k, v))
        scores = (q @ k.transpose(-1, -2)) * self.scale
        pos = torch.arange(x.shape[1], device=x.device)
        scores = scores.masked_fill(pos[None, :] > pos[:, None], -1e9)
        return self._finish(x, scores.softmax(-1) @ v)

    module._bag = lambda ids, weight: F.embedding(ids, weight).sum(-2)
    module.FusedRMSNorm.forward = norm
    DecoderBlock.forward_full = attention
    try:
        yield
    finally:
        module._bag, module.FusedRMSNorm.forward, DecoderBlock.forward_full = old


class BrowserActor(nn.Module):
    def __init__(self, actor):
        super().__init__()
        self.actor = actor

    def forward(self, tokens, kind, cards, target):
        hidden = self.actor.forward_hidden(tokens)[:, -1]
        grid = self.actor.pop_context()[:, -1]
        return self.actor.scorer(hidden, grid, kind, cards, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT.parent / 'card_playing_gym')
    parser.add_argument('--checkpoint', type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.source.resolve()))
    from cardgym.games.rummy.engine import RummyEngine
    from cardgym.games.rummy.heuristic import HeuristicPolicy
    from cardgym.games.rummy.melds import MELDS, MELD_CARDS, MELD_KIND, MELD_POINTS, EXTENSIONS
    from cardgym.games.rummy.model import RummyActor, RummyModelConfig
    from cardgym.games.rummy.selfplay import candidate_features
    from cardgym.games.rummy.tokens import ObservationWriter, WIDTH, FIELD_VOCAB
    from cardgym.rl.checkpoint import load_weights

    if args.checkpoint is None:
        latest = max((args.source / 'runs/rummy').glob('*/checkpoints/latest.json'), key=lambda p: p.stat().st_mtime)
        args.checkpoint = latest.parent / json.loads(latest.read_text())['path']
    payload = load_weights(args.checkpoint, 'rummy')
    torch.set_num_threads(2)
    actor = RummyActor(RummyModelConfig(**payload['model'])).eval()
    actor.load_state_dict(payload['actor'])
    wrapper = BrowserActor(actor).eval()
    out = ROOT / 'RL-environment/rummy/model'
    out.mkdir(parents=True, exist_ok=True)
    rules = dict(melds=MELDS, cards=MELD_CARDS, kinds=MELD_KIND, points=MELD_POINTS, extensions=EXTENSIONS)
    (out.parent / 'rules-data.js').write_text('// Generated from cardgym; regenerate with scripts/export-rummy-model.py.\nexport const RULES = ' + json.dumps(rules, separators=(',', ':')) + ';\n')

    # Reference real games, including all legal moves and actor-private ledgers.
    fixtures, samples = [], []
    heuristic = HeuristicPolicy()
    rng = random.Random(72)
    for players in (2, 3, 4):
        for seed in range(4):
            engine = RummyEngine(players, 13, seed + 27, max_turns=200)
            writer = ObservationWriter(engine)
            initial = dict(players=players, hands=engine.hands.tolist(), stock=engine.stock.copy(), pile=engine.pile.copy(), current=engine.current)
            steps, streams = [], [[] for _ in range(players)]
            while not engine.done:
                seat = engine.current
                token, _ = writer.observe(seat)
                streams[seat].append(token.tolist())
                actions = engine.candidates()
                features = candidate_features(engine, actions)
                if len(steps) in (0, 1, 12, 53, 100, 170) or (len(samples) < 70 and any(a.kind in (2, 3, 4, 5) for a in actions)):
                    inputs = (torch.tensor([streams[seat]], dtype=torch.long), *(torch.tensor(features[k][None], dtype=torch.long) for k in ('kind', 'cards', 'target')))
                    with torch.inference_mode():
                        expected = wrapper(*inputs).numpy()
                    samples.append((inputs, expected))
                chosen = heuristic.act(engine) if seed < 3 else rng.randrange(len(actions))
                steps.append(dict(token=token.tolist(), actions=[list(a) for a in actions], features={k: v.tolist() for k, v in features.items()}, chosen=chosen))
                writer.record(engine.apply(actions[chosen]))
            fixtures.append(dict(initial=initial, steps=steps, scores=engine.scores().tolist(), winner=engine.winner, rummy=engine.rummy, truncated=engine.truncated))
    fixture_path = ROOT / 'scripts/fixtures/rummy-games.json'
    fixture_path.write_text(json.dumps(fixtures, separators=(',', ':')) + '\n')
    file = out / f'rummy-{args.checkpoint.parent.parent.name}-{payload["iteration"]}-fp32.onnx'
    with torch.inference_mode(), export_patches():
        for inputs, expected in samples:
            np.testing.assert_allclose(wrapper(*inputs).numpy(), expected, atol=3e-5, rtol=3e-5)
        torch.onnx.export(wrapper, samples[0][0], file, input_names=['tokens', 'kind', 'cards', 'target'], output_names=['logits'],
                          dynamic_axes={'tokens': {1: 'sequence'}, 'kind': {1: 'candidates'}, 'cards': {1: 'candidates'}, 'target': {1: 'candidates'}, 'logits': {1: 'candidates'}},
                          opset_version=18, dynamo=False)
    import onnx
    import onnxruntime as ort
    onnx.checker.check_model(str(file))
    session = ort.InferenceSession(str(file), providers=['CPUExecutionProvider'])
    error = 0.0
    for inputs, expected in samples:
        actual = session.run(None, {name: x.numpy() for name, x in zip(['tokens', 'kind', 'cards', 'target'], inputs)})[0]
        error = max(error, float(np.max(np.abs(expected - actual))))
        np.testing.assert_allclose(actual, expected, atol=5e-5, rtol=5e-5)
    # Only publish the pointer after export and numerical verification succeed.
    manifest = dict(format='onnx', schemaVersion=1, tokenWidth=WIDTH, fieldVocab=FIELD_VOCAB, iteration=payload['iteration'],
                    run=args.checkpoint.parent.parent.name, checkpoint=args.checkpoint.name, modelConfig=payload['model'],
                    file=file.name, bytes=file.stat().st_size, sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
                    sourceSha256=hashlib.sha256(args.checkpoint.read_bytes()).hexdigest(), precision='fp32',
                    validation=dict(samples=len(samples), maxAbsoluteError=error), rules=dict(players=[2, 3, 4], handSize=13, openingPoints=30, maxTurns=200))
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
