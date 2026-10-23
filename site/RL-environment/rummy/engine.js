// A port of cardgym's Rummy (r7 rules): engine, candidate features and token
// writer. scripts/check-rummy.mjs replays Python games through it and compares
// every legal move list, feature and token, so keep the orders identical.
import { RULES } from './rules-data.js';

export const DRAW = 0, PLAY = 1, DONE = 2;
export const STOCK = 0, TAKE = 1, MELD_GROUP = 2, MELD_RUN = 3, LAYOFF_GROUP = 4, LAYOFF_RUN = 5, DISCARD = 6;
export const EVENT_STOCK = 2, EVENT_TAKE = 3, EVENT_MELD = 4, EVENT_LAYOFF = 5, EVENT_DISCARD = 6;
export const NO_CARD = 52, HAND_SIZE = 7, MAX_TURNS = 200;
export const VALUES = [11, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10];
export const SUITS = ['♣', '♦', '♥', '♠'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const name = card => RANKS[card % 13] + SUITS[Math.floor(card / 13)];
const zeros = () => Array(52).fill(0);
const mod13 = n => ((n % 13) + 13) % 13;
const sum = values => values.reduce((a, b) => a + b, 0);
const index = new Map(RULES.melds.map((m, i) => [m.join(','), i]));
const run = (suit, start, length) => index.get([1, suit, length === 13 ? 0 : ((start % 13) + 13) % 13, length].join(','));
const action = (kind, card = NO_CARD, meld = -1) => [kind, card, meld];
const MELDS_WITH = Array.from({ length: 52 }, (_, card) => RULES.cards.flatMap((cards, m) => cards.includes(card) ? [m] : []));

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
    if (present.filter(Boolean).length < 3) continue;
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

// Whether the hand forms a meld containing `card` that leaves a card to discard.
export function canMeld(hand, card) {
  const total = sum(hand);
  if (total >= 4) {
    const suit = Math.floor(card / 13), rank = card % 13;
    if ([0, 1, 2, 3].filter(other => other !== suit && hand[other * 13 + rank]).length >= 2) return true;
    const base = suit * 13;
    let below = 0, above = 0;
    while (below < 12 && hand[base + (rank - below - 1 + 26) % 13]) below++;
    while (above < 12 - below && hand[base + (rank + above + 1) % 13]) above++;
    return below + above >= 2;
  }
  return MELDS_WITH[card].some(m => RULES.cards[m].length < total && RULES.cards[m].every(c => hand[c] >= 1));
}

export class RummyEngine {
  constructor({ players = 3, decks = 1, hands, stock, pile, current, random = Math.random } = {}) {
    if (![2, 3, 4].includes(players)) throw new Error('Rummy needs 2–4 players.');
    if (![1, 2].includes(decks)) throw new Error('Rummy uses one or two decks.');
    this.players = players; this.decks = decks;
    if (!hands) {
      const deck = Array.from({ length: 52 * decks }, (_, i) => i % 52);
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      hands = Array.from({ length: players }, () => { const h = zeros(); for (let i = 0; i < HAND_SIZE; i++) h[deck.pop()]++; return h; });
      pile = [deck.pop()]; stock = deck; current = Math.floor(random() * players);
    }
    this.hands = hands.map(h => [...h]); this.stock = [...stock]; this.pile = [...pile]; this.current = current;
    this.known = Array.from({ length: players }, zeros);
    this.placed = Array.from({ length: players }, zeros);
    this.points = Array(players).fill(0);
    this.table = []; this.layable = zeros();
    this.opened = Array(players).fill(true);
    this.phase = DRAW; this.turns = 0; this.turnPoints = 0; this.obligation = NO_CARD;
    this.kept = NO_CARD;  // the discard top taken this turn: it may be used or kept, not discarded
    this.winner = null; this.truncated = false; this.stockOut = false; this.cached = null;
  }
  get done() { return this.phase === DONE; }
  get top() { return this.pile.at(-1) ?? NO_CARD; }
  count(seat) { return sum(this.hands[seat]); }
  candidates() {
    if (!this.cached) {
      if (this.phase === DRAW) this.cached = this.drawCandidates();
      else if (this.phase === PLAY) {
        const actions = this.playCandidates(this.current, this.hands[this.current]), card = this.obligation;
        if (card === NO_CARD) this.cached = actions;
        else {
          // The obligated card's own melds and lay-offs, and the lay-offs that start a chain to it.
          const chains = this.chains(this.hands[this.current], card);
          this.cached = actions.filter(a => uses(a, card) || (a[0] === LAYOFF_RUN && chains.has(`${a[2]},${a[1]}`)));
        }
      } else this.cached = [];
    }
    return this.cached;
  }
  drawCandidates() {
    const actions = [action(STOCK)];
    if (!this.pile.length) return actions;
    const hand = [...this.hands[this.current]];
    // The taken top cannot go back this turn, so another card must be there to discard.
    if (sum(hand) > hand[this.top]) actions.push(action(TAKE, this.top, 0));
    hand[this.top]++;
    for (let above = 1; above < this.pile.length; above++) {
      const card = this.pile[this.pile.length - 1 - above];
      hand[card]++;
      if (this.layable[card] || canMeld(hand, card) || this.chains(hand, card).size) actions.push(action(TAKE, card, above));
    }
    return actions;
  }
  // "position,first card" of every lay-off chain that extends a table run of the
  // card's suit, one hand card at a time, until `card` fits its end
  // (2-3-4 on the table, 5 in hand: lay off 5, then 6).
  chains(hand, card) {
    const suit = Math.floor(card / 13), rank = card % 13, size = sum(hand), starts = new Set();
    this.table.forEach((index, position) => {
      const [kind, runSuit, start, length] = RULES.melds[index];
      if (kind !== 1 || runSuit !== suit || length === 13) return;
      for (const [step, end] of [[1, start + length - 1], [-1, start]]) {
        const between = mod13((rank - end) * step) - 1;  // hand cards needed before `card`
        if (between < 1 || length + between + 1 > 13 || between + 1 >= size) continue;
        let held = true;
        for (let i = 1; i <= between; i++) if (!hand[suit * 13 + mod13(end + step * i)]) held = false;
        if (held) starts.add(`${position},${suit * 13 + mod13(end + step)}`);
      }
    });
    return starts;
  }
  playCandidates(seat, hand) {
    const size = sum(hand), actions = [], kept = this.kept;
    // Cards that may be discarded: the turn must always be able to end.
    const spare = size - (kept === NO_CARD ? 0 : hand[kept]);
    const leavesDiscard = cards => kept === NO_CARD ? cards.length < spare : spare - cards.filter(c => c !== kept).length >= 1;
    // Melds go down three cards at a time and every further card is its own lay-off
    // (4-5-6, then 7), so each outcome has one route and each extra card is a decision.
    for (const m of handMelds(hand)) if (RULES.cards[m].length === 3 && RULES.cards[m].length < size && leavesDiscard(RULES.cards[m])) actions.push(action(RULES.kinds[m] ? MELD_RUN : MELD_GROUP, NO_CARD, m));
    if (size >= 2) {
      const seen = new Set();
      this.table.forEach((m, position) => {
        for (const [card] of RULES.extensions[m]) {
          // Identical table melds give identical outcomes.
          if (hand[card] && !seen.has(`${card},${m}`) && leavesDiscard([card])) { seen.add(`${card},${m}`); actions.push(action(RULES.kinds[m] ? LAYOFF_RUN : LAYOFF_GROUP, card, position)); }
        }
      });
    }
    hand.forEach((n, card) => { if (n && card !== kept) actions.push(action(DISCARD, card)); });
    return actions;
  }
  apply(move) {
    if (!this.candidates().some(a => a.every((v, i) => v === move[i]))) throw new Error('That move is not legal.');
    const [kind, card, meld] = move, seat = this.current;
    this.cached = null;
    if (this.phase === DRAW) {
      let event;
      if (kind === STOCK) {
        const drawn = this.stock.pop();
        this.hands[seat][drawn]++; this.stockOut = !this.stock.length;
        event = { kind: EVENT_STOCK, actor: seat, card: drawn, meld: -1, cards: [drawn] };
      } else {
        const taken = this.pile.splice(this.pile.length - 1 - meld).reverse();  // top first
        for (const c of taken) { this.known[seat][c]++; this.hands[seat][c]++; }
        if (meld) this.obligation = card; else this.kept = card;
        event = { kind: EVENT_TAKE, actor: seat, card, meld: -1, cards: taken };
      }
      this.phase = PLAY;
      return event;
    }
    if (kind === MELD_GROUP || kind === MELD_RUN) {
      const cards = RULES.cards[meld];
      for (const c of cards) this.place(seat, c);
      this.table.push(meld); this.points[seat] += RULES.points[meld];
      if (cards.includes(this.obligation)) this.obligation = NO_CARD;
      this.refreshLayable();
      return { kind: EVENT_MELD, actor: seat, card: NO_CARD, meld, cards };
    }
    if (kind === LAYOFF_GROUP || kind === LAYOFF_RUN) {
      const before = this.table[meld], extended = RULES.extensions[before].find(([c]) => c === card)[1];
      this.place(seat, card); this.table[meld] = extended;
      this.points[seat] += RULES.points[extended] - RULES.points[before];
      if (this.obligation === card) this.obligation = NO_CARD;
      this.refreshLayable();
      return { kind: EVENT_LAYOFF, actor: seat, card, meld: extended, cards: [card] };
    }
    this.remove(seat, card); this.pile.push(card);
    if (!this.count(seat)) { this.winner = seat; this.phase = DONE; }
    else {
      this.turns++;
      if (this.stockOut) this.phase = DONE;
      else if (this.turns >= MAX_TURNS) { this.truncated = true; this.phase = DONE; }
      else { this.current = (seat + 1) % this.players; this.phase = DRAW; this.turnPoints = 0; this.kept = NO_CARD; }
    }
    return { kind: EVENT_DISCARD, actor: seat, card, meld: -1, cards: [card] };
  }
  place(seat, card) { this.remove(seat, card); this.placed[seat][card]++; }
  // Public knowledge only shrinks: observers cannot tell which copy left.
  remove(seat, card) { this.hands[seat][card]--; if (this.known[seat][card]) this.known[seat][card]--; }
  refreshLayable() { this.layable = zeros(); for (const m of this.table) for (const [c] of RULES.extensions[m]) this.layable[c] = 1; }
  penalties() { return this.hands.map(h => sum(h.map((n, c) => n * VALUES[c % 13]))); }
  scores() { const p = this.penalties(); return this.points.map((v, s) => v - p[s]); }
  // Where both copies of each card type are, as `seat` knows for certain: unordered pair codes.
  viewPairs(seat) {
    const counts = Array.from({ length: LOCATIONS }, zeros);
    this.pile.forEach((c, i) => counts[LOC_PILE + Math.min(this.pile.length - 1 - i, PILE_DEPTHS - 1)][c]++);
    counts[LOC_ABSENT].fill(2 - this.decks);
    for (let j = 0; j < this.players; j++) {
      const other = (seat + j) % this.players;
      counts[1 + j] = j ? [...this.known[other]] : [...this.hands[seat]];
      counts[LOC_TABLE + j] = [...this.placed[other]];
    }
    return Array.from({ length: 52 }, (_, c) => {
      let a = -1, b = -1, seen = 0;
      for (let loc = 1; loc < LOCATIONS && b < 0; loc++) {
        seen += counts[loc][c];
        if (a < 0 && seen >= 1) a = loc;
        if (seen >= 2) b = loc;
      }
      // Copies not placed anywhere are unseen (location 0, first in order).
      if (a < 0) a = b = 0; else if (b < 0) { b = a; a = 0; }
      return a * LOCATIONS - a * (a - 1) / 2 + b - a;
    });
  }
}

const uses = ([kind, card, meld], obligated) => (kind === MELD_GROUP || kind === MELD_RUN) ? RULES.cards[meld].includes(obligated) : (kind === LAYOFF_GROUP || kind === LAYOFF_RUN) && card === obligated;

// Locations of a card copy: unseen, hands (self, then known opponent copies),
// table by who placed it, discard pile by depth, and absent with one deck.
const LOC_TABLE = 5, LOC_PILE = 9, PILE_DEPTHS = 11, LOC_ABSENT = 20, LOCATIONS = 21, PAIRS = 231;

export function candidateFeatures(engine, actions) {
  const kind = [], cards = [], target = [];
  for (const [k, c, m] of actions) {
    kind.push(k);
    const moved = (k === MELD_GROUP || k === MELD_RUN) ? RULES.cards[m] : c !== NO_CARD ? [c] : [];
    const aimed = (k === LAYOFF_GROUP || k === LAYOFF_RUN) ? RULES.cards[engine.table[m]] : [];
    cards.push([...moved, ...Array(13 - moved.length).fill(NO_CARD)]);
    target.push([...aimed, ...Array(13 - aimed.length).fill(NO_CARD)]);
  }
  if (engine.phase !== DRAW) return { kind, cards, target };
  // Copies of each card type each draw would take from the pile.
  const taken = actions.map(([k, , above]) => {
    const row = zeros();
    if (k === TAKE) for (const c of engine.pile.slice(engine.pile.length - 1 - above)) row[c]++;
    return row;
  });
  return { kind, cards, target, taken };
}

// Token layout (cardgym tokens.py): 26 fields, then 52 per-card codes.
const KIND_TURN = 1, PHASE_TURN = 2, NO_MELD_KIND = 2, ABSENT_SEAT = 63, MAX_COUNT = 62;
const DRAW_NONE = 0, DRAW_STOCK = 1, DRAW_TOP = 2, DRAW_DEEP = 3;
const EVENT_BASE = 2 * PAIRS, EVENT_PLACE = [1, 3, 6, 18, 54];  // taken, stocked, melded, laid off, discarded
const EVENT_MAX = [2, 1, 2, 2, 1];
const TAKEN = 0, STOCKED = 1, MELDED = 2, LAID = 3, DISCARDED = 4;

export class ObservationWriter {
  constructor(engine) {
    this.engine = engine; this.players = engine.players;
    this.last = Array(engine.players).fill(null);
    this.newTurn();
  }
  newTurn() {
    this.counts = Array.from({ length: 5 }, zeros);
    this.draw = DRAW_NONE; this.drawn = NO_CARD; this.taken = 0; this.melds = 0; this.layoffs = 0;
  }
  counters(seat) {
    const e = this.engine, p = this.players;
    const hand = Array.from({ length: 4 }, (_, j) => j < p ? Math.min(e.count((seat + j) % p), MAX_COUNT) : ABSENT_SEAT);
    const opened = sum(Array.from({ length: p }, (_, j) => e.opened[(seat + j) % p] ? 1 << j : 0));
    return [e.stock.length, Math.min(e.pile.length, MAX_COUNT), ...hand, opened, p, e.decks, Math.min(Math.floor(e.turns / p), 63)];
  }
  // Note an event; when it ends a turn, return each seat's turn token (the actor's row is unused zeros).
  record(event) {
    this.last[event.actor] = event;
    const counts = this.counts;
    if (event.kind === EVENT_STOCK) { this.draw = DRAW_STOCK; this.drawn = event.card; counts[STOCKED][event.card]++; }
    else if (event.kind === EVENT_TAKE) {
      this.draw = event.cards.length === 1 ? DRAW_TOP : DRAW_DEEP; this.drawn = event.card; this.taken = event.cards.length;
      for (const c of event.cards) counts[TAKEN][c]++;
    } else if (event.kind === EVENT_MELD) { this.melds++; for (const c of event.cards) counts[MELDED][c]++; }
    else if (event.kind === EVENT_LAYOFF) { this.layoffs++; counts[LAID][event.card]++; }
    if (event.kind !== EVENT_DISCARD) return null;
    counts[DISCARDED][event.card]++;
    // Opponents never see what a stock draw was.
    const codes = Array.from({ length: 52 }, (_, c) => EVENT_BASE + [TAKEN, MELDED, LAID, DISCARDED].reduce((code, slot) => code + EVENT_PLACE[slot] * Math.min(counts[slot][c], EVENT_MAX[slot]), 0));
    const taken = this.draw === DRAW_STOCK ? NO_CARD : this.drawn, actor = event.actor;
    const rows = Array.from({ length: this.players }, (_, seat) => seat === actor ? Array(78).fill(0) : [
      KIND_TURN, PHASE_TURN, 0, NO_CARD, NO_MELD_KIND, 0, 0, NO_CARD, (actor - seat + this.players) % this.players, this.draw,
      taken, Math.min(this.taken, MAX_COUNT), event.card, Math.min(this.melds, 7), Math.min(this.layoffs, 15),
      ...this.counters(seat), NO_CARD, ...codes,
    ]);
    this.newTurn();
    return rows;
  }
  // The seat's decision token now.
  observe(seat) {
    const e = this.engine, last = this.last[seat];
    const head = [0, Number(e.phase === PLAY), last?.kind ?? 0, last?.card ?? NO_CARD,
      last && last.meld >= 0 ? RULES.kinds[last.meld] : NO_MELD_KIND, last && last.meld >= 0 ? RULES.cards[last.meld].length : 0,
      Math.min(e.turnPoints, 29), e.obligation, 0, DRAW_NONE, NO_CARD, 0, NO_CARD, 0, 0];
    const codes = e.viewPairs(seat).map((pair, c) => pair + PAIRS * e.layable[c]);
    return [...head, ...this.counters(seat), NO_CARD, ...codes];
  }
}
