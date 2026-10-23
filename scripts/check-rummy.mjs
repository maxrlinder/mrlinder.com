import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { RummyEngine, ObservationWriter, candidateFeatures, handMelds, canMeld, TAKE } from '../site/RL-environment/rummy/engine.js';
import { RULES } from '../site/RL-environment/rummy/rules-data.js';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/rummy-games.json', import.meta.url)));
const modelRoot = new URL('../site/RL-environment/rummy/model/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', modelRoot)));
assert.equal(manifest.schemaVersion, 3);
assert.deepEqual(manifest.outputs, ['logits', 'value', 'following_values']);
assert.equal(manifest.valueSeats, 4);
assert.equal(manifest.tokenWidth, 78);
assert.deepEqual(manifest.rules, { players: [2, 3, 4], decks: [1, 2], handSize: 7, openingPoints: 0, maxTurns: 200 });
const weights = await readFile(new URL(manifest.file, modelRoot));
assert.equal(weights.length, manifest.bytes);
assert.equal(createHash('sha256').update(weights).digest('hex'), manifest.sha256);
let decisions = 0, turns = 0, deep = 0;
const kinds = new Set();
for (const [game, fixture] of fixtures.entries()) {
  const e = new RummyEngine(fixture.initial), writer = new ObservationWriter(e);
  for (const [step, expected] of fixture.steps.entries()) {
    const context = `game ${game}, decision ${step}`;
    assert.deepEqual(writer.observe(e.current), expected.token, `Decision token: ${context}`);
    const actions = e.candidates();
    assert.deepEqual(actions, expected.actions, `Legal actions: ${context}`);
    assert.deepEqual(candidateFeatures(e, actions), expected.features, `Candidate features: ${context}`);
    const chosen = actions[expected.chosen];
    kinds.add(chosen[0]);
    if (chosen[0] === TAKE && chosen[2] > 0) deep++;
    const rows = writer.record(e.apply(chosen));
    assert.deepEqual(rows, expected.turn, `Turn tokens: ${context}`);
    if (rows) turns++;
    // Every physical card is conserved.
    for (let card = 0; card < 52; card++) {
      const copies = e.hands.reduce((n, h) => n + h[card], 0) + e.placed.reduce((n, p) => n + p[card], 0)
        + e.stock.filter(c => c === card).length + e.pile.filter(c => c === card).length;
      assert.equal(copies, e.decks, `Card conservation: ${context}`);
    }
    decisions++;
  }
  assert.equal(e.done, true);
  assert.deepEqual(e.points, fixture.points);
  assert.deepEqual(e.scores(), fixture.scores);
  assert.equal(e.winner, fixture.winner);
  assert.equal(e.truncated, fixture.truncated);
  assert.throws(() => e.apply([0, 52, -1]));
}
assert.equal(kinds.size, 7, 'Exercise all seven action kinds');
assert.ok(deep > 20, 'Exercise deep discard pickups');
// Duplicate suits cannot form a group; a meld never takes the last card.
const duplicate = Array(52).fill(0); duplicate[0] = 2; duplicate[13] = 1;
assert.deepEqual(handMelds(duplicate), []);
const three = Array(52).fill(0); [0, 13, 26].forEach(c => three[c]++);
assert.equal(canMeld(three, 0), false);
three[5]++;
assert.equal(canMeld(three, 0), true);
// Every cyclic meld and extension round-trips through the hand enumerator.
RULES.cards.forEach((cards, m) => {
  const h = Array(52).fill(0); cards.forEach(c => h[c]++);
  assert.ok(handMelds(h).includes(m));
  for (const [card, extended] of RULES.extensions[m]) {
    const after = [...cards, card].sort((a, b) => a - b);
    assert.deepEqual([...RULES.cards[extended]].sort((a, b) => a - b), after);
  }
});
console.log(`Rummy: ${fixtures.length} Python games / ${decisions} decisions and ${turns} turn tokens match (${deep} deep pickups); all action kinds, scores, and 589 melds verified.`);
