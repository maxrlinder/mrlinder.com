import { RULES } from './rules-data.js';

export const DRAW = 0, PLAY = 1, DONE = 2;
export const STOCK = 0, TAKE = 1, MELD_GROUP = 2, MELD_RUN = 3, LAYOFF_GROUP = 4, LAYOFF_RUN = 5, DISCARD = 6;
export const VALUES = [11, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10];
export const SUITS = ['♣', '♦', '♥', '♠'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const name = card => RANKS[card % 13] + SUITS[Math.floor(card / 13)];
const zeros = () => Array(52).fill(0);
const sum = values => values.reduce((a, b) => a + b, 0);
const index = new Map(RULES.melds.map((m, i) => [m.join(','), i]));
const run = (suit, start, length) => index.get([1, suit, length === 13 ? 0 : start % 13, length].join(','));
const action = (kind, card = 52, meld = -1) => [kind, card, meld];

function combinations(values, size) {
  const result = [];
  function choose(start, chosen) {
    if (chosen.length === size) { result.push(chosen); return; }
    for (let i = start; i < values.length; i++) choose(i + 1, [...chosen, values[i]]);
  }
  choose(0, []);
  return result;
}

export function handMelds(hand) {
  const result = [];
  for (let rank = 0; rank < 13; rank++) {
    const suits = [0, 1, 2, 3].filter(s => hand[s * 13 + rank]);
    for (let size = 3; size <= suits.length; size++) {
      for (const selected of combinations(suits, size)) result.push(index.get([0, rank, sum(selected.map(s => 1 << s)), 0].join(',')));
    }
  }
  for (let suit = 0; suit < 4; suit++) {
    const present = hand.slice(suit * 13, (suit + 1) * 13).map(Boolean);
    if (present.every(Boolean)) {
      for (let length = 3; length < 13; length++) for (let start = 0; start < 13; start++) result.push(run(suit, start, length));
      result.push(run(suit, 0, 13));
      continue;
    }
    for (let start = 0; start < 13; start++) {
      if (!present[start] || present[(start + 12) % 13]) continue;
      let arc = 0;
      while (present[(start + arc) % 13]) arc++;
      for (let offset = 0; offset < arc - 2; offset++) for (let length = 3; length <= arc - offset; length++) result.push(run(suit, start + offset, length));
    }
  }
  return result;
}

export function openingMelds(hand, melds, need) {
  if (!melds.length) return [];
  const involved = [...new Set(melds.flatMap(m => RULES.cards[m]))].sort((a, b) => a - b);
  if (sum(involved.map(c => hand[c] * VALUES[c % 13])) < need) return [];
  const slots = new Map(involved.map((c, i) => [c, i]));
  const shapes = melds.map(m => RULES.cards[m].map(c => slots.get(c)));
  const byLowest = involved.map(() => []);
  shapes.forEach((s, i) => byLowest[Math.min(...s)].push(i));
  const subtract = (state, shape) => {
    const next = [...state];
    for (const i of shape) { if (!next[i]) return null; next[i]--; }
    return next;
  };
  const memo = new Map();
  function best(state, leave) {
    const key = state.join('') + ':' + Number(leave);
    if (memo.has(key)) return memo.get(key);
    const low = state.findIndex(Boolean);
    let result;
    if (low < 0) result = leave ? -1e6 : 0;
    else {
      const skipped = [...state]; skipped[low]--;
      result = best(skipped, false);
      for (const local of byLowest[low]) {
        const rest = subtract(state, shapes[local]);
        if (rest) result = Math.max(result, RULES.points[melds[local]] + best(rest, leave));
      }
    }
    memo.set(key, result);
    return result;
  }
  const state = involved.map(c => hand[c]);
  const leave = sum(hand) === sum(state);
  return melds.filter((m, i) => {
    const rest = subtract(state, shapes[i]);
    return rest && RULES.points[m] + best(rest, leave) >= need;
  });
}

export class RummyEngine {
  constructor({ players = 3, hands, stock, pile, current, random = Math.random } = {}) {
    if (![2, 3, 4].includes(players)) throw new Error('Rummy needs 2–4 players.');
    this.players = players;
    if (!hands) {
      const deck = Array.from({ length: 104 }, (_, i) => Math.floor(i / 2));
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      hands = Array.from({ length: players }, () => { const h = zeros(); for (let i = 0; i < 13; i++) h[deck.pop()]++; return h; });
      pile = [deck.pop()]; stock = deck; current = Math.floor(random() * players);
    }
    this.hands = hands.map(h => [...h]); this.stock = [...stock]; this.pile = [...pile]; this.current = current;
    this.known = Array.from({ length: players }, zeros);
    this.pileCounts = zeros(); pile.forEach(c => this.pileCounts[c]++);
    this.table = []; this.tableCounts = zeros(); this.layable = zeros();
    this.opened = Array(players).fill(false);
    this.phase = DRAW; this.turns = 0; this.turnPoints = 0;
    this.startEmpty = true; this.startOpened = false;
    this.winner = null; this.rummy = false; this.truncated = false; this.stockOut = false;
  }
  get done() { return this.phase === DONE; }
  get top() { return this.pile.at(-1) ?? 52; }
  count(seat) { return sum(this.hands[seat]); }
  candidates() {
    if (this.done) return [];
    if (this.phase === DRAW) return [action(STOCK), ...(this.pile.length ? [action(TAKE, this.top)] : [])];
    const seat = this.current, hand = this.hands[seat], size = this.count(seat), melds = handMelds(hand);
    const result = [];
    const legal = this.opened[seat] ? melds.filter(m => RULES.cards[m].length < size) : openingMelds(hand, melds, 30 - this.turnPoints);
    for (const m of legal) result.push(action(RULES.kinds[m] ? MELD_RUN : MELD_GROUP, 52, m));
    if (!this.opened[seat] && this.turnPoints) return result;
    if (this.opened[seat] && size >= 2) {
      const seen = new Set();
      this.table.forEach((m, position) => {
        for (const [card] of RULES.extensions[m]) {
          const key = `${card},${m}`;
          if (hand[card] && !seen.has(key)) { seen.add(key); result.push(action(RULES.kinds[m] ? LAYOFF_RUN : LAYOFF_GROUP, card, position)); }
        }
      });
    }
    hand.forEach((count, card) => { if (count) result.push(action(DISCARD, card)); });
    return result;
  }
  apply(move) {
    if (!this.candidates().some(a => a.every((v, i) => v === move[i]))) throw new Error('That move is not legal.');
    const [kind, card, meld] = move, seat = this.current;
    if (this.phase === DRAW) {
      const drawn = kind === STOCK ? this.stock.pop() : this.pile.pop();
      if (kind === STOCK) this.stockOut = !this.stock.length;
      else { this.pileCounts[drawn]--; this.known[seat][drawn]++; }
      this.hands[seat][drawn]++; this.phase = PLAY;
      return { kind: kind === STOCK ? 2 : 3, actor: seat, card: drawn, meld: -1, cards: [drawn] };
    }
    if (kind === MELD_GROUP || kind === MELD_RUN) {
      const cards = RULES.cards[meld];
      cards.forEach(c => { this.remove(seat, c); this.tableCounts[c]++; });
      this.table.push(meld);
      if (!this.opened[seat]) {
        this.turnPoints += RULES.points[meld];
        if (this.turnPoints >= 30) { this.opened[seat] = true; this.turnPoints = 0; }
      }
      this.refreshLayable();
      return { kind: 4, actor: seat, card: 52, meld, cards };
    }
    if (kind === LAYOFF_GROUP || kind === LAYOFF_RUN) {
      const extended = RULES.extensions[this.table[meld]].find(([c]) => c === card)[1];
      this.remove(seat, card); this.tableCounts[card]++; this.table[meld] = extended; this.refreshLayable();
      return { kind: 5, actor: seat, card, meld: extended, cards: [card] };
    }
    this.remove(seat, card); this.pile.push(card); this.pileCounts[card]++;
    if (!this.count(seat)) { this.winner = seat; this.rummy = !this.startOpened && this.startEmpty; this.phase = DONE; }
    else {
      this.turns++;
      if (this.stockOut || this.turns >= 200) { this.phase = DONE; this.truncated = !this.stockOut; }
      else { this.current = (seat + 1) % this.players; this.phase = DRAW; this.turnPoints = 0; this.startEmpty = !this.table.length; this.startOpened = this.opened[this.current]; }
    }
    return { kind: 6, actor: seat, card, meld: -1, cards: [card] };
  }
  remove(seat, card) { this.hands[seat][card]--; if (this.known[seat][card]) this.known[seat][card]--; }
  refreshLayable() { this.layable = zeros(); for (const m of this.table) for (const [c] of RULES.extensions[m]) this.layable[c] = 1; }
  penalties() { return this.hands.map(h => sum(h.map((n, c) => n * VALUES[c % 13]))); }
  scores() {
    const p = this.penalties(), factor = this.rummy ? 2 : 1, scores = p.map(v => -factor * v);
    if (this.winner !== null) scores[this.winner] = factor * (sum(p) - p[this.winner]);
    return scores;
  }
  viewPairs() {
    return Array.from({ length: this.players }, (_, viewer) => Array.from({ length: 52 }, (_, card) => {
      const locs = [];
      for (let n = 0; n < this.tableCounts[card]; n++) locs.push(5);
      for (let n = 0; n < this.pileCounts[card] - Number(this.top === card); n++) locs.push(6);
      if (this.top === card) locs.push(7);
      for (let j = 0; j < this.players; j++) {
        const seat = (viewer + j) % this.players;
        const copies = j === 0 ? this.hands[seat][card] : this.known[seat][card];
        for (let n = 0; n < copies; n++) locs.push(1 + j);
      }
      while (locs.length < 2) locs.push(0);
      locs.sort((a, b) => a - b);
      const [a, b] = locs;
      return a * 8 - a * (a - 1) / 2 + b - a;
    }));
  }
}

export function candidateFeatures(engine, actions) {
  const kind = [], cards = [], target = [];
  for (const [k, c, m] of actions) {
    kind.push(k);
    const moved = (k === MELD_GROUP || k === MELD_RUN) ? RULES.cards[m] : c !== 52 ? [c] : [];
    const aimed = (k === LAYOFF_GROUP || k === LAYOFF_RUN) ? RULES.cards[engine.table[m]] : [];
    cards.push([...moved, ...Array(13 - moved.length).fill(52)]);
    target.push([...aimed, ...Array(13 - aimed.length).fill(52)]);
  }
  return { kind, cards, target };
}

export class ObservationWriter {
  constructor(engine) {
    this.engine = engine; this.pairs = engine.viewPairs();
    this.mover = Array.from({ length: engine.players }, zeros);
    this.reference = this.pairs.map(p => [...p]);
    this.events = 0; this.tokenEvent = Array(engine.players).fill(0);
    this.drawn = Array.from({ length: engine.players }, () => [0, 0, 52]);
    this.discarded = Array.from({ length: engine.players }, () => [0, 52]);
    this.last = Array(engine.players).fill(null);
  }
  record(event) {
    const pairs = this.engine.viewPairs();
    pairs.forEach((row, v) => row.forEach((pair, c) => { if (pair !== this.pairs[v][c]) this.mover[v][c] = event.actor; }));
    this.pairs = pairs; this.events++;
    if (event.kind === 2 || event.kind === 3) this.drawn[event.actor] = [this.events, event.kind === 2 ? 1 : 2, event.card];
    if (event.kind === 6) this.discarded[event.actor] = [this.events, event.card];
    this.last[event.actor] = event;
  }
  observe(seat) {
    const e = this.engine, p = e.players, last = this.last[seat];
    const head = [Number(e.phase === PLAY), last?.kind ?? 0, last?.card ?? 52, last?.meld >= 0 ? RULES.kinds[last.meld] : 2, last?.meld >= 0 ? RULES.cards[last.meld].length : 0];
    const draws = [], takes = [], discards = [];
    for (let j = 1; j < 4; j++) {
      const opponent = (seat + j) % p, [at, kind, card] = this.drawn[opponent], [discardAt, discard] = this.discarded[opponent];
      draws.push(j >= p ? 3 : at > this.tokenEvent[seat] ? kind : 0);
      takes.push(j < p && at > this.tokenEvent[seat] && kind === 2 ? card : 52);
      discards.push(j < p && discardAt > this.tokenEvent[seat] ? discard : 52);
    }
    const hand = Array.from({ length: 4 }, (_, j) => j < p ? e.count((seat + j) % p) : 31);
    const opened = sum(Array.from({ length: p }, (_, j) => e.opened[(seat + j) % p] ? 1 << j : 0));
    const ledger = this.pairs[seat].map((pair, c) => pair + 36 * ((pair !== this.reference[seat][c] ? 1 + (this.mover[seat][c] - seat + p) % p : 0) + 5 * e.layable[c]));
    this.reference[seat] = [...this.pairs[seat]]; this.tokenEvent[seat] = this.events;
    return [...head, ...draws, ...takes, ...discards, e.stock.length, ...hand, opened, Math.min(e.turnPoints, 29), p, Math.min(Math.floor(e.turns / p), 63), 52, ...ledger];
  }
}
