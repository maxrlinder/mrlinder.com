// Rule-based Hjärter players, a port of cardgym/games/hjarter/heuristic.py.
// Each reads only its own hand and public play. They hold the computer seats
// until the self-play agent is trained.
//
// `heuristicCard` plays the textbook game: pass Q♠ (unless spades protect it),
// high spades and high hearts, then high cards of short suits; flush the queen
// with spades below it; duck under the winning card with the highest card that
// still ducks; take point-free tricks last with a high card; discard Q♠, then
// high spades while Q♠ is out, then high hearts, then the highest card of the
// shortest suit. It never tries to take the moon or to stop one.

import { HEARTS, SPADES, NUM_RANKS, PASS, QUEEN_OF_SPADES, rankOf, suitOf } from './engine.js?v=1';

const QUEEN = rankOf(QUEEN_OF_SPADES);
const count = (hand, suit) => hand.filter(c => suitOf(c) === suit).length;

// Python's max and min over a list: the first of the best, in list order.
function best(items, key, better) {
  let pick = items[0], top = key(pick);
  for (const item of items.slice(1)) {
    const value = key(item);
    if (better(value, top)) { pick = item; top = value; }
  }
  return pick;
}
const compare = (a, b) => (Array.isArray(a) ? (a[0] - b[0]) || (a[1] - b[1]) : a - b);
const maxBy = (items, key = c => c) => best(items, key, (a, b) => compare(a, b) > 0);
const minBy = (items, key = c => c) => best(items, key, (a, b) => compare(a, b) < 0);

export function randomCard(engine) {
  const legal = engine.legalCards();
  return legal[Math.floor(Math.random() * legal.length)];
}

export function heuristicCard(engine) {
  const legal = engine.legalCards();
  if (legal.length === 1) return legal[0];
  if (engine.phase === PASS) return passCard(engine, legal);
  if (!engine.trick.length) return leadCard(engine, legal);
  if (suitOf(legal[0]) === engine.led) return followCard(engine, legal);
  return discardCard(engine, legal);
}

function passCard(engine, legal) {
  const hand = engine.held, spades = count(hand, SPADES);
  const danger = c => {
    const suit = suitOf(c), rank = rankOf(c);
    if (suit === SPADES && rank >= QUEEN) return spades >= 5 ? 20 + rank : 100 + rank;
    if (suit === HEARTS) return rank >= 7 ? 30 + 2 * rank : rank;
    return 2 * rank + (count(hand, suit) <= 2 ? 12 : 0);
  };
  return maxBy(legal, danger);
}

const queenPlayed = engine => engine.played.includes(QUEEN_OF_SPADES);
// Q♠ is still to be played and not in my hand.
const queenOut = engine => !queenPlayed(engine) && !engine.held.includes(QUEEN_OF_SPADES);

function leadCard(engine, legal) {
  if (queenOut(engine)) {
    const flush = legal.filter(c => suitOf(c) === SPADES && rankOf(c) < QUEEN);
    if (flush.length) return maxBy(flush);
  }
  const hand = engine.held, queenLive = !queenPlayed(engine);
  const safe = legal.filter(c => suitOf(c) !== HEARTS && !(queenLive && suitOf(c) === SPADES && rankOf(c) >= QUEEN));
  return minBy(safe.length ? safe : legal, c => [rankOf(c), count(hand, suitOf(c))]);
}

function followCard(engine, legal) {
  const led = engine.led;
  const winning = Math.max(...engine.trick.filter(([, c]) => suitOf(c) === led).map(([, c]) => rankOf(c)));
  const under = legal.filter(c => rankOf(c) < winning);
  if (under.length) return maxBy(under);
  const last = engine.trick.length === engine.players - 1;
  const points = engine.trick.some(([, c]) => suitOf(c) === HEARTS || c === QUEEN_OF_SPADES);
  const kept = legal.filter(c => c !== QUEEN_OF_SPADES);
  const keep = kept.length ? kept : legal;
  return last && !points ? maxBy(keep) : minBy(keep);
}

function discardCard(engine, legal) {
  if (legal.includes(QUEEN_OF_SPADES)) return QUEEN_OF_SPADES;
  if (!queenPlayed(engine)) {
    const highSpades = legal.filter(c => suitOf(c) === SPADES && rankOf(c) > QUEEN);
    if (highSpades.length) return maxBy(highSpades);
  }
  const hearts = legal.filter(c => suitOf(c) === HEARTS);
  if (hearts.length) return maxBy(hearts);
  const hand = engine.held;
  // High cards first, from short suits (a long suit's high card is less urgent).
  return maxBy(legal, c => {
    const length = count(hand, suitOf(c));
    return [rankOf(c) - Math.floor(NUM_RANKS / 2) * (length > 3 ? 1 : 0), -length];
  });
}
