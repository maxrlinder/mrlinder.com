// What each seat's deal points against the table can still be: the interval the
// value probe is mapped into before Advantage shows it, as in training
// (cardgym hjarter/bounds.py and rl/ppo.py bound_values; the gym's tests and
// scripts/check-hjarter.mjs hold the two to the same numbers).
//
// A deal's return for seat i is the other seats' average points minus its own,
// (T - P * points_i) / (P - 1) with T the table's total. Every token carries what
// bounds it: the penalty points each seat has taken, the jack rule and J♦'s taker.
// The deal can still end without a moon (the points left go anywhere; 25 at most
// for one seat, 26 is a moon) or, while every point taken is one seat's, in that
// seat's moon (0 for it, 26 for the rest). Who holds which card is ignored, so the
// bounds are loose early and exact once the last card is out.
import { MAX_PLAYERS } from './engine.js?v=1';
import { F_JACK, F_PLAYERS, F_RULE_JACK, F_TAKEN } from './tokens.js?v=1';

const MOON = 26, JACK = -10, SEAT_NA = MAX_PLAYERS;

// [low, high] of every seat's deal return, from the points taken so far and J♦'s taker (-1: none yet).
export function dealBounds(taken, jackRule, jackTaker) {
  const players = taken.length, sum = taken.reduce((a, b) => a + b, 0), left = MOON - sum;
  const table = jackRule ? JACK : 0;
  const jack = seat => (!jackRule ? [0, 0] : jackTaker >= 0 ? (jackTaker === seat ? [JACK, JACK] : [0, 0]) : [JACK, 0]);
  const relative = (points, total) => (total - players * points) / (players - 1);
  const noMoon = left > 0 || Math.max(...taken) < MOON;
  return taken.map((own, seat) => {
    const [fewest, most] = jack(seat);
    let low = Infinity, high = -Infinity;
    if (noMoon) {
      const mostPoints = own + left < MOON ? own + left : MOON - 1;
      high = Math.max(high, relative(own + fewest, MOON + table));
      low = Math.min(low, relative(mostPoints + most, MOON + table));
    }
    for (let shooter = 0; shooter < players; shooter++) {
      if (sum - taken[shooter]) continue;
      const total = MOON * (players - 1) + table, base = shooter === seat ? 0 : MOON;
      high = Math.max(high, relative(base + fewest, total));
      low = Math.min(low, relative(base + most, total));
    }
    return [low, high];
  });
}

// The bounds a token row implies, seat by seat in the row's own frame (slot 0 the viewer).
export function tokenBounds(row) {
  const players = row[F_PLAYERS], taken = [];
  for (let rel = 0; rel < players; rel++) taken.push(row[F_TAKEN + rel]);
  return dealBounds(taken, Boolean(row[F_RULE_JACK]), row[F_JACK] === SEAT_NA ? -1 : row[F_JACK]);
}

// A value inside [low, high]: a sigmoid onto the interval with slope 1 at its middle,
// mid + h tanh((v - mid) / h). Nearly unchanged well inside, exact once low == high.
export function boundValue(value, [low, high]) {
  const mid = (low + high) / 2, half = (high - low) / 2;
  return half > 1e-3 ? mid + half * Math.tanh((value - mid) / half) : mid;
}
