import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { roundBounds as rummyBounds } from '../site/RL-environment/rummy/bounds.js?v=1';
import { seatBounds as piquetBounds } from '../site/RL-environment/piquet/bounds.js?v=1';
import { viewerBounds as plumpBounds } from '../site/RL-environment/plump/bounds.js?v=1';

// The value bounds the pages map Advantage into, against cardgym's on the states of
// games it played (scripts/export-bounds-fixtures.py -> scripts/fixtures/bounds.json).
const fixtures = JSON.parse(await readFile(new URL('./fixtures/bounds.json', import.meta.url)));
const near = (got, want, where) => {
  assert.equal(got.length, want.length, where);
  got.forEach(([lo, hi], s) => assert.ok(Math.abs(lo - want[s][0]) < 1e-6 && Math.abs(hi - want[s][1]) < 1e-6,
    `${where}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`));
};
fixtures.rummy.forEach((state, i) => near(rummyBounds(state), state.bounds, `Rummy state ${i}`));
fixtures.piquet.forEach((state, i) => near(piquetBounds(state, { partie: state.rubicon, deals: state.deals }), state.bounds, `Piquet state ${i}`));
fixtures.plump.forEach((state, i) => near(plumpBounds(state.round, state.players, 0), state.bounds, `Plump state ${i}`));
const parties = fixtures.piquet.filter(state => state.rubicon).length;
console.log(`Value bounds match cardgym: Rummy ${fixtures.rummy.length} states, Piquet ${fixtures.piquet.length} (${parties} in parties), Plump ${fixtures.plump.length}.`);
