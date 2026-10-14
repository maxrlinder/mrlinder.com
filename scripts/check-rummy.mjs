import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { RummyEngine, ObservationWriter, candidateFeatures, handMelds, openingMelds } from '../RL-environment/rummy/engine.js';
import { RULES } from '../RL-environment/rummy/rules-data.js';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/rummy-games.json', import.meta.url)));
const modelRoot = new URL('../RL-environment/rummy/model/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', modelRoot)));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.tokenWidth, 76);
const weights = await readFile(new URL(manifest.file, modelRoot));
assert.equal(weights.length, manifest.bytes);
assert.equal(createHash('sha256').update(weights).digest('hex'), manifest.sha256);
let decisions = 0;
const kinds = new Set();
for (const [game, fixture] of fixtures.entries()) {
  const e = new RummyEngine(fixture.initial), writer = new ObservationWriter(e);
  for (const [step, expected] of fixture.steps.entries()) {
    const context = `game ${game}, decision ${step}`;
    assert.deepEqual(writer.observe(e.current), expected.token, `Actor observation: ${context}`);
    const actions = e.candidates();
    assert.deepEqual(actions, expected.actions, `Legal actions: ${context}`);
    assert.deepEqual(candidateFeatures(e, actions), expected.features, `Candidate features: ${context}`);
    kinds.add(actions[expected.chosen][0]);
    const event = e.apply(actions[expected.chosen]); writer.record(event);
    // Every physical card is conserved, including the two indistinguishable copies.
    for (let card = 0; card < 52; card++) {
      const copies = e.hands.reduce((n, h) => n + h[card], 0) + e.stock.filter(c => c === card).length + e.pileCounts[card] + e.tableCounts[card];
      assert.equal(copies, 2, `Card conservation: ${context}`);
    }
    decisions++;
  }
  assert.equal(e.done, true);
  assert.deepEqual(e.scores(), fixture.scores);
  assert.equal(e.winner, fixture.winner);
  assert.equal(e.rummy, fixture.rummy);
  assert.equal(e.truncated, fixture.truncated);
  assert.throws(() => e.apply([0, 52, -1]));
}
assert.equal(kinds.size, 7, 'Exercise all seven action kinds');
// Opening cannot consume the last card; duplicate suits cannot form a group.
const hand = Array(52).fill(0); [0, 13, 26].forEach(c => hand[c]++);
assert.deepEqual(openingMelds(hand, handMelds(hand), 30), []);
hand[4]++;
assert.equal(openingMelds(hand, handMelds(hand), 30).length, 1);
const duplicate = Array(52).fill(0); duplicate[0] = 2; duplicate[13] = 1;
assert.deepEqual(handMelds(duplicate), []);
// Every cyclic meld and extension round-trips through the hand enumerator.
RULES.cards.forEach((cards, m) => {
  const h = Array(52).fill(0); cards.forEach(c => h[c]++);
  assert.ok(handMelds(h).includes(m));
  for (const [card, extended] of RULES.extensions[m]) {
    const after = [...cards, card].sort((a, b) => a - b);
    assert.deepEqual([...RULES.cards[extended]].sort((a, b) => a - b), after);
  }
});
console.log(`Rummy: ${fixtures.length} Python games / ${decisions} decisions match; all action kinds, observations, scores, and 589 melds verified.`);
