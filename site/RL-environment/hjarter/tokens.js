// Hjärter token streams: a port of cardgym's games/hjarter/tokens.py (the seats'
// streams; the critic's oracle stream stays in the gym). One token per card
// event, rules and score on every token. A seat's stream of one deal:
//
//   [DEAL] [HAND x n]     its dealt cards, sorted
//   [TURN] [PASS x k]     its passing (the readout, then each card it passes)
//   [RECEIVE x k]         the cards passed to it, after everyone has passed
//   [PLAY x P*n]          every card played, by anyone
//
// A token's fields are categorical codes; seats are relative to the observer
// (0 is itself). The policy reads the acting seat's last token.
import { NUM_RANKS, MAX_PLAYERS, MAX_PASS_CARDS, HAND_SIZES, K_DEAL, K_TURN, K_PASS, K_RECEIVE } from './engine.js?v=1';

export const TYPE_PAD = 0, TYPE_DEAL = 1, TYPE_HAND = 2, TYPE_TURN = 3, TYPE_PASS = 4, TYPE_RECEIVE = 5, TYPE_PLAY = 6;
const NUM_TYPES = 7, NUM_SUITS = 4, NUM_PHASES = 3;
const MAX_HAND = Math.max(...Object.values(HAND_SIZES));

export const F_TYPE = 0, F_SEAT = 1, F_RANK = 2, F_SUIT = 3, F_TRICK = 4, F_POSITION = 5, F_PLAYERS = 6;
export const F_NEXT_SEAT = 7, F_NEXT_PHASE = 8, F_LED = 9, F_WINNING = 10, F_TRICK_POINTS = 11, F_BROKEN = 12;
export const F_QUEEN = 13, F_JACK = 14, F_TAKEN = 15;
export const F_PASS_DIR = F_TAKEN + MAX_PLAYERS, F_RULE_PASS = F_PASS_DIR + 1, F_RULE_JACK = F_PASS_DIR + 2;
export const F_CONTEXT = F_RULE_JACK + 1;
const CONTEXT_WIDTH = 10;
export const WIDTH = F_CONTEXT + CONTEXT_WIDTH;

const SEAT_NA = MAX_PLAYERS, RANK_NA = NUM_RANKS, SUIT_NA = NUM_SUITS, TRICK_NA = MAX_HAND, POSITION_NA = MAX_PLAYERS;
// A trick's points so far: -10 (J♦ alone) to 17, offset by 10.
const TRICK_POINTS_OFFSET = 10, TRICK_POINTS_NA = 28;
const TAKEN_NA = 27;

// The game context: single deal or whole game, the score.
export const MODE_DEAL = 0, MODE_GAME = 1;
const EXACT_LEAD = 40, LEAD_STEP = 5, LEAD_LIMIT = 100;
const LEAD_SIDE = EXACT_LEAD + (LEAD_LIMIT - EXACT_LEAD) / LEAD_STEP;
const LEAD_NA = 2 * LEAD_SIDE + 1, LEAD_VOCAB = LEAD_NA + 1;
const EXACT_DISTANCE = 40, DISTANCE_LIMIT = 150;
const DISTANCE_VOCAB = EXACT_DISTANCE + (DISTANCE_LIMIT - EXACT_DISTANCE) / LEAD_STEP + 1;
const OPPONENTS = MAX_PLAYERS - 1;

export const FIELD_VOCAB = [
  NUM_TYPES, MAX_PLAYERS + 1, NUM_RANKS + 1, NUM_SUITS + 1, MAX_HAND + 1, MAX_PLAYERS + 1, MAX_PLAYERS + 1,
  MAX_PLAYERS + 1, NUM_PHASES, NUM_SUITS + 1, MAX_PLAYERS + 1, TRICK_POINTS_NA + 1, 2, MAX_PLAYERS + 1, MAX_PLAYERS + 1,
  ...Array(MAX_PLAYERS).fill(TAKEN_NA + 1), MAX_PLAYERS, MAX_PASS_CARDS + 1, 2,
  2, ...Array(OPPONENTS).fill(LEAD_VOCAB), OPPONENTS + 1, LEAD_VOCAB, LEAD_VOCAB, DISTANCE_VOCAB, DISTANCE_VOCAB,
];

/** A score difference: exact within ±40, then in steps of 5, clamped at ±100. */
export function leadCode(difference) {
  let magnitude = Math.min(Math.abs(difference), LEAD_LIMIT);
  if (magnitude > EXACT_LEAD) magnitude = EXACT_LEAD + Math.ceil((magnitude - EXACT_LEAD) / LEAD_STEP);
  return LEAD_SIDE + (difference >= 0 ? magnitude : -magnitude);
}

/** Points to the end score: exact up to 40, then in steps of 5, clamped to 0..150. */
export function distanceCode(distance) {
  distance = Math.min(Math.max(distance, 0), DISTANCE_LIMIT);
  if (distance > EXACT_DISTANCE) distance = EXACT_DISTANCE + Math.ceil((distance - EXACT_DISTANCE) / LEAD_STEP);
  return distance;
}

/** The context fields of `observer`'s tokens for a deal played from `scores` (absolute seats). */
export function gameContext(scores, observer, endScore, mode) {
  const players = scores.length, mine = scores[observer];
  const others = Array.from({ length: players - 1 }, (_, i) => scores[(observer + i + 1) % players]);
  const leads = [...others.map(other => leadCode(other - mine)), ...Array(OPPONENTS - others.length).fill(LEAD_NA)];
  return [
    mode, ...leads, others.filter(other => other < mine).length,
    leadCode(Math.min(...others) - mine), leadCode(Math.max(...others) - mine),
    distanceCode(endScore - mine), distanceCode(endScore - Math.max(...scores)),
  ];
}

/**
 * Every seat's stream, built from the engine's events as they happen (pass
 * `writer.onEvent` as the engine's listener). Each deal starts a fresh
 * context: `streams[seat]` holds the current deal's tokens.
 *
 * The context reads the engine's scores and `rules.endScore`, as the gym does.
 * `view` overrides them: an agent trained on single deals saw a fresh deal
 * every time, `{ scores: zeros, endScore: 100 }`.
 */
export class ObservationWriter {
  constructor(players, rules, mode, view = null) {
    this.players = players;
    this.rules = rules;
    this.mode = mode;
    this.view = view;
    this.streams = Array.from({ length: players }, () => []);
    this.contexts = [];
    this.template = [];
  }

  /** Seat 0's row in `observer`'s frame. */
  relative(row, observer) {
    const players = this.players, out = [...row];
    if (observer) {
      for (const slot of [F_SEAT, F_NEXT_SEAT, F_WINNING, F_QUEEN, F_JACK]) {
        if (out[slot] !== SEAT_NA) out[slot] = (out[slot] - observer + players) % players;
      }
      for (let rel = 0; rel < players; rel++) out[F_TAKEN + rel] = row[F_TAKEN + ((observer + rel) % players)];
    }
    out.splice(F_CONTEXT, CONTEXT_WIDTH, ...this.contexts[observer]);
    return out;
  }

  /** The event's row in seat 0's frame. */
  row(engine, event, kind) {
    const row = [...this.template];
    row[F_TYPE] = kind;
    row[F_NEXT_SEAT] = event.nextSeat < 0 ? SEAT_NA : event.nextSeat;
    row[F_NEXT_PHASE] = event.nextPhase;
    row[F_BROKEN] = Number(engine.broken);
    row[F_QUEEN] = engine.queenTaker < 0 ? SEAT_NA : engine.queenTaker;
    row[F_JACK] = engine.jackTaker < 0 ? SEAT_NA : engine.jackTaker;
    for (let seat = 0; seat < this.players; seat++) row[F_TAKEN + seat] = engine.taken[seat];
    return row;
  }

  static card(row, c) {
    row[F_SUIT] = Math.floor(c / NUM_RANKS);
    row[F_RANK] = c % NUM_RANKS;
    return row;
  }

  onEvent(engine, event) {
    const { kind } = event;
    if (kind === K_DEAL) { this.openDeal(engine, event); return; }
    if (kind === K_TURN || kind === K_PASS || kind === K_RECEIVE) {
      const type = kind === K_TURN ? TYPE_TURN : kind === K_PASS ? TYPE_PASS : TYPE_RECEIVE;
      const row = this.row(engine, event, type);
      if (kind !== K_TURN) ObservationWriter.card(row, event.card);
      row[F_SEAT] = kind === K_RECEIVE ? event.giver : event.seat;
      this.streams[event.seat].push(this.relative(row, event.seat));
      return;
    }
    const row = ObservationWriter.card(this.row(engine, event, TYPE_PLAY), event.card);
    row[F_SEAT] = event.seat;
    row[F_TRICK] = event.trick;
    row[F_POSITION] = event.position;
    row[F_LED] = event.led;
    row[F_WINNING] = event.winning;
    row[F_TRICK_POINTS] = event.points + TRICK_POINTS_OFFSET;
    for (let observer = 0; observer < this.players; observer++) this.streams[observer].push(this.relative(row, observer));
  }

  openDeal(engine, event) {
    const { players, rules } = this;
    const scores = this.view?.scores ?? engine.scores, endScore = this.view?.endScore ?? rules.endScore;
    this.contexts = Array.from({ length: players }, (_, seat) => gameContext(scores, seat, endScore, this.mode));
    const template = Array(WIDTH).fill(0);
    template[F_SEAT] = SEAT_NA;
    template[F_RANK] = RANK_NA;
    template[F_SUIT] = SUIT_NA;
    template[F_TRICK] = TRICK_NA;
    template[F_POSITION] = POSITION_NA;
    template[F_PLAYERS] = players;
    template[F_LED] = SUIT_NA;
    template[F_WINNING] = SEAT_NA;
    template[F_TRICK_POINTS] = TRICK_POINTS_NA;
    template.fill(TAKEN_NA, F_TAKEN, F_TAKEN + MAX_PLAYERS);
    template[F_PASS_DIR] = engine.direction;
    template[F_RULE_PASS] = rules.passCards;
    template[F_RULE_JACK] = Number(rules.jackOfDiamonds);
    template.splice(F_CONTEXT, CONTEXT_WIDTH, ...this.contexts[0]);
    this.template = template;
    const deal = this.row(engine, event, TYPE_DEAL);
    // A fresh context: each deal's stream starts empty.
    this.streams = Array.from({ length: players }, () => []);
    for (let observer = 0; observer < players; observer++) {
      this.streams[observer].push(this.relative(deal, observer));
      for (const c of [...engine.hands[observer]].sort((a, b) => a - b)) {
        const row = ObservationWriter.card([...deal], c);
        row[F_TYPE] = TYPE_HAND;
        row[F_SEAT] = observer;
        this.streams[observer].push(this.relative(row, observer));
      }
    }
  }
}
