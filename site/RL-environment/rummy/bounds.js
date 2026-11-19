// What each seat's round score against the table can still be: the interval the
// value head's reading is mapped into before Advantage shows it, as in training
// (cardgym rummy/bounds.py and rl/ppo.py bound_values; scripts/check-rummy.mjs
// holds the two to the same numbers).
//
// From public information only (the points laid so far and the cards on the
// table, never who holds what): every card off the table ends in a hand (its
// value against that hand), melded (at most its value for the seat that lays
// it), or in the stock or pile; a card laid before a run's low ace (worth 1 at a
// run's start) can lift that ace to 11. So a seat's return moves from its lead
// now by at most the off-table cards' value, plus 10 per low ace, either way.
import { VALUES } from './engine.js?v=mp-4';
import { RULES } from './rules-data.js';

const ACE_LIFT = 10, FULL_RUN = 13, DECK_VALUE = 4 * VALUES.reduce((a, b) => a + b, 0);

// [low, high] of every seat's return, absolute seats.
export function roundBounds(engine) {
  const n = engine.players, points = engine.points, total = points.reduce((a, b) => a + b, 0);
  let onTable = 0, aces = 0;
  for (const m of engine.table) {
    for (const card of RULES.cards[m]) onTable += VALUES[card % 13];
    const [kind, , start, length] = RULES.melds[m];
    if (kind === 1 && start === 0 && length < FULL_RUN) aces++;
  }
  const swing = DECK_VALUE * engine.decks - onTable;
  return points.map(own => {
    const lead = own - (total - own) / (n - 1);
    return [lead - swing - ACE_LIFT * aces / (n - 1), lead + swing + ACE_LIFT * aces];
  });
}

// A value inside [low, high]: a sigmoid onto the interval with slope 1 at its middle,
// mid + h tanh((v - mid) / h). Nearly unchanged well inside, exact once low == high.
export function boundValue(value, [low, high]) {
  const mid = (low + high) / 2, half = (high - low) / 2;
  return half > 1e-3 ? mid + half * Math.tanh((value - mid) / half) : mid;
}
