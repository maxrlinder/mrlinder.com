// Hjärter engine: deals, passing, tricks, scoring, whole games to `endScore`.
// A port of cardgym/games/hjarter/engine.py (the rules are in the gym's
// docs/hjarter-rules.md); scripts/check-hjarter.mjs replays the Python engine's
// games through it. Cards are integers, `suit * 13 + rank` with rank 0 = 2 up to
// 12 = ace; a hand is a sorted array of cards. `apply` takes one card: a card to
// pass, or a card to play. A listener, if given, sees every event right after
// the state it describes.

export const NUM_RANKS = 13, NUM_CARDS = 52;
export const CLUBS = 0, DIAMONDS = 1, SPADES = 2, HEARTS = 3;
export const SUIT_SYMBOLS = ['♣', '♦', '♠', '♥'];
export const SUIT_WORDS = ['clubs', 'diamonds', 'spades', 'hearts'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const card = (suit, rank) => suit * NUM_RANKS + rank;
export const suitOf = c => Math.floor(c / NUM_RANKS);
export const rankOf = c => c % NUM_RANKS;
export const name = c => `${RANKS[rankOf(c)]}${SUIT_SYMBOLS[suitOf(c)]}`;
export const isRed = c => suitOf(c) === DIAMONDS || suitOf(c) === HEARTS;
export const QUEEN_OF_SPADES = card(SPADES, 10);
export const JACK_OF_DIAMONDS = card(DIAMONDS, 9);
// Penalty cards: every heart and the queen of spades (26 points in all).
export const isPenalty = c => suitOf(c) === HEARTS || c === QUEEN_OF_SPADES;

/** Penalty points of one taken card: a heart 1, Q♠ 13, J♦ −10 with the option. */
export function cardPoints(c, jackOfDiamonds) {
  if (suitOf(c) === HEARTS) return 1;
  if (c === QUEEN_OF_SPADES) return 13;
  if (jackOfDiamonds && c === JACK_OF_DIAMONDS) return -10;
  return 0;
}

export const MIN_PLAYERS = 3, MAX_PLAYERS = 5, MAX_PASS_CARDS = 3;
// Cards removed so every seat gets as many.
export const REMOVED = { 3: [card(DIAMONDS, 0)], 4: [], 5: [card(DIAMONDS, 0), card(CLUBS, 0)] };
export const HAND_SIZES = Object.fromEntries(Object.entries(REMOVED).map(([players, removed]) => [players, (NUM_CARDS - removed.length) / players]));
export const MOON_POINTS = 26;
// A game to 100 ends long before this; it bounds the game regardless.
export const MAX_DEALS = 64;

export const NONE = 0, PASS = 1, PLAY = 2;
export const K_DEAL = 0, K_TURN = 1, K_PASS = 2, K_RECEIVE = 3, K_PLAY = 4;

export const DEFAULT_RULES = Object.freeze({ passCards: 2, jackOfDiamonds: false, endScore: 100 });

/** Seats from the passer to its receiver in deal `dealIndex`: right, left, (across), none. */
export function passOffset(players, dealIndex) {
  if (players === 4) return [3, 1, 2, 0][dealIndex % 4];
  return [players - 1, 1, 0][dealIndex % 3];
}

export const passCycle = players => (players === 4 ? 4 : 3);

/** The lowest club in the deck: 2♣, or 3♣ when it is removed. */
export function leadCard(players) {
  for (let c = 0; c < NUM_RANKS; c++) if (!REMOVED[players].includes(c)) return c;
  return -1;
}

export function deckFor(players) {
  const removed = new Set(REMOVED[players]);
  return Array.from({ length: NUM_CARDS }, (_, c) => c).filter(c => !removed.has(c));
}

/** Fisher-Yates with the browser's crypto randomness. */
export function shuffled(cards) {
  const out = [...cards], random = new Uint32Array(out.length);
  crypto.getRandomValues(random);
  for (let i = out.length - 1; i > 0; i--) {
    const j = random[i] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const remove = (hand, c) => hand.splice(hand.indexOf(c), 1);
const insert = (hand, c) => { hand.push(c); hand.sort((a, b) => a - b); };

/**
 * One deal (`deals = 1`), a fixed number of deals, or a game to
 * `rules.endScore` (`deals = null`). `dealIndex` is the first deal's place in
 * the passing cycle. `nextHands(engine)` may fix each deal's hands (tests).
 */
export class HjarterEngine {
  constructor({ players = 4, rules = DEFAULT_RULES, deals = 1, dealIndex = 0, dealer = 0, scores = null, nextHands = null, listener = null } = {}) {
    if (!(players >= MIN_PLAYERS && players <= MAX_PLAYERS)) throw new Error(`Hjärter is for ${MIN_PLAYERS}-${MAX_PLAYERS} players.`);
    rules = { ...DEFAULT_RULES, ...rules };
    if (!(rules.passCards >= 0 && rules.passCards <= MAX_PASS_CARDS)) throw new Error(`passCards must be 0..${MAX_PASS_CARDS}.`);
    if (!(rules.endScore >= 1)) throw new Error('endScore must be positive.');
    this.players = players;
    this.rules = rules;
    this.deals = deals;
    this.listener = listener;
    this.nextHands = nextHands;
    this.handSize = HAND_SIZES[players];
    this.lead = leadCard(players);
    this.deck = deckFor(players);
    this.scores = scores ? [...scores] : Array(players).fill(0);
    this.results = [];
    this.dealIndex = dealIndex;
    this.dealsPlayed = 0;
    this.dealer = dealer % players;
    this.done = false;
    this.deal();
  }

  get head() { return this.phase === PASS ? 'pass' : 'play'; }
  /** Cards in the current seat's hand. */
  get held() { return this.hands[this.current]; }

  legalCards() {
    const hand = this.hands[this.current];
    if (this.phase === PASS) return [...hand];
    if (!this.trick.length) {
      if (this.trickIndex === 0) return [this.lead];
      const plain = hand.filter(c => suitOf(c) !== HEARTS);
      return !this.broken && plain.length ? plain : [...hand];
    }
    const follow = hand.filter(c => suitOf(c) === this.led);
    if (follow.length) return follow;
    if (this.trickIndex === 0) {
      const clean = hand.filter(c => !isPenalty(c));
      if (clean.length) return clean;
    }
    return [...hand];
  }

  emit(event) {
    if (this.listener) this.listener(this, event);
  }

  // -- dealing and passing -------------------------------------------------
  deal() {
    const { players, handSize } = this;
    let hands = this.nextHands?.(this);
    if (hands) {
      hands = hands.map(hand => [...hand].sort((a, b) => a - b));
      const all = hands.flat().sort((a, b) => a - b);
      if (hands.length !== players || hands.some(hand => hand.length !== handSize) || all.join() !== this.deck.join()) throw new Error(`Fixed hands must be ${players} hands of ${handSize} cards partitioning the deck.`);
    } else {
      const cards = shuffled(this.deck);
      hands = Array(players);
      for (let offset = 0; offset < players; offset++) {
        const seat = (this.dealer + 1 + offset) % players;
        hands[seat] = cards.slice(offset * handSize, (offset + 1) * handSize).sort((a, b) => a - b);
      }
    }
    this.hands = hands;
    this.dealt = hands.map(hand => [...hand]);
    this.direction = this.rules.passCards ? passOffset(players, this.dealIndex) : 0;
    this.pending = Array.from({ length: players }, () => []);
    this.received = Array.from({ length: players }, () => []);
    this.trick = [];
    this.led = -1;
    this.winning = -1;
    this.best = -1;
    this.trickPoints = 0;
    this.trickIndex = 0;
    this.taken = Array(players).fill(0);
    this.queenTaker = -1;
    this.jackTaker = -1;
    this.broken = false;
    this.played = [];
    // Not in the Python engine: the last finished trick, for the table.
    this.lastTrick = null;
    if (this.direction) {
      this.phase = PASS;
      this.firstPasser = (this.dealer + 1) % players;
      this.current = this.firstPasser;
    } else this.startPlay();
    this.emit({ kind: K_DEAL, nextSeat: this.current, nextPhase: this.phase });
    if (this.direction) this.emit({ kind: K_TURN, seat: this.current, nextSeat: this.current, nextPhase: PASS });
  }

  startPlay() {
    this.phase = PLAY;
    this.current = this.hands.findIndex(hand => hand.includes(this.lead));
  }

  passCard(seat, c) {
    remove(this.hands[seat], c);
    this.pending[seat].push(c);
    let turn = false, exchange = false;
    if (this.pending[seat].length === this.rules.passCards) {
      const following = (seat + 1) % this.players;
      if (following === this.firstPasser) {
        exchange = true;
        for (let giver = 0; giver < this.players; giver++) {
          const receiver = (giver + this.direction) % this.players;
          for (const passed of this.pending[giver]) insert(this.hands[receiver], passed);
          this.received[receiver] = [...this.pending[giver]].sort((a, b) => a - b);
        }
        this.startPlay();
      } else {
        this.current = following;
        turn = true;
      }
    }
    this.emit({ kind: K_PASS, seat, card: c, nextSeat: this.current, nextPhase: this.phase });
    if (turn) this.emit({ kind: K_TURN, seat: this.current, nextSeat: this.current, nextPhase: PASS });
    if (exchange) {
      for (let receiver = 0; receiver < this.players; receiver++) {
        const giver = (receiver - this.direction + this.players) % this.players;
        for (const got of this.received[receiver]) this.emit({ kind: K_RECEIVE, seat: receiver, card: got, giver, nextSeat: this.current, nextPhase: PLAY });
      }
    }
  }

  // -- play ------------------------------------------------------------------
  playCard(seat, c) {
    remove(this.hands[seat], c);
    this.played.push(c);
    const suit = suitOf(c), rank = rankOf(c);
    if (!this.trick.length) {
      this.led = suit;
      this.winning = seat; this.best = rank;
    } else if (suit === this.led && rank > this.best) {
      this.winning = seat; this.best = rank;
    }
    if (suit === HEARTS) this.broken = true;
    const position = this.trick.length;
    this.trick.push([seat, c]);
    this.trickPoints += cardPoints(c, this.rules.jackOfDiamonds);
    const trick = this.trickIndex;
    const complete = this.trick.length === this.players;
    if (complete) {
      const winner = this.winning;
      for (const [, taken] of this.trick) {
        if (isPenalty(taken)) this.taken[winner] += cardPoints(taken, false);
        if (taken === QUEEN_OF_SPADES) this.queenTaker = winner;
        else if (taken === JACK_OF_DIAMONDS && this.rules.jackOfDiamonds) this.jackTaker = winner;
      }
      this.lastTrick = { index: trick, cards: [...this.trick], winner, points: this.trickPoints, led: this.led };
      this.trickIndex++;
      const over = this.trickIndex === this.handSize;
      this.current = over ? -1 : winner;
      if (over) this.phase = NONE;
    } else this.current = (seat + 1) % this.players;
    this.emit({
      kind: K_PLAY, seat, card: c, trick, position, led: this.led, winning: this.winning, points: this.trickPoints, complete,
      nextSeat: this.current, nextPhase: this.phase,
    });
    if (complete) {
      this.trick = [];
      this.trickPoints = 0;
      if (this.trickIndex === this.handSize) this.finishDeal();
    }
  }

  finishDeal() {
    const players = this.players;
    const moon = this.taken.findIndex(points => points === MOON_POINTS);
    const points = moon >= 0 ? this.taken.map((_, seat) => (seat === moon ? 0 : MOON_POINTS)) : [...this.taken];
    if (this.jackTaker >= 0) points[this.jackTaker] -= 10;
    this.scores = this.scores.map((score, seat) => score + points[seat]);
    this.results.push({
      index: this.dealIndex, direction: this.direction, dealt: this.dealt.map(hand => [...hand]),
      passed: this.pending.map(cards => [...cards]), received: this.received.map(cards => [...cards]), taken: [...this.taken], points,
      moon, queen: this.queenTaker, jack: this.jackTaker, scores: [...this.scores],
    });
    this.dealsPlayed++;
    const finished = this.deals !== null
      ? this.dealsPlayed >= this.deals
      : Math.max(...this.scores) >= this.rules.endScore || this.dealsPlayed >= MAX_DEALS;
    if (finished) {
      this.done = true;
      this.phase = NONE;
      this.current = -1;
      return;
    }
    this.dealIndex++;
    this.dealer = (this.dealer + 1) % players;
    this.deal();
  }

  apply(c) {
    if (this.done) throw new Error('The game is over.');
    if (!this.legalCards().includes(c)) throw new Error(`Card ${c} is not legal now.`);
    if (this.phase === PASS) this.passCard(this.current, c);
    else this.playCard(this.current, c);
  }
}

/** The final standing, lowest score first: each seat's place (0 = first), ties sharing the best place. */
export function places(scores) {
  return scores.map(score => scores.filter(other => other < score).length);
}
