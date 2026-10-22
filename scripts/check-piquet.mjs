import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PiquetDeal, HEADS, WIDTH } from '../RL-environment/piquet/engine.js';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/piquet-deals.json', import.meta.url)));
const modelRoot = new URL('../RL-environment/piquet/model/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', modelRoot)));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.tokenWidth, WIDTH);
assert.deepEqual(manifest.outputs, ['exchange_logits', 'declare_logits', 'play_logits', 'value', 'following_values', 'belief_logits']);
assert.equal(manifest.valueSeats, 2);
assert.deepEqual(manifest.rules, { mode: 'deal', handSize: 12, talon: 8, elderMax: 5 });
const weights = await readFile(new URL(manifest.file, modelRoot));
assert.equal(weights.length, manifest.bytes);
assert.equal(createHash('sha256').update(weights).digest('hex'), manifest.sha256);

let decisions = 0, tokens = 0;
const heads = new Set(), bonuses = { repique: 0, pique: 0, capot: 0, carteBlanche: 0 };
for (const [index, fixture] of fixtures.entries()) {
  const deal = new PiquetDeal({ deck: fixture.deck, dealer: fixture.dealer }), engine = deal.engine;
  for (const [step, expected] of fixture.decisions.entries()) {
    const context = `deal ${index}, decision ${step}`;
    assert.equal(engine.current, expected.seat, `Seat: ${context}`);
    assert.equal(engine.head, expected.head, `Head: ${context}`);
    assert.deepEqual(engine.legalActions(), expected.legal, `Legal actions: ${context}`);
    assert.equal(deal.streams[expected.seat].length - 1, expected.position, `Stream position: ${context}`);
    heads.add(engine.head);
    deal.apply(expected.action);
    decisions++;
  }
  assert.equal(engine.done, true, `Deal ${index} ends`);
  for (const seat of [0, 1]) {
    assert.equal(deal.streams[seat].length, fixture.streams[seat].length, `Stream length: deal ${index}, seat ${seat}`);
    deal.streams[seat].forEach((row, t) => assert.deepEqual(row, fixture.streams[seat][t], `Token: deal ${index}, seat ${seat}, position ${t}`));
    tokens += deal.streams[seat].length;
  }
  assert.deepEqual(engine.points, fixture.points);
  assert.deepEqual(engine.tricks, fixture.tricks);
  assert.deepEqual(engine.result.categoryWinners, fixture.categoryWinners);
  assert.deepEqual(engine.result.carteBlanche, fixture.carteBlanche);
  for (const key of ['repique', 'pique', 'capot']) {
    assert.equal(engine.result[key], fixture[key], `${key}: deal ${index}`);
    if (fixture[key] >= 0) bonuses[key]++;
  }
  if (fixture.carteBlanche.some(Boolean)) bonuses.carteBlanche++;
  assert.throws(() => engine.apply(0));
}
assert.equal(heads.size, HEADS.length, 'Exercise all three heads');
assert.ok(Object.values(bonuses).every(n => n > 0), 'Exercise repique, pique, capot and carte blanche');
console.log(`Piquet: ${fixtures.length} Python deals / ${decisions} decisions and ${tokens} tokens match (repique ${bonuses.repique}, pique ${bonuses.pique}, capot ${bonuses.capot}, carte blanche ${bonuses.carteBlanche}).`);
