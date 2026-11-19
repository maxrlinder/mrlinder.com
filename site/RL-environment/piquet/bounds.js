// What each seat's return can still be: the interval the value head's reading is
// mapped into before Advantage shows it, as in training (cardgym piquet/bounds.py
// and rl/ppo.py bound_values; scripts/check-bounds.mjs holds the two to the same
// numbers).
//
// From public information only, a seat can still add this deal: 10 for carte
// blanche during the exchange; 8 (point), 32 (sequences), 42 (sets) for each
// category not yet settled; 60 for repique while the declarations are on and the
// opponent has scored nothing, else 30 for pique (Elder only); 1 per trick left
// and 1 for the last; 40 for capot while the opponent has no trick, else 10 while
// seven tricks are in reach. A deal's return is the point difference; a partie's
// Rubicon payoff takes up to DEAL_MOST more per seat for each deal still to come,
// and its extremes lie at the corners of the reachable totals, on the 99/100
// line, or either side of a tie.
import { EXCHANGE, DECLARE, PLAY, DONE } from './engine.js?v=2';

const TRICKS = 12, CARTE_BLANCHE = 10, CATEGORY_MOST = [8, 32, 42], REPIQUE = 60, PIQUE = 30, CARDS = 10, CAPOT = 40;
export const DEAL_MOST = CARTE_BLANCHE + 8 + 32 + 42 + REPIQUE + TRICKS + 1 + CAPOT, RUBICON = 100;

// The most each seat can still add to its points this deal.
export function dealMost(engine) {
  if (engine.phase === DONE) return [0, 0];
  return [0, 1].map(seat => {
    const other = 1 - seat, { repique, pique } = engine.result;
    let most = 0;
    if (engine.phase === EXCHANGE) most += CARTE_BLANCHE + CATEGORY_MOST.reduce((a, b) => a + b, 0);
    else if (engine.phase === DECLARE) most += CATEGORY_MOST.slice(engine.category).reduce((a, b) => a + b, 0);
    if (repique < 0 && pique < 0 && engine.points[other] === 0) {
      if (engine.phase === EXCHANGE || engine.phase === DECLARE) most += REPIQUE;
      else if (seat === engine.elder) most += PIQUE;
    }
    const left = engine.phase === PLAY ? TRICKS - engine.trickIndex : TRICKS;
    most += left + (left ? 1 : 0);
    if (engine.tricks[other] === 0) most += CAPOT;
    else if (engine.tricks[seat] + left > TRICKS / 2) most += CARDS;
    return most;
  });
}

// Seat 0's Rubicon payoff for these final totals.
export function payoff(mine, theirs) {
  if (mine === theirs) return 0;
  const high = Math.max(mine, theirs), low = Math.min(mine, theirs);
  const value = RUBICON + (low >= RUBICON ? high - low : high + low);
  return mine > theirs ? value : -value;
}

// [low, high] of seat 0's payoff with final totals in [mine, mine + mineMost] x [theirs, theirs + theirsMost].
export function partieBounds(mine, mineMost, theirs, theirsMost) {
  const inX = x => x >= mine && x <= mine + mineMost, inY = y => y >= theirs && y <= theirs + theirsMost;
  const xs = [mine, mine + mineMost, RUBICON - 1, RUBICON].filter(inX), ys = [theirs, theirs + theirsMost, RUBICON - 1, RUBICON].filter(inY);
  let low = Infinity, high = -Infinity;
  const visit = (x, y) => { const v = payoff(x, y); if (v < low) low = v; if (v > high) high = v; };
  for (const x of xs) for (const y of ys) visit(x, y);
  for (const x of xs) for (const y of [x - 1, x, x + 1]) if (inY(y)) visit(x, y);
  for (const y of ys) for (const x of [y - 1, y, y + 1]) if (inX(x)) visit(x, y);
  return [low, high];
}

// [low, high] of each seat's return, absolute seats: this deal's point difference
// (`partie` false), or the Rubicon payoff of a partie of `deals` deals.
export function seatBounds(engine, { partie = engine.rubicon, deals = 6 } = {}) {
  const most = dealMost(engine);
  if (!partie) {
    const lead = engine.points[0] - engine.points[1];
    return [[lead - most[1], lead + most[0]], [-lead - most[0], -lead + most[1]]];
  }
  const later = (deals - engine.dealIndex - 1) * DEAL_MOST;
  const totals = [0, 1].map(seat => engine.totals[seat] + engine.points[seat]);
  return [
    partieBounds(totals[0], most[0] + later, totals[1], most[1] + later),
    partieBounds(totals[1], most[1] + later, totals[0], most[0] + later),
  ];
}

// A value inside [low, high]: a sigmoid onto the interval with slope 1 at its middle,
// mid + h tanh((v - mid) / h). Nearly unchanged well inside, exact once low == high.
export function boundValue(value, [low, high]) {
  const mid = (low + high) / 2, half = (high - low) / 2;
  return half > 1e-3 ? mid + half * Math.tanh((value - mid) / half) : mid;
}
