import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PiquetDeal, HEADS, WIDTH, rubicon } from '../site/RL-environment/piquet/engine.js';

const parties = JSON.parse(await readFile(new URL('./fixtures/piquet-deals.json', import.meta.url)));
const modelRoot = new URL('../site/RL-environment/piquet/model/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', modelRoot)));
assert.equal(manifest.schemaVersion, 2);
assert.equal(manifest.tokenWidth, WIDTH);
assert.deepEqual(manifest.outputs, ['exchange_logits', 'declare_logits', 'play_logits', 'value', 'following_values', 'belief_logits']);
assert.equal(manifest.valueSeats, 2);
assert.ok(['partie', 'deal'].includes(manifest.valueTarget));
assert.deepEqual(manifest.rules, { mode: 'rubicon', deals: 6, handSize: 12, talon: 8, elderMax: 5 });
const weights = await readFile(new URL(manifest.file, modelRoot));
assert.equal(weights.length, manifest.bytes);
assert.equal(createHash('sha256').update(weights).digest('hex'), manifest.sha256);

// Token fields of the partie score (tokens.py): my total, the deal number, the lead.
const F_MY_TOTAL = 24, F_DEAL = 26, F_LEAD = 31, EXACT_TOTAL = 120, LEAD_ZERO = 74, EXACT_LEAD = 60;
let deals = 0, decisions = 0, tokens = 0;
const heads = new Set(), dealNumbers = new Set(), bonuses = { repique: 0, pique: 0, capot: 0, carteBlanche: 0 }, coded = { total: 0, lead: 0 };
for (const [index, partie] of parties.entries()) {
  // The page keeps the totals: each deal starts from the points of the deals before it.
  let totals = [0, 0];
  for (const [number, fixture] of partie.deals.entries()) {
    const where = `partie ${index}, deal ${number}`;
    assert.deepEqual(fixture.totals, totals, `Totals: ${where}`);
    const deal = new PiquetDeal({ deck: fixture.deck, dealer: fixture.dealer, partie: { totals, deal: number } }), engine = deal.engine;
    for (const [step, expected] of fixture.decisions.entries()) {
      const context = `${where}, decision ${step}`;
      assert.equal(engine.current, expected.seat, `Seat: ${context}`);
      assert.equal(engine.head, expected.head, `Head: ${context}`);
      assert.deepEqual(engine.legalActions(), expected.legal, `Legal actions: ${context}`);
      assert.equal(deal.streams[expected.seat].length - 1, expected.position, `Stream position: ${context}`);
      heads.add(engine.head);
      deal.apply(expected.action);
      decisions++;
    }
    assert.equal(engine.done, true, `${where} ends`);
    for (const seat of [0, 1]) {
      assert.equal(deal.streams[seat].length, fixture.streams[seat].length, `Stream length: ${where}, seat ${seat}`);
      deal.streams[seat].forEach((row, t) => {
        assert.deepEqual(row, fixture.streams[seat][t], `Token: ${where}, seat ${seat}, position ${t}`);
        dealNumbers.add(row[F_DEAL]);
        if (row[F_MY_TOTAL] >= EXACT_TOTAL) coded.total++;
        if (Math.abs(row[F_LEAD] - LEAD_ZERO) > EXACT_LEAD) coded.lead++;
      });
      tokens += deal.streams[seat].length;
    }
    assert.deepEqual(engine.points, fixture.points);
    assert.deepEqual(engine.tricks, fixture.tricks);
    assert.deepEqual(engine.result.categoryWinners, fixture.categoryWinners);
    assert.deepEqual(engine.result.carteBlanche, fixture.carteBlanche);
    for (const key of ['repique', 'pique', 'capot']) {
      assert.equal(engine.result[key], fixture[key], `${key}: ${where}`);
      if (fixture[key] >= 0) bonuses[key]++;
    }
    if (fixture.carteBlanche.some(Boolean)) bonuses.carteBlanche++;
    assert.throws(() => engine.apply(0));
    totals = totals.map((total, seat) => total + engine.points[seat]);
    deals++;
  }
  assert.deepEqual(totals, partie.totals, `Final totals: partie ${index}`);
  const { winner, payoff } = rubicon(totals);
  assert.deepEqual([0, 1].map(seat => (winner < 0 ? 0 : seat === winner ? payoff : -payoff)), partie.returns, `Rubicon payoff: partie ${index}`);
}
assert.equal(heads.size, HEADS.length, 'Exercise all three heads');
assert.equal(dealNumbers.size, 6, 'Exercise every deal of a partie');
assert.ok(coded.total > 0 && coded.lead > 0, 'Exercise totals from 120 and leads beyond ±60 (coded in tens)');
assert.ok(Object.values(bonuses).every(n => n > 0), 'Exercise repique, pique, capot and carte blanche');
console.log(`Piquet: ${parties.length} Python parties (${deals} deals) / ${decisions} decisions and ${tokens} tokens match (repique ${bonuses.repique}, pique ${bonuses.pique}, capot ${bonuses.capot}, carte blanche ${bonuses.carteBlanche}).`);
