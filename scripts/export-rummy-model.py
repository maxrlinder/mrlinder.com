#!/usr/bin/env python3
"""Export the cardgym Rummy actor, rule tables, and Python parity fixtures.

Usage: python scripts/export-rummy-model.py [--checkpoint path/to/iter_N.pt]
Requires torch, numpy, onnx and onnxruntime; see site/RL-environment/rummy/README.md.
"""
import argparse
import copy
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
HAND_SIZE, MAX_TURNS = 7, 200


@contextmanager
def export_patches():
    """Lower unsupported ops; keep the actual training architecture and weights."""
    import cardgym.games.rummy.model as module
    from cardgym.nn.trunk import DecoderBlock, RMSNorm
    old = module._bag, module.FusedRMSNorm.forward, DecoderBlock.forward_full, RMSNorm.forward

    def norm(self, x):
        return x * torch.rsqrt(x.float().square().mean(-1, keepdim=True) + self.eps) * self.weight

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
    module.FusedRMSNorm.forward = norm
    DecoderBlock.forward_full = attention
    RMSNorm.forward = trunk_norm
    try:
        yield
    finally:
        module._bag, module.FusedRMSNorm.forward, DecoderBlock.forward_full, RMSNorm.forward = old


def score(scorer, hidden, grid, kind, cards, target, taken):
    """CandidateScorer.forward with every slot present, written without in-place slice writes.

    A play decision has no pickup, so its taken counts are all zero, which adds
    exactly nothing; one graph then serves both heads.
    """
    from cardgym.games.rummy.cards import NO_CARD, NUM_CARDS
    dtype = grid.dtype
    rows, width = kind.shape
    ids = torch.cat([cards, target], dim=-1).long()
    present = ids != NO_CARD
    offsets = torch.arange(2).repeat_interleave(cards.shape[-1]) * NUM_CARDS
    moved = torch.zeros(rows, width, 2 * NUM_CARDS, dtype=dtype).scatter_add(2, torch.where(present, ids + offsets, 0), present.to(dtype))
    counts = torch.cat([moved, taken.to(dtype)], dim=-1)
    summed = torch.bmm(counts.view(rows, width * 3, NUM_CARDS), grid).view(rows, width, -1)
    candidate = (
        F.linear(summed, torch.cat((scorer.card.weight, scorer.target.weight, scorer.taken.weight), dim=1))
        + counts @ torch.cat((scorer.card_id.weight, scorer.target_id.weight, scorer.taken_id.weight)).to(dtype)
        + scorer.kind(kind.long())
        + scorer.size(present[..., : cards.shape[-1]].sum(-1))
    )
    mixed = scorer.norm(scorer.query(hidden)[:, None, :] + candidate)
    return scorer.out(F.gelu(scorer.hidden(mixed))).squeeze(-1)


class BrowserActor(nn.Module):
    """The policy over the candidates, the value head now, and the value head
    after each of a batch of one-token continuations of the stream.

    A continuation is the stream plus one token (the seat's next decision token
    after a candidate move, for the advantage readout). Its token attends to the
    stream's keys and values, computed once, so looking one decision ahead
    costs a token per candidate rather than a stream per candidate.
    """

    def __init__(self, actor):
        super().__init__()
        self.actor = actor

    def forward(self, tokens, kind, cards, target, taken, following):
        actor, trunk = self.actor, self.actor.trunk
        x, ple, values = actor.prepare(tokens)
        grid = actor.pop_context()[:, -1]
        # The continuations as a batch of one-token rows.
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
        logits = score(actor.scorer, hidden, grid, kind, cards, target, taken)
        return logits, actor.player_values(hidden), actor.player_values(after)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT.parent / 'card_playing_gym')
    parser.add_argument('--checkpoint', type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.source.resolve()))
    from cardgym.games.rummy.cards import NUM_CARDS
    from cardgym.games.rummy.engine import DRAW, TAKE, RummyEngine
    from cardgym.games.rummy.heuristic import HeuristicPolicy
    from cardgym.games.rummy.melds import MELDS, MELD_CARDS, MELD_KIND, MELD_POINTS, EXTENSIONS
    from cardgym.games.rummy.model import MAX_PLAYERS, RummyActor, RummyModelConfig
    from cardgym.games.rummy.selfplay import candidate_features
    from cardgym.games.rummy.tokens import ObservationWriter, WIDTH, FIELD_VOCAB
    from cardgym.rl.checkpoint import load_weights

    if args.checkpoint is None:
        latest = max((args.source / 'runs/rummy').glob('*/checkpoints/latest.json'), key=lambda p: p.stat().st_mtime)
        args.checkpoint = latest.parent / json.loads(latest.read_text())['path']
    payload = load_weights(args.checkpoint, 'rummy')
    torch.set_num_threads(4)
    actor = RummyActor(RummyModelConfig(**payload['model'])).eval()
    actor.load_state_dict(payload['actor'])
    wrapper = BrowserActor(actor).eval()
    out = ROOT / 'site/RL-environment/rummy/model'
    out.mkdir(parents=True, exist_ok=True)
    rules = dict(melds=MELDS, cards=MELD_CARDS, kinds=MELD_KIND, points=MELD_POINTS, extensions=EXTENSIONS)
    (out.parent / 'rules-data.js').write_text('// Generated from cardgym; regenerate with scripts/export-rummy-model.py.\nexport const RULES = ' + json.dumps(rules, separators=(',', ':')) + ';\n')

    def reference(stream, features, following):
        taken = features.get('taken', np.zeros((len(features['kind']), NUM_CARDS), dtype=np.int8))
        inputs = (torch.tensor(np.array([stream]), dtype=torch.long),
                  *(torch.tensor(np.asarray(x)[None], dtype=torch.long) for x in (features['kind'], features['cards'], features['target'], taken)),
                  torch.tensor(np.array(following), dtype=torch.long))
        with torch.inference_mode():
            hidden = actor.forward_hidden(inputs[0])[:, -1]
            grid = actor.pop_context()[:, -1]
            # The training scorer, with no pickup slot on play decisions.
            logits = actor.scorer(hidden, grid, *inputs[1:4], inputs[4] if 'taken' in features else None).numpy()
            # Each continuation run as a whole stream of its own.
            after = [actor.player_values(actor.forward_hidden(torch.cat([inputs[0], row[None, None]], dim=1))[:, -1]) for row in inputs[5]]
            actor.pop_context()
            expected = (logits, actor.player_values(hidden).numpy(), torch.cat(after).numpy())
        return inputs, expected

    def continuations(engine, writer, seat, actions):
        """The seat's next decision token after a few of its candidate moves."""
        rows = []
        for index in sorted(set([0, len(actions) // 2, len(actions) - 1])):
            sim = copy.deepcopy((engine, writer))
            sim[1].record(sim[0].apply(actions[index]))
            rows.append(sim[1].observe(seat)[0])
        return rows

    # Reference games covering every shape the browser offers, with every legal
    # move list, candidate feature, decision token, and opponent-turn token.
    fixtures, samples = [], []
    heuristic = HeuristicPolicy()
    rng = random.Random(72)
    for players in (2, 3, 4):
        for decks in (1, 2):
            for seed in range(3):
                engine = RummyEngine(players, HAND_SIZE, 1000 * players + 100 * decks + seed, decks=decks, max_turns=MAX_TURNS)
                writer = ObservationWriter(engine)
                initial = dict(players=players, decks=decks, hands=engine.hands.tolist(), stock=list(engine.stock), pile=list(engine.pile), current=engine.current)
                steps, streams = [], [[] for _ in range(players)]
                while not engine.done:
                    seat = engine.current
                    token, _ = writer.observe(seat)
                    streams[seat].append(token)
                    actions = engine.candidates()
                    features = candidate_features(engine, actions)
                    deep = [i for i, a in enumerate(actions) if a.kind == TAKE and a.meld > 0]
                    if len(samples) < 90 and (len(steps) in (0, 1, 9, 30) or deep or rng.random() < 0.08):
                        samples.append(reference(streams[seat], features, continuations(engine, writer, seat, actions)))
                    # Mostly heuristic play, salted with random moves and deep pickups.
                    if deep and rng.random() < 0.6:
                        chosen = rng.choice(deep)
                    elif rng.random() < (0.35 if seed == 2 else 0.1):
                        chosen = rng.randrange(len(actions))
                    else:
                        chosen = heuristic.act(engine)
                    rows = writer.record(engine.apply(actions[chosen]))
                    turn = None if rows is None else rows[:, 0].tolist()
                    if rows is not None:
                        for other in range(players):
                            if other != seat:
                                streams[other].append(rows[other, 0])
                    steps.append(dict(token=token.tolist(), actions=[list(a) for a in actions],
                                      features={k: v.tolist() for k, v in features.items()}, chosen=chosen, turn=turn))
                fixtures.append(dict(initial=initial, steps=steps, scores=engine.scores().tolist(), points=engine.points.tolist(),
                                     winner=engine.winner, truncated=engine.truncated))
    fixture_path = ROOT / 'scripts/fixtures/rummy-games.json'
    fixture_path.write_text(json.dumps(fixtures, separators=(',', ':')) + '\n')
    print(f'{len(fixtures)} games, {sum(len(f["steps"]) for f in fixtures)} decisions, {len(samples)} model samples')

    file = out / f'rummy-{args.checkpoint.parent.parent.name}-{payload["iteration"]}-values-fp32.onnx'
    names = ['tokens', 'kind', 'cards', 'target', 'taken', 'following']
    outputs = ['logits', 'value', 'following_values']
    # Logits to within 5e-5; values are in points (tens), so to within 5e-6 of their scale.
    tolerance = dict(logits=5e-5, value=1e-3, following_values=1e-3)
    with torch.inference_mode(), export_patches():
        for inputs, expected in samples:
            for name, actual, wanted in zip(outputs, wrapper(*inputs), expected):
                np.testing.assert_allclose(actual.numpy(), wanted, atol=tolerance[name] * 0.6, rtol=3e-5)
        torch.onnx.export(wrapper, samples[0][0], file, input_names=names, output_names=outputs,
                          dynamic_axes={'tokens': {1: 'sequence'}, 'kind': {1: 'candidates'}, 'cards': {1: 'candidates'},
                                        'target': {1: 'candidates'}, 'taken': {1: 'candidates'}, 'logits': {1: 'candidates'},
                                        'following': {0: 'following'}, 'following_values': {0: 'following'}},
                          opset_version=18, dynamo=False)
    import onnx
    import onnxruntime as ort
    onnx.checker.check_model(str(file))
    session = ort.InferenceSession(str(file), providers=['CPUExecutionProvider'])
    error = dict.fromkeys(outputs, 0.0)
    for inputs, expected in samples:
        for name, actual, wanted in zip(outputs, session.run(outputs, {name: x.numpy() for name, x in zip(names, inputs)}), expected):
            error[name] = max(error[name], float(np.max(np.abs(wanted - actual))))
            np.testing.assert_allclose(actual, wanted, atol=tolerance[name], rtol=5e-5)
    # Only publish the pointer after export and numerical verification succeed.
    manifest = dict(format='onnx', schemaVersion=3, tokenWidth=WIDTH, fieldVocab=FIELD_VOCAB, iteration=payload['iteration'],
                    run=args.checkpoint.parent.parent.name, checkpoint=args.checkpoint.name, modelConfig=payload['model'],
                    file=file.name, bytes=file.stat().st_size, sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
                    sourceSha256=hashlib.sha256(args.checkpoint.read_bytes()).hexdigest(), precision='fp32',
                    outputs=outputs, valueSeats=MAX_PLAYERS,
                    validation=dict(samples=len(samples), maxAbsoluteError=error),
                    rules=dict(players=[2, 3, 4], decks=[1, 2], handSize=HAND_SIZE, openingPoints=0, maxTurns=MAX_TURNS))
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({k: v for k, v in manifest.items() if k != 'fieldVocab'}, indent=2))


if __name__ == '__main__':
    main()
