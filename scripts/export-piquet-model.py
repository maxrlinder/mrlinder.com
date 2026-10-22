#!/usr/bin/env python3
"""Export the cardgym Piquet actor and Python parity fixtures for the browser.

Usage: python scripts/export-piquet-model.py [--checkpoint path/to/iter_N.pt]
Requires torch, numpy, onnx and onnxruntime; see RL-environment/piquet/README.md.
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
    import cardgym.games.piquet.model as module
    from cardgym.nn.trunk import DecoderBlock, RMSNorm
    old = module._bag, module.GridNorm.forward, DecoderBlock.forward_full, RMSNorm.forward

    def grid_norm(self, x):
        x = x.float()
        return x * torch.rsqrt(x.square().mean(-1, keepdim=True) + self.eps) * self.weight

    def trunk_norm(self, x):
        return (x.float() * torch.rsqrt(x.float().square().mean(-1, keepdim=True) + self.eps)).to(x.dtype) * self.weight

    def attention(self, x, value_embedding=None):
        q, k, v = self._qkv(self.ln_attn(x), value_embedding)
        k, v = (t.repeat_interleave(self.head_group, dim=1) for t in (k, v))
        scores = (q @ k.transpose(-1, -2)) * self.scale
        pos = torch.arange(x.shape[1], device=x.device)
        scores = scores.masked_fill(pos[None, :] > pos[:, None], -1e9)
        return self._finish(x, scores.softmax(-1) @ v)

    module._bag = lambda ids, weight: F.embedding(ids, weight).sum(-2)
    module.GridNorm.forward = grid_norm
    DecoderBlock.forward_full = attention
    RMSNorm.forward = trunk_norm
    try:
        yield
    finally:
        module._bag, module.GridNorm.forward, DecoderBlock.forward_full, RMSNorm.forward = old


class BrowserActor(nn.Module):
    """All three policy heads, the value head now and after each of a batch of
    one-token continuations of the stream, and the belief head.

    A continuation is the stream plus one token: the seat's own event token for
    a move (a card played, a declaration, an exchange), or its next decision
    token while it picks discards. Its token attends to the stream's keys and
    values, computed once, so looking one move ahead costs a token per move.
    """

    def __init__(self, actor):
        super().__init__()
        self.actor = actor

    def forward(self, tokens, following):
        actor, trunk = self.actor, self.actor.trunk
        x, ple, values = actor.prepare(tokens)
        grid = actor.pop_context()[:, -1]
        y, ple_y, values_y = (None if t is None else t.transpose(0, 1) for t in actor.prepare(following[None]))
        actor.pop_context()
        rows, pos = y.shape[0], torch.arange(x.shape[1], device=x.device)
        for layer, block in enumerate(trunk.blocks):
            q, k, v = block._qkv(block.ln_attn(x), trunk._value(values, layer))
            qy, ky, vy = block._qkv(block.ln_attn(y), trunk._value(values_y, layer))
            keys, vals = (torch.cat([a.expand(rows, -1, -1, -1), b], dim=2).repeat_interleave(block.head_group, dim=1) for a, b in ((k, ky), (v, vy)))
            k, v = (t.repeat_interleave(block.head_group, dim=1) for t in (k, v))
            scores = ((q @ k.transpose(-1, -2)) * block.scale).masked_fill(pos[None, :] > pos[:, None], -1e9)
            x = trunk._add_ple(block._finish(x, scores.softmax(-1) @ v), ple, layer)
            y = trunk._add_ple(block._finish(y, ((qy @ keys.transpose(-1, -2)) * block.scale).softmax(-1) @ vals), ple_y, layer)
        hidden, after = trunk.final_norm(x)[:, -1], trunk.final_norm(y)[:, -1]
        exchange = torch.cat([actor.exchange_scorer(hidden, grid), actor.stop_head(hidden)], dim=-1)
        belief = actor.auxiliary(hidden)['belief'].view(1, -1, 3)
        return (exchange, actor.declare_head(hidden), actor.play_scorer(hidden, grid),
                actor.player_values(hidden), actor.player_values(after), belief)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT.parent / 'card_playing_gym')
    parser.add_argument('--checkpoint', type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.source.resolve()))
    from cardgym.games.piquet.cards import FACE_MASK, NUM_CARDS, mask_of
    from cardgym.games.piquet.engine import PiquetEngine
    from cardgym.games.piquet.heuristic import HeuristicPolicy, RandomPolicy
    from cardgym.games.piquet.model import PiquetActor, PiquetModelConfig
    from cardgym.games.piquet.tokens import FIELD_VOCAB, WIDTH, ObservationWriter, max_stream_length
    from cardgym.rl.checkpoint import load_weights

    if args.checkpoint is None:
        latest = max((args.source / 'runs/piquet').glob('*/checkpoints/latest.json'), key=lambda p: p.stat().st_mtime)
        args.checkpoint = latest.parent / json.loads(latest.read_text())['path']
    payload = load_weights(args.checkpoint, 'piquet')
    torch.set_num_threads(4)
    actor = PiquetActor(PiquetModelConfig(**payload['model'])).eval()
    actor.load_state_dict(payload['actor'])
    wrapper = BrowserActor(actor).eval()
    out = ROOT / 'RL-environment/piquet/model'
    out.mkdir(parents=True, exist_ok=True)

    def record(deck, dealer, policies, rng):
        """One deal, both seats' streams as selfplay builds them, every decision and its legal actions."""
        streams, writer = [[], []], ObservationWriter()

        def listen(engine, event):
            rows = writer.event_rows(engine, event)
            if rows is not None:
                for seat in (0, 1):
                    streams[seat].append(rows[seat].tolist())

        engine = PiquetEngine(0, dealer=dealer, deck=deck, listener=listen)
        decisions = []
        while not engine.done:
            seat = engine.current
            streams[seat].append(writer.decision_row(engine, seat).tolist())
            legal = engine.legal()
            action = policies[seat](engine, rng)
            decisions.append(dict(seat=seat, head=engine.head, legal=np.flatnonzero(legal).tolist(), action=action,
                                  position=len(streams[seat]) - 1))
            engine.apply(action)
        result = engine.results[0]
        return dict(deck=deck, dealer=dealer, decisions=decisions, streams=streams, points=result.points,
                    tricks=result.tricks, repique=result.repique, pique=result.pique, capot=result.capot,
                    carteBlanche=result.carte_blanche, categoryWinners=result.category_winners)

    heuristic = HeuristicPolicy()

    def mixed(chance):
        def act(engine, rng):
            legal = np.flatnonzero(engine.legal()).tolist()
            return rng.choice(legal) if rng.random() < chance else heuristic.act(engine)
        return act

    # Reference deals: heuristic play salted with random moves, plus forced carte blanche for each role.
    rng = random.Random(81)
    fixtures = []
    plain = [c for c in range(NUM_CARDS) if not FACE_MASK >> c & 1]
    faces = [c for c in range(NUM_CARDS) if FACE_MASK >> c & 1]
    for index in range(40):
        deck = list(range(NUM_CARDS))
        rng.shuffle(deck)
        if index in (5, 6, 7):
            # Carte blanche for Elder (5) or Younger (6, 7).
            rest = plain[:]
            rng.shuffle(rest)
            blanche = rest[:12]
            others = [c for c in range(NUM_CARDS) if c not in blanche]
            rng.shuffle(others)
            deck = blanche + others if index == 5 else others[:12] + blanche + others[12:]
        chance = (0.0, 0.15, 0.5, 1.0)[index % 4]
        fixtures.append(record(deck, index % 2, [mixed(chance), mixed((chance + 0.3) % 1.0)], rng))
    assert any(f['carteBlanche'][0] or f['carteBlanche'][1] for f in fixtures)
    fixture_path = ROOT / 'scripts/fixtures/piquet-deals.json'
    fixture_path.write_text(json.dumps(fixtures, separators=(',', ':')) + '\n')
    total = sum(len(f['decisions']) for f in fixtures)
    print(f'{len(fixtures)} deals, {total} decisions, longest stream {max(len(s) for f in fixtures for s in f["streams"])}')

    # Model samples: a seat's stream up to one of its decisions, continued by a few later tokens.
    samples = []
    for fixture in fixtures[:24]:
        for decision in fixture['decisions'][::5]:
            stream = fixture['streams'][decision['seat']]
            prefix, later = stream[: decision['position'] + 1], stream[decision['position'] + 1 : decision['position'] + 4]
            following = later or [prefix[-1]]
            tokens = torch.tensor([prefix], dtype=torch.long)
            rows = torch.tensor(following, dtype=torch.long)
            with torch.inference_mode():
                hidden = actor.forward_hidden(tokens)[:, -1]
                context = actor.pop_context()[:, -1]
                expected = [actor.policy_logits(hidden, head, context=context).numpy() for head in ('exchange', 'declare', 'play')]
                after = [actor.player_values(actor.forward_hidden(torch.cat([tokens, row[None, None]], dim=1))[:, -1]) for row in rows]
                actor.pop_context()
                expected += [actor.player_values(hidden).numpy(), torch.cat(after).numpy(),
                             actor.auxiliary(hidden)['belief'].view(1, -1, 3).numpy()]
            samples.append(((tokens, rows), expected))
    print(f'{len(samples)} model samples')

    file = out / f'piquet-{args.checkpoint.parent.parent.name}-{payload["iteration"]}-fp32.onnx'
    names = ['tokens', 'following']
    outputs = ['exchange_logits', 'declare_logits', 'play_logits', 'value', 'following_values', 'belief_logits']
    # Logits to within 5e-5; values are points (tens).
    tolerance = dict(exchange_logits=5e-5, declare_logits=5e-5, play_logits=5e-5, value=1e-3, following_values=1e-3, belief_logits=5e-5)
    with torch.inference_mode(), export_patches():
        for inputs, expected in samples:
            for name, actual, wanted in zip(outputs, wrapper(*inputs), expected):
                np.testing.assert_allclose(actual.numpy(), wanted, atol=tolerance[name] * 0.6, rtol=3e-5, err_msg=name)
        torch.onnx.export(wrapper, samples[0][0], file, input_names=names, output_names=outputs,
                          dynamic_axes={'tokens': {1: 'sequence'}, 'following': {0: 'following'}, 'following_values': {0: 'following'}},
                          opset_version=18, dynamo=False)
    import onnx
    import onnxruntime as ort
    onnx.checker.check_model(str(file))
    session = ort.InferenceSession(str(file), providers=['CPUExecutionProvider'])
    error = dict.fromkeys(outputs, 0.0)
    for inputs, expected in samples:
        for name, actual, wanted in zip(outputs, session.run(outputs, {name: x.numpy() for name, x in zip(names, inputs)}), expected):
            error[name] = max(error[name], float(np.max(np.abs(wanted - actual))))
            np.testing.assert_allclose(actual, wanted, atol=tolerance[name], rtol=5e-5, err_msg=name)
    # Only publish the pointer after export and numerical verification succeed.
    manifest = dict(format='onnx', schemaVersion=1, tokenWidth=WIDTH, fieldVocab=list(FIELD_VOCAB), iteration=payload['iteration'],
                    run=args.checkpoint.parent.parent.name, checkpoint=args.checkpoint.name, modelConfig=payload['model'],
                    file=file.name, bytes=file.stat().st_size, sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
                    sourceSha256=hashlib.sha256(args.checkpoint.read_bytes()).hexdigest(), precision='fp32',
                    outputs=outputs, valueSeats=2, maxStream=max_stream_length(1),
                    validation=dict(samples=len(samples), maxAbsoluteError=error),
                    rules=dict(mode='deal', handSize=12, talon=8, elderMax=5))
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({k: v for k, v in manifest.items() if k != 'fieldVocab'}, indent=2))


if __name__ == '__main__':
    main()
