// What each seat's round score against the table can still be: the interval the
// value head's readings are mapped into before the page shows them, as in training
// (cardgym plump/bounds.py and rl/ppo.py bound_values; scripts/check-bounds.mjs
// holds the two to the same numbers).
//
// A seat scores 10 + bid when it takes exactly its bid (5 for a bid of 0), else 0.
// Before its bid it can still end anywhere from 0 to 10 + hand size; after it, a
// hit stays possible while won <= bid <= won + tricks left, and a miss while a
// trick is left or won != bid. A seat's return (its score minus the others'
// average) pairs its best with every other seat's worst, and the reverse.
const HIT = 10, ZERO_HIT = 5, MISS = 0;
const hit = bid => (bid === 0 ? ZERO_HIT : HIT + bid);

// [lowest, highest] round score each seat can still end with, absolute seats.
export function roundScores(round, players) {
  const done = round.tricks.filter(trick => trick.winner !== null && trick.winner !== undefined).length;
  const left = round.handSize - done;
  return Array.from({ length: players }, (_, seat) => {
    const bid = round.bids.find(item => item.player === seat)?.value;
    if (bid === undefined || bid === null) return [MISS, Math.max(MISS, ZERO_HIT, hit(round.handSize))];
    const won = round.tricksWon[seat], canHit = won <= bid && bid <= won + left, canMiss = left > 0 || won !== bid;
    const scores = [...(canHit ? [hit(bid)] : []), ...(canMiss ? [MISS] : [])];
    return [Math.min(...scores), Math.max(...scores)];
  });
}

// [low, high] of each seat's return, in `viewer`'s frame (slot 0 the viewer), as the value head reads seats.
export function viewerBounds(round, players, viewer) {
  const scores = roundScores(round, players);
  const lows = scores.reduce((a, [low]) => a + low, 0), highs = scores.reduce((a, [, high]) => a + high, 0);
  const absolute = scores.map(([low, high]) => [low - (highs - high) / (players - 1), high - (lows - low) / (players - 1)]);
  return absolute.map((_, rel) => absolute[(viewer + rel) % players]);
}

// A value inside [low, high]: a sigmoid onto the interval with slope 1 at its middle,
// mid + h tanh((v - mid) / h). Nearly unchanged well inside, exact once low == high.
export function boundValue(value, [low, high]) {
  const mid = (low + high) / 2, half = (high - low) / 2;
  return half > 1e-3 ? mid + half * Math.tanh((value - mid) / half) : mid;
}
