import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { HjarterEngine, NONE, PASS, PLAY } from '../site/RL-environment/hjarter/engine.js?v=1';
import { heuristicCard } from '../site/RL-environment/hjarter/heuristic.js?v=1';
import { FIELD_VOCAB, WIDTH, ObservationWriter, distanceCode, leadCode, F_JACK, F_PLAYERS, F_RULE_JACK, F_TAKEN } from '../site/RL-environment/hjarter/tokens.js?v=1';
import { MAX_PLAYERS } from '../site/RL-environment/hjarter/engine.js?v=1';
import { boundValue, dealBounds, tokenBounds } from '../site/RL-environment/hjarter/bounds.js?v=1';

// Games played by cardgym's engine (scripts/export-hjarter-fixtures.py), replayed
// here: every decision's seat, phase and legal cards, the rule-based player's
// choice, every event the engine emits, each deal's scoring, and, for the
// first games, every seat's token stream of every deal.
const { tokens, games } = JSON.parse(await readFile(new URL('./fixtures/hjarter-games.json', import.meta.url)));
assert.equal(WIDTH, tokens.width, 'Token width');
assert.deepEqual(FIELD_VOCAB, tokens.fieldVocab, 'Field vocabularies');
assert.deepEqual(tokens.leadCodes.map((_, i) => leadCode(tokens.leadFrom + i)), tokens.leadCodes, 'Lead codes');
assert.deepEqual(tokens.distanceCodes.map((_, i) => distanceCode(tokens.distanceFrom + i)), tokens.distanceCodes, 'Distance codes');
let streams = 0, streamTokens = 0;

// The exported agent reads the tokens tokens.js writes, and its file is the one the manifest names.
const modelRoot = new URL('../site/RL-environment/hjarter/model/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', modelRoot)));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.tokenWidth, WIDTH);
assert.deepEqual(manifest.fieldVocab, FIELD_VOCAB);
assert.deepEqual(manifest.outputs, ['pass_logits', 'play_logits', 'value']);
assert.ok(['deal', 'game'].includes(manifest.training.mode), 'Training mode');
const weights = await readFile(new URL(manifest.file, modelRoot));
assert.equal(weights.length, manifest.bytes);
assert.equal(createHash('sha256').update(weights).digest('hex'), manifest.sha256);
const EVENT_FIELDS = ['kind', 'seat', 'card', 'giver', 'trick', 'position', 'led', 'winning', 'points', 'complete', 'nextSeat', 'nextPhase'];
const DEFAULTS = { seat: -1, card: -1, giver: -1, trick: -1, position: -1, led: -1, winning: -1, points: 0, complete: false, nextSeat: -1, nextPhase: NONE };
let decisions = 0, events = 0, deals = 0, moons = 0, jacks = 0;
const phases = new Set();
for (const [index, game] of games.entries()) {
  const where = `game ${index}`;
  const seen = [];
  let dealt = 0;
  // Each deal's streams, kept when the next deal (a fresh context) starts.
  const writer = game.streams ? new ObservationWriter(game.players, { ...game.rules }, game.mode) : null;
  const written = [];
  const engine = new HjarterEngine({
    players: game.players, rules: game.rules, deals: game.deals, dealIndex: game.dealIndex, dealer: game.dealer,
    nextHands: () => game.hands[dealt++],
    listener: (table, event) => {
      const full = { ...DEFAULTS, ...event };
      seen.push(EVENT_FIELDS.map(field => (field === 'complete' ? Number(full[field]) : full[field])));
      if (!writer) return;
      if (event.kind === 0 && writer.streams[0].length) written.push(writer.streams);
      writer.onEvent(table, event);
    },
  });
  for (const [step, expected] of game.decisions.entries()) {
    const context = `${where}, decision ${step}`;
    assert.equal(engine.current, expected.seat, `Seat: ${context}`);
    assert.equal(engine.phase, expected.phase, `Phase: ${context}`);
    assert.deepEqual(engine.legalCards(), expected.legal, `Legal cards: ${context}`);
    assert.equal(heuristicCard(engine), expected.heuristic, `Rule-based choice: ${context}`);
    phases.add(engine.phase);
    engine.apply(expected.action);
    decisions++;
  }
  assert.equal(engine.done, true, `${where} ends`);
  assert.equal(dealt, game.hands.length, `Deals dealt: ${where}`);
  assert.deepEqual(seen, game.events, `Events: ${where}`);
  assert.equal(engine.results.length, game.results.length, `Deals: ${where}`);
  for (const [number, result] of game.results.entries()) {
    const ours = engine.results[number];
    for (const key of ['index', 'direction', 'passed', 'taken', 'points', 'moon', 'queen', 'jack', 'scores']) {
      assert.deepEqual(ours[key], result[key], `${key}: ${where}, deal ${number}`);
    }
    if (result.moon >= 0) moons++;
    if (result.jack >= 0) jacks++;
  }
  assert.deepEqual(engine.scores, game.scores, `Scores: ${where}`);
  if (writer) {
    written.push(writer.streams);
    assert.equal(written.length, game.streams.length, `Token deals: ${where}`);
    for (const [number, deal] of game.streams.entries()) {
      for (const [seat, stream] of deal.entries()) {
        const ours = written[number][seat];
        assert.equal(ours.length, stream.length, `Stream length: ${where}, deal ${number}, seat ${seat}`);
        stream.forEach((row, position) => assert.deepEqual(ours[position], row, `Token: ${where}, deal ${number}, seat ${seat}, position ${position}`));
        streams++; streamTokens += stream.length;
      }
    }
  }
  assert.throws(() => engine.apply(0));
  events += seen.length;
  deals += game.results.length;
}
assert.deepEqual([...phases].sort(), [PASS, PLAY]);

// The value bounds (bounds.js) match cardgym's (scripts/fixtures/hjarter-bounds.json) on every
// state the fixture streams reach, every token reads its own, and once a deal is over they
// are its scored return exactly, which is then what Advantage shows whatever the head said.
const near = (got, want, where) => got.forEach(([lo, hi], s) =>
  assert.ok(Math.abs(lo - want[s][0]) < 1e-6 && Math.abs(hi - want[s][1]) < 1e-6, `${where}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`));
const boundTable = new Map();
for (const state of JSON.parse(await readFile(new URL('./fixtures/hjarter-bounds.json', import.meta.url)))) {
  const key = [state.players, Number(state.jackRule), state.jackTaker, ...state.taken].join();
  boundTable.set(key, state.bounds);
  near(dealBounds(state.taken, state.jackRule, state.jackTaker), state.bounds, `Bounds ${key}`);
}
let boundTokens = 0, decided = 0;
for (const game of games) {
  for (const deal of game.streams ?? []) for (const rows of deal) for (const row of rows) {
    const players = row[F_PLAYERS];
    const key = [players, row[F_RULE_JACK], row[F_JACK] === MAX_PLAYERS ? -1 : row[F_JACK], ...row.slice(F_TAKEN, F_TAKEN + players)].join();
    assert.ok(boundTable.has(key), `A token's state is missing from the bounds fixture: ${key}`);
    near(tokenBounds(row), boundTable.get(key), `Token bounds ${key}`);
    boundTokens++;
  }
  for (const result of game.results) {
    const players = result.points.length, total = result.points.reduce((a, b) => a + b, 0);
    const returns = result.points.map(p => (total - p) / (players - 1) - p);
    const final = dealBounds(result.taken, game.rules.jackOfDiamonds, result.jack);
    near(final, returns.map(r => [r, r]), `A finished deal's bounds (game ${games.indexOf(game)})`);
    returns.forEach((r, s) => assert.ok(Math.abs(boundValue(40, final[s]) - r) < 1e-9));
    decided++;
  }
}
console.log(`Hjärter engine matches cardgym: ${games.length} games, ${deals} deals, ${decisions} decisions, ${events} events, ${moons} moons, ${jacks} J♦ taken; ${streams} token streams, ${streamTokens} tokens, ${boundTable.size} bounded states (${boundTokens} tokens, ${decided} decided deals). Agent ${manifest.run} · ${manifest.iteration}.`);
