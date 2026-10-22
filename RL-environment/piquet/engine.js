// Piquet for the browser: a line-for-line port of cardgym's piquet engine
// (cards.py, rules.py, engine.py) and its token writer (tokens.py), one deal
// at a time, as the agent was trained. scripts/check-piquet.mjs replays Python
// deals through it and compares every legal action and every token.

// ---- Cards ----------------------------------------------------------------
// A card is suit * 8 + rank (rank 0 is the 7, rank 7 the Ace); a hand is a
// 32-bit mask, one byte per suit. Masks are kept unsigned (>>> 0).
export const NUM_SUITS = 4, NUM_RANKS = 8, NUM_CARDS = 32, NO_CARD = 32;
export const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUITS = ['♠', '♥', '♦', '♣'];
export const SUIT_WORDS = ['spades', 'hearts', 'diamonds', 'clubs'];
export const TEN = 3, JACK = 4, QUEEN = 5, KING = 6, ACE = 7;
const POINT_VALUES = [7, 8, 9, 10, 10, 10, 10, 11];
export const suitOf = card => card >> 3;
export const rankOf = card => card & 7;
export const cardId = (suit, rank) => suit * NUM_RANKS + rank;
export const bit = card => (1 << card) >>> 0;
export const has = (mask, card) => ((mask >>> card) & 1) === 1;
export const name = card => RANKS[rankOf(card)] + SUITS[suitOf(card)];
export const isRed = card => suitOf(card) === 1 || suitOf(card) === 2;
export const popcount = mask => { let n = 0; for (let m = mask >>> 0; m; m = (m & (m - 1)) >>> 0) n++; return n; };
export const cardsOf = mask => { const out = []; for (let c = 0; c < NUM_CARDS; c++) if (has(mask, c)) out.push(c); return out; };
export const maskOf = cards => cards.reduce((m, c) => (m | bit(c)) >>> 0, 0);
export const suitBits = (mask, suit) => (mask >>> (suit * NUM_RANKS)) & 0xFF;
export const suitMask = suit => (0xFF << (suit * NUM_RANKS)) >>> 0;
export const FACE_MASK = maskOf([0, 1, 2, 3].flatMap(s => [JACK, QUEEN, KING].map(r => cardId(s, r))));

// ---- Declarations (rules.py) ------------------------------------------------
export const POINT = 0, SEQUENCE = 1, SETS = 2;
const SEQUENCE_SCORES = [0, 0, 0, 3, 4, 15, 16, 17, 18];
const SET_SCORES = [0, 0, 0, 3, 14];

// Maximal runs of three or more set bits: [length, top rank].
function runs(bits) {
  const out = [];
  let start = null;
  for (let rank = 0; rank <= NUM_RANKS; rank++) {
    const held = rank < NUM_RANKS && (bits >> rank) & 1;
    if (held && start === null) start = rank;
    else if (!held && start !== null) { if (rank - start >= 3) out.push([rank - start, rank - 1]); start = null; }
  }
  return out;
}
const RUNS = Array.from({ length: 256 }, (_, bits) => runs(bits));
const RUN_BITS = RUNS.map(list => list.reduce((m, [length, top]) => m | (((1 << length) - 1) << (top - length + 1)), 0));
const POINT_LENGTH = Array.from({ length: 256 }, (_, bits) => popcount(bits));
const POINT_VALUE = Array.from({ length: 256 }, (_, bits) => POINT_VALUES.reduce((s, v, r) => s + ((bits >> r) & 1 ? v : 0), 0));

// Lexicographic comparison of keys, as Python compares tuples.
const cmp = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1; return Math.sign(a.length - b.length); };

function pointKey(hand) {
  let best = null;
  for (let suit = 0; suit < NUM_SUITS; suit++) {
    const bits = suitBits(hand, suit);
    if (!bits) continue;
    const key = [POINT_LENGTH[bits], POINT_VALUE[bits], -suit];
    if (best === null || cmp(key, best) > 0) best = key;
  }
  return best === null ? null : [best[0], best[1], -best[2]];
}

function sequenceKey(hand) {
  let best = null;
  for (let suit = 0; suit < NUM_SUITS; suit++) for (const run of RUNS[suitBits(hand, suit)]) if (best === null || cmp(run, best) > 0) best = run;
  return best;
}

// [size, rank] of every set from the 10 up.
function setRanks(hand) {
  const sets = [];
  for (let rank = TEN; rank < NUM_RANKS; rank++) {
    let size = 0;
    for (let suit = 0; suit < NUM_SUITS; suit++) size += has(hand, cardId(suit, rank)) ? 1 : 0;
    if (size >= 3) sets.push([size, rank]);
  }
  return sets;
}

function setsKey(hand) {
  const sets = setRanks(hand);
  return sets.length ? sets.reduce((a, b) => (cmp(b, a) > 0 ? b : a)) : null;
}

export const best = (category, hand) => category === POINT ? pointKey(hand) : category === SEQUENCE ? sequenceKey(hand) : setsKey(hand);
// Sign of a - b; a point's suit never breaks a tie.
export const compare = (category, a, b) => category === POINT ? cmp(a.slice(0, 2), b.slice(0, 2)) : cmp(a, b);

export function score(category, hand) {
  if (category === POINT) { const key = pointKey(hand); return key === null ? 0 : key[0]; }
  if (category === SEQUENCE) {
    let total = 0;
    for (let suit = 0; suit < NUM_SUITS; suit++) for (const [length] of RUNS[suitBits(hand, suit)]) total += SEQUENCE_SCORES[length];
    return total;
  }
  return setRanks(hand).reduce((s, [size]) => s + SET_SCORES[size], 0);
}

// The cards a winning declaration shows.
export function shown(category, hand) {
  if (category === POINT) { const key = pointKey(hand); return key === null ? 0 : (suitBits(hand, key[2]) << (key[2] * NUM_RANKS)) >>> 0; }
  if (category === SEQUENCE) {
    let mask = 0;
    for (let suit = 0; suit < NUM_SUITS; suit++) mask = (mask | (RUN_BITS[suitBits(hand, suit)] << (suit * NUM_RANKS))) >>> 0;
    return mask;
  }
  let mask = 0;
  for (const [, rank] of setRanks(hand)) for (let suit = 0; suit < NUM_SUITS; suit++) if (has(hand, cardId(suit, rank))) mask = (mask | bit(cardId(suit, rank))) >>> 0;
  return mask;
}

// ---- Engine (engine.py) -------------------------------------------------------
export const HAND_SIZE = 12, TALON_SIZE = 8, ELDER_MAX = 5, TRICKS = 12;
export const EXCHANGE = 0, DECLARE = 1, PLAY = 2, DONE = 3;
export const HEADS = ['exchange', 'declare', 'play'];
export const STOP = NUM_CARDS, QUIET = 0, SPEAK = 1;
export const EV_DEAL = 0, EV_CARTE_BLANCHE = 1, EV_SELECT = 2, EV_EXCHANGE = 3, EV_ANNOUNCE = 4, EV_RESOLVE = 5, EV_PLAY = 6, EV_DEAL_END = 7;
export const SAID_NOTHING = 1, DECLARED = 2, CONCEDED = 3;
export const BONUS_NONE = 0, BONUS_REPIQUE = 1, BONUS_PIQUE = 2, BONUS_CARDS = 3, BONUS_CAPOT = 4;
export const CARTE_BLANCHE_POINTS = 10, REPIQUE = 60, PIQUE = 30, CARDS = 10, CAPOT = 40;
const W_HAND = 0, W_SELECTED = 2, W_DISCARD = 4, W_PLAYED = 6, W_TRICK = 8, W_TALON = 10;
const NUM_WHERE = W_TALON + TALON_SIZE;
const KNOW_NONE = 0, KNOW_EXACT = 1, KNOW_MAYBE = 2;
export const WHERE = { HAND: W_HAND, SELECTED: W_SELECTED, DISCARD: W_DISCARD, PLAYED: W_PLAYED, TRICK: W_TRICK, TALON: W_TALON };

const event = fields => ({ kind: 0, actor: -1, card: NO_CARD, count: 0, category: -1, status: 0, key: null, winner: -1, points: 0, bonus: BONUS_NONE, bonusSeat: -1, cards: 0, discarded: 0, seen: 0, ...fields });

export function shuffledDeck(random = Math.random) {
  const deck = Array.from({ length: NUM_CARDS }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}

export class PiquetEngine {
  // One deal. `deck`: the first 12 cards are Elder's, the next 12 Younger's, the rest the talon (top first).
  constructor({ deck = shuffledDeck(), dealer = 0, listener = null } = {}) {
    this.listener = listener;
    this.events = [];
    this.dealer = dealer;
    this.done = false;
    this.deal(deck);
    this.advance();
  }

  get head() { return HEADS[this.phase]; }
  get younger() { return 1 - this.elder; }

  deal(deck) {
    this.elder = 1 - this.dealer;
    this.hands = [0, 0];
    this.hands[this.elder] = maskOf(deck.slice(0, HAND_SIZE));
    this.hands[this.younger] = maskOf(deck.slice(HAND_SIZE, 2 * HAND_SIZE));
    this.talon = deck.slice(2 * HAND_SIZE);
    this.dealt = [...this.hands];
    this.where = Array(NUM_CARDS).fill(0);
    for (const seat of [0, 1]) for (const c of cardsOf(this.hands[seat])) this.where[c] = W_HAND + seat;
    this.placeTalon();
    this.info = [Array(NUM_CARDS).fill(KNOW_NONE), Array(NUM_CARDS).fill(KNOW_NONE)];
    this.selected = 0;
    this.discards = [0, 0];
    this.exchanged = [false, false];
    this.exchangedCount = [0, 0];
    this.shownHand = [0, 0];
    this.points = [0, 0];
    this.declared = [0, 0];
    this.result = { elder: this.elder, carteBlanche: [false, false], categoryWinners: [-1, -1, -1], repique: -1, pique: -1, capot: -1 };
    this.category = 0;
    this.announced = null;
    this.tricks = [0, 0];
    this.trickIndex = 0;
    this.trick = [];
    this.played = [0, 0];
    this.voids = [0, 0];
    this.phase = EXCHANGE;
    this.current = this.elder;
    this.emit(event({ kind: EV_DEAL }));
    if (!(this.hands[this.elder] & FACE_MASK)) this.carteBlanche(this.elder);
    this.limits(1, Math.min(ELDER_MAX, this.talon.length));
  }

  placeTalon() { this.talon.forEach((card, depth) => { this.where[card] = W_TALON + depth; }); }
  limits(low, high) { this.minDiscards = low; this.maxDiscards = high; }

  emit(ev) {
    this.events.push(ev);
    this.listener?.(this, ev);
  }

  // Add points; returns [bonus kind, seat] when this crossed into repique or pique.
  addScore(seat, points, declaration) {
    const other = 1 - seat;
    this.points[seat] += points;
    if (declaration) {
      this.declared[seat] += points;
      if (this.result.repique < 0 && this.declared[seat] >= 30 && this.points[other] === 0) {
        this.result.repique = seat;
        this.points[seat] += REPIQUE;
        return [BONUS_REPIQUE, seat];
      }
    } else if (seat === this.elder && this.result.repique < 0 && this.result.pique < 0 && this.points[seat] >= 30 && this.points[other] === 0) {
      this.result.pique = seat;
      this.points[seat] += PIQUE;
      return [BONUS_PIQUE, seat];
    }
    return [BONUS_NONE, -1];
  }

  // Legal cards as a mask (exchange: selectable cards; play: playable cards).
  legalMask() {
    const hand = this.hands[this.current];
    if (this.phase === EXCHANGE) return popcount(this.selected) >= this.maxDiscards ? 0 : (hand & ~this.selected) >>> 0;
    if (this.phase === PLAY) {
      if (this.trick.length) {
        const follow = (hand & suitMask(suitOf(this.trick[0][1]))) >>> 0;
        if (follow) return follow;
      }
      return hand;
    }
    return 0;
  }

  // The legal actions, in order: card ids (and STOP), or QUIET / SPEAK.
  legalActions() {
    if (this.done) throw new Error('The deal is over.');
    if (this.phase === DECLARE) return [QUIET, SPEAK];
    const actions = cardsOf(this.legalMask());
    if (this.phase === EXCHANGE && popcount(this.selected) >= this.minDiscards) actions.push(STOP);
    return actions;
  }

  apply(action, { advance = true } = {}) {
    if (!this.legalActions().includes(action)) throw new Error(`Illegal ${this.head} action ${action}.`);
    this.applyAction(action);
    if (advance) this.advance();
  }

  applyAction(action) {
    if (this.phase === EXCHANGE) {
      if (action === STOP) this.exchange();
      else {
        this.selected = (this.selected | bit(action)) >>> 0;
        this.where[action] = W_SELECTED + this.current;
        this.emit(event({ kind: EV_SELECT, actor: this.current, card: action }));
      }
    } else if (this.phase === DECLARE) {
      if (this.current === this.elder) this.announce(action === SPEAK);
      else this.resolve(action === SPEAK);
    } else this.play(action);
  }

  // Take every decision that has a single legal action.
  advance() {
    while (!this.done) {
      if (this.phase === DECLARE) return;
      const legal = this.legalActions();
      if (legal.length > 1) return;
      this.applyAction(legal[0]);
    }
  }

  // ---- exchange ----
  carteBlanche(seat) {
    this.shownHand[seat] = this.hands[seat];
    for (const c of cardsOf(this.hands[seat])) this.info[1 - seat][c] = KNOW_EXACT;
    this.result.carteBlanche[seat] = true;
    const [bonus, bonusSeat] = this.addScore(seat, CARTE_BLANCHE_POINTS, true);
    this.emit(event({ kind: EV_CARTE_BLANCHE, actor: seat, cards: this.hands[seat], points: CARTE_BLANCHE_POINTS, bonus, bonusSeat }));
  }

  exchange() {
    const seat = this.current, count = popcount(this.selected);
    const drawn = this.talon.slice(0, count);
    this.talon = this.talon.slice(count);
    const drawnMask = maskOf(drawn), discarded = this.selected;
    this.hands[seat] = ((this.hands[seat] & ~discarded) | drawnMask) >>> 0;
    this.discards[seat] = discarded;
    for (const c of cardsOf(discarded)) this.where[c] = W_DISCARD + seat;
    for (const c of drawn) this.where[c] = W_HAND + seat;
    this.placeTalon();
    this.exchanged[seat] = true;
    this.exchangedCount[seat] = count;
    this.selected = 0;
    const other = 1 - seat;
    // Cards shown by carte blanche may now be in the hand or the discards.
    for (const c of cardsOf(this.shownHand[seat])) if (this.info[other][c] === KNOW_EXACT) this.info[other][c] = KNOW_MAYBE;
    let seen = 0;
    if (seat === this.elder) {
      seen = maskOf(this.talon.slice(0, ELDER_MAX - count));
      for (const c of cardsOf(seen)) this.info[seat][c] = KNOW_EXACT;
    }
    this.emit(event({ kind: EV_EXCHANGE, actor: seat, count, cards: drawnMask, discarded, seen }));
    if (seat === this.elder) {
      this.current = this.younger;
      if (!(this.hands[this.younger] & FACE_MASK)) this.carteBlanche(this.younger);
      this.limits(0, this.talon.length);
    } else {
      this.held = [...this.hands];
      this.phase = DECLARE;
      this.category = 0;
      this.elderDeclares();
    }
  }

  // ---- declarations ----
  elderDeclares() {
    this.current = this.elder;
    this.announced = null;
    if (best(this.category, this.hands[this.elder]) === null) this.announce(false);
  }

  announce(speak) {
    const key = speak ? best(this.category, this.hands[this.elder]) : null;
    this.announced = key;
    this.emit(event({ kind: EV_ANNOUNCE, actor: this.elder, category: this.category, status: key !== null ? DECLARED : SAID_NOTHING, key }));
    this.current = this.younger;
    const mine = best(this.category, this.hands[this.younger]);
    if (mine === null || (key !== null && compare(this.category, mine, key) < 0)) this.resolve(false);
  }

  resolve(speak) {
    const category = this.category, younger = this.younger, elder = this.elder;
    const key = speak ? best(category, this.hands[younger]) : null;
    let status, winner;
    if (this.announced !== null) {
      if (key === null) [status, winner] = [CONCEDED, elder];
      else [status, winner] = [DECLARED, compare(category, key, this.announced) > 0 ? younger : -1];
    } else [status, winner] = key !== null ? [DECLARED, younger] : [SAID_NOTHING, -1];
    let points = 0, cards = 0, bonus = BONUS_NONE, bonusSeat = -1;
    if (winner >= 0) {
      points = score(category, this.hands[winner]);
      cards = shown(category, this.hands[winner]);
      for (const c of cardsOf(cards)) this.info[1 - winner][c] = KNOW_EXACT;
      [bonus, bonusSeat] = this.addScore(winner, points, true);
    }
    this.result.categoryWinners[category] = winner;
    this.emit(event({ kind: EV_RESOLVE, actor: younger, category, status, key, winner, points, cards, bonus, bonusSeat }));
    this.category++;
    if (this.category < 3) this.elderDeclares();
    else { this.phase = PLAY; this.current = this.elder; }
  }

  // ---- tricks ----
  play(card) {
    const seat = this.current;
    this.hands[seat] = (this.hands[seat] & ~bit(card)) >>> 0;
    this.where[card] = W_TRICK + seat;
    if (!this.trick.length) {
      this.trick.push([seat, card]);
      const [bonus, bonusSeat] = this.addScore(seat, 1, false);
      this.emit(event({ kind: EV_PLAY, actor: seat, card, points: 1, bonus, bonusSeat }));
      this.current = 1 - seat;
      return;
    }
    const [leader, led] = this.trick[0];
    const follows = suitOf(card) === suitOf(led);
    if (!follows) this.voids[seat] |= 1 << suitOf(led);
    const winner = follows && rankOf(card) > rankOf(led) ? seat : leader;
    const points = Number(winner === seat) + Number(this.trickIndex === TRICKS - 1);
    for (const [player, played] of [[leader, led], [seat, card]]) {
      this.played[player] = (this.played[player] | bit(played)) >>> 0;
      this.where[played] = W_PLAYED + player;
    }
    this.lastTrick = { leader, led, follower: seat, card, winner };
    this.trick = [];
    this.tricks[winner]++;
    this.trickIndex++;
    const [bonus, bonusSeat] = points ? this.addScore(winner, points, false) : [BONUS_NONE, -1];
    this.emit(event({ kind: EV_PLAY, actor: seat, card, winner, points, bonus, bonusSeat }));
    if (this.trickIndex === TRICKS) this.endDeal();
    else this.current = winner;
  }

  endDeal() {
    let bonus = BONUS_NONE, winner = -1, points = 0;
    for (const seat of [0, 1]) {
      if (this.tricks[seat] === TRICKS) { [bonus, winner, points] = [BONUS_CAPOT, seat, CAPOT]; this.result.capot = seat; }
      else if (this.tricks[seat] > TRICKS / 2) [bonus, winner, points] = [BONUS_CARDS, seat, CARDS];
    }
    if (winner >= 0) this.points[winner] += points;
    this.phase = DONE;
    this.emit(event({ kind: EV_DEAL_END, winner, points, bonus, bonusSeat: winner }));
    this.done = true;
    this.current = -1;
  }

  // A copy with its own state and listener (the agent's lookahead runs on copies).
  clone(listener = null) {
    const copy = Object.create(PiquetEngine.prototype);
    for (const [key, value] of Object.entries(this)) if (key !== 'listener') copy[key] = typeof value === 'object' && value !== null ? structuredClone(value) : value;
    copy.listener = listener;
    return copy;
  }

  // Recompute the masks and the talon from `where` after cards were reassigned.
  rebuild() {
    this.hands = [0, 0]; this.discards = [0, 0];
    let selected = 0;
    const talon = Array(this.talon.length);
    this.where.forEach((w, c) => {
      if (w === W_HAND || w === W_HAND + 1) this.hands[w - W_HAND] = (this.hands[w - W_HAND] | bit(c)) >>> 0;
      else if (w === W_DISCARD || w === W_DISCARD + 1) this.discards[w - W_DISCARD] = (this.discards[w - W_DISCARD] | bit(c)) >>> 0;
      else if (w === W_SELECTED + this.current) selected = (selected | bit(c)) >>> 0;
      else if (w >= W_TALON) talon[w - W_TALON] = c;
    });
    for (const seat of [0, 1]) this.hands[seat] = (this.hands[seat] | (seat === this.current ? selected : 0)) >>> 0;
    this.talon = talon;
  }
}

// ---- Tokens (tokens.py) -------------------------------------------------------
export const KIND_DECISION = 0;
const EVENT_KINDS = { [EV_DEAL]: 1, [EV_CARTE_BLANCHE]: 2, [EV_EXCHANGE]: 3, [EV_ANNOUNCE]: 4, [EV_RESOLVE]: 5, [EV_PLAY]: 6, [EV_DEAL_END]: 7 };
const F_KIND = 0, F_HEAD = 1, F_ACTOR = 2, F_ROLE = 3, F_CARD = 4, F_COUNT = 5, F_LIMIT = 6, F_CATEGORY = 7, F_STATUS = 8,
  F_LENGTH = 9, F_VALUE = 10, F_TOP = 11, F_COMPARE = 12, F_WINNER = 13, F_POINTS = 14, F_BONUS = 15, F_BONUS_SEAT = 16,
  F_TRICK = 17, F_TRICK_POS = 18, F_LEAD_SUIT = 19, F_MY_TRICKS = 20, F_OPP_TRICKS = 21, F_MY_POINTS = 22, F_OPP_POINTS = 23,
  F_MY_TOTAL = 24, F_OPP_TOTAL = 25, F_DEAL = 26, F_MODE = 27, F_TALON = 28, F_OPP_VOID = 29, F_PHASE = 30;
export const NUM_FIELDS = 31, CARD_START = NUM_FIELDS, WIDTH = NUM_FIELDS + NUM_CARDS;
const MAX_POINTS = 99, POINTS_VOCAB = 64;

// Card codes: where the viewer knows each card to be.
export const V_UNKNOWN = 0, V_MINE = 1, V_MINE_LEGAL = 2, V_SELECTED = 3, V_DISCARDED = 4, V_SEEN_TALON = 5,
  V_OPP = 6, V_OPP_MAYBE = 7, V_PLAYED_ME = 8, V_PLAYED_OPP = 9, V_TRICK_ME = 10, V_TRICK_OPP = 11;

// VIEW[seat][where][knowledge] -> card code.
const VIEW = [0, 1].map(seat => {
  const other = 1 - seat;
  const view = Array.from({ length: NUM_WHERE }, () => [V_UNKNOWN, V_UNKNOWN, V_UNKNOWN]);
  const all = (where, code) => { view[where] = [code, code, code]; };
  all(W_HAND + seat, V_MINE);
  all(W_SELECTED + seat, V_SELECTED);
  all(W_DISCARD + seat, V_DISCARDED);
  for (const where of [W_HAND + other, W_SELECTED + other]) { view[where][KNOW_EXACT] = V_OPP; view[where][KNOW_MAYBE] = V_OPP_MAYBE; }
  view[W_DISCARD + other][KNOW_EXACT] = V_OPP_MAYBE;
  view[W_DISCARD + other][KNOW_MAYBE] = V_OPP_MAYBE;
  all(W_PLAYED + seat, V_PLAYED_ME);
  all(W_PLAYED + other, V_PLAYED_OPP);
  all(W_TRICK + seat, V_TRICK_ME);
  all(W_TRICK + other, V_TRICK_OPP);
  for (let depth = 0; depth < TALON_SIZE; depth++) view[W_TALON + depth][KNOW_EXACT] = V_SEEN_TALON;
  return view;
});

const relative = (seat, viewer) => seat < 0 ? 0 : 1 + Number(seat !== viewer);

// [length, value, top] of a declared combination.
function keyFields(category, key) {
  if (key === null) return [0, 0, 0];
  if (category === POINT) return [key[0], key[1], 0];
  return [key[0], 0, key[1] + 1];
}

// What `seat` sees of every card: one code per card.
export const viewCodes = (engine, seat, legal = 0) => engine.where.map((w, c) => has(legal, c) ? V_MINE_LEGAL : VIEW[seat][w][engine.info[seat][c]]);

export class ObservationWriter {
  constructor() { this.lastSelected = [NO_CARD, NO_CARD]; }

  clone() { const copy = new ObservationWriter(); copy.lastSelected = [...this.lastSelected]; return copy; }

  counters(engine, seat) {
    const row = Array(WIDTH).fill(0), other = 1 - seat;
    row[F_ROLE] = Number(seat !== engine.elder);
    row[F_CARD] = NO_CARD;
    row[F_TRICK] = engine.trickIndex;
    row[F_MY_TRICKS] = engine.tricks[seat];
    row[F_OPP_TRICKS] = engine.tricks[other];
    row[F_MY_POINTS] = Math.min(engine.points[seat], MAX_POINTS);
    row[F_OPP_POINTS] = Math.min(engine.points[other], MAX_POINTS);
    // One deal at a time: partie totals, deal number and mode stay 0.
    row[F_TALON] = engine.talon.length;
    row[F_OPP_VOID] = engine.voids[other];
    row[F_PHASE] = engine.phase;
    return row;
  }

  // Both seats' tokens for an event; null if it has none.
  eventRows(engine, ev) {
    if (ev.kind === EV_SELECT) { this.lastSelected[ev.actor] = ev.card; return null; }
    if (ev.kind === EV_EXCHANGE) this.lastSelected[ev.actor] = NO_CARD;
    return [0, 1].map(seat => {
      const row = this.counters(engine, seat);
      row[F_KIND] = EVENT_KINDS[ev.kind];
      row[F_ACTOR] = relative(ev.actor, seat);
      if (ev.kind === EV_EXCHANGE) row[F_COUNT] = ev.count;
      else if (ev.kind === EV_ANNOUNCE || ev.kind === EV_RESOLVE) {
        row[F_CATEGORY] = 1 + ev.category;
        row[F_STATUS] = ev.status;
        [row[F_LENGTH], row[F_VALUE], row[F_TOP]] = keyFields(ev.category, ev.key);
      } else if (ev.kind === EV_PLAY) {
        row[F_CARD] = ev.card;
        const lead = ev.winner < 0;
        row[F_TRICK_POS] = lead ? 1 : 2;
        const led = lead ? ev.card : engine.events.at(-2).card;
        row[F_LEAD_SUIT] = 1 + suitOf(led);
      }
      if ((ev.kind === EV_RESOLVE || ev.kind === EV_PLAY || ev.kind === EV_DEAL_END) && (ev.winner >= 0 || ev.kind !== EV_PLAY)) {
        row[F_WINNER] = ev.winner < 0 ? 3 : relative(ev.winner, seat);
      }
      row[F_POINTS] = Math.min(ev.points, POINTS_VOCAB - 1);
      row[F_BONUS] = ev.bonus;
      row[F_BONUS_SEAT] = relative(ev.bonusSeat, seat);
      viewCodes(engine, seat).forEach((code, c) => { row[CARD_START + c] = code; });
      return row;
    });
  }

  // The deciding seat's decision token.
  decisionRow(engine, seat) {
    const row = this.counters(engine, seat);
    row[F_KIND] = KIND_DECISION;
    row[F_HEAD] = 1 + engine.phase;
    row[F_ACTOR] = 1;
    let legal = 0;
    if (engine.phase === EXCHANGE) {
      row[F_COUNT] = popcount(engine.selected);
      row[F_LIMIT] = engine.maxDiscards;
      row[F_CARD] = this.lastSelected[seat];
      legal = engine.legalMask();
    } else if (engine.phase === DECLARE) {
      const category = engine.category, mine = best(category, engine.hands[seat]);
      row[F_CATEGORY] = 1 + category;
      [row[F_LENGTH], row[F_VALUE], row[F_TOP]] = keyFields(category, mine);
      if (seat !== engine.elder) {
        const announced = engine.announced;
        row[F_STATUS] = announced === null ? 1 : 2;
        if (announced !== null) row[F_COMPARE] = compare(category, mine, announced) > 0 ? 1 : 2;
      }
    } else if (engine.phase === PLAY) {
      legal = engine.legalMask();
      if (engine.trick.length) {
        row[F_TRICK_POS] = 2;
        row[F_CARD] = engine.trick[0][1];
        row[F_LEAD_SUIT] = 1 + suitOf(engine.trick[0][1]);
      } else row[F_TRICK_POS] = 1;
    }
    viewCodes(engine, seat, legal).forEach((code, c) => { row[CARD_START + c] = code; });
    return row;
  }
}

// A deal with both seats' token streams, built as selfplay builds them: every
// event reaches both streams, and the seat about to decide gets its decision token.
export class PiquetDeal {
  constructor(options = {}) {
    this.writer = new ObservationWriter();
    this.streams = [[], []];
    this.log = [];
    this.engine = new PiquetEngine({ ...options, listener: (engine, ev) => this.onEvent(engine, ev) });
    this.flush();
  }

  onEvent(engine, ev) {
    if (ev.kind !== EV_SELECT) this.log.push(ev);
    const rows = this.writer.eventRows(engine, ev);
    if (rows) for (const seat of [0, 1]) this.streams[seat].push(rows[seat]);
  }

  flush() {
    const engine = this.engine;
    if (!engine.done) this.streams[engine.current].push(this.writer.decisionRow(engine, engine.current));
  }

  apply(action) {
    this.engine.apply(action);
    this.flush();
  }

  // A throwaway copy of the table, its writer and both streams, for looking ahead.
  clone() {
    const copy = Object.create(PiquetDeal.prototype);
    copy.writer = this.writer.clone();
    copy.streams = this.streams.map(stream => [...stream]);
    copy.log = [...this.log];
    copy.engine = this.engine.clone((engine, ev) => copy.onEvent(engine, ev));
    return copy;
  }
}
