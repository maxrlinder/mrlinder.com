import {
  PiquetDeal, shuffledDeck, rubicon, name, isRed, suitOf, rankOf, popcount, cardsOf, has, best, compare, score, viewCodes,
  EXCHANGE, DECLARE, PLAY, STOP, QUIET, SPEAK, POINT, SEQUENCE, SETS, RANKS, SUITS, SUIT_WORDS,
  EV_DEAL, EV_CARTE_BLANCHE, EV_EXCHANGE, EV_ANNOUNCE, EV_RESOLVE, EV_PLAY, EV_DEAL_END,
  SAID_NOTHING, DECLARED, CONCEDED, BONUS_REPIQUE, BONUS_PIQUE, BONUS_CARDS, BONUS_CAPOT,
  V_UNKNOWN, V_MINE, V_MINE_LEGAL, V_SELECTED, V_DISCARDED, V_SEEN_TALON, V_OPP, V_OPP_MAYBE, V_PLAYED_ME, V_PLAYED_OPP, V_TRICK_ME, V_TRICK_OPP,
} from './engine.js?v=2';
import { PiquetAgent } from './model-client.js?v=2';
import { difficultyLabel, snapDifficulty, temperatureFor } from '../difficulty.js';

const $ = id => document.getElementById(id);
const agent = new PiquetAgent();
// You are seat 0, the agent seat 1; the deal decides who is Elder.
const ME = 0, BOT = 1, NAMES = ['You', 'Fern'];
// A partie: six deals, Rubicon scoring.
const PARTIE_DEALS = 6;
let deal = null, engine = null, busy = false, failure = false, generation = 0, stateId = 0;
let selected = [], difficulty = 50, dealNumber = 0, firstDealer = 0;
let totals = [0, 0], history = [], scored = false, agentInfo = null;
// Local remarks on log entries, by entry number: whether the agent agreed with your move.
let notes = new Map();
// The agent's readout of your decision, and its read of the hidden cards.
let hint = null, hintRequest = 0, reading = null, readRequest = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const autoplay = () => $('autoplay').getAttribute('aria-pressed') === 'true';
// Slider 0..100 → a pause of 1.1 s down to nothing between the agent's moves.
const moveDelay = () => Math.round(1100 * Math.pow(1 - Number($('speed').value) / 100, 1.5));
const agentSeat = seat => seat === BOT || (seat === ME && autoplay());
const humanTurn = () => engine && !engine.done && engine.current === ME && !autoplay() && !busy && !failure;
const plural = (n, word) => `${n} ${n === 1 ? word : word + 's'}`;
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const cardAsset = card => `/resources/cards/${SUIT_WORDS[suitOf(card)]}-${RANKS[rankOf(card)].toLowerCase()}.svg`;
const chip = card => `<b class="card-chip ${isRed(card) ? 'is-red' : ''}">${name(card)}</b>`;
const chips = cards => cards.map(chip).join(' ');
// Hand order: suits alternate colour (♠ ♥ ♣ ♦), low to high within each.
const SUIT_ORDER = [0, 1, 3, 2];
const handOrder = cards => [...cards].sort((a, b) => SUIT_ORDER.indexOf(suitOf(a)) - SUIT_ORDER.indexOf(suitOf(b)) || a - b);
const roleOf = seat => seat === engine.elder ? 'Elder' : 'Younger';
// Verbs agree with "You" or the agent's name.
const verb = (seat, mine, theirs) => seat === ME ? mine : theirs;
// A seat's name inside a sentence.
const named = seat => seat === ME ? 'you' : NAMES[seat];

// ---- Naming combinations -----------------------------------------------------
const CATEGORY_NAMES = ['point', 'sequence', 'sets'];
const COUNT_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const SEQUENCE_WORDS = { 3: 'tierce', 4: 'quart', 5: 'quint', 6: 'sixième', 7: 'septième', 8: 'huitième' };
const RANK_WORDS = ['seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace'];
const RANK_PLURALS = ['sevens', 'eights', 'nines', 'tens', 'jacks', 'queens', 'kings', 'aces'];
function describeKey(category, key) {
  if (category === POINT) return `point of ${COUNT_WORDS[key[0]]} (${key[1]})`;
  if (category === SEQUENCE) return `${SEQUENCE_WORDS[key[0]]} to the ${RANK_WORDS[key[1]]}`;
  return `${key[0] === 4 ? 'quatorze' : 'trio'} of ${RANK_PLURALS[key[1]]}`;
}
// For the declarations board: "5 · 47", "Quart to K", "Trio of Q".
function shortKey(category, key) {
  if (category === POINT) return `${key[0]} cards · ${key[1]}`;
  if (category === SEQUENCE) return `${SEQUENCE_WORDS[key[0]][0].toUpperCase()}${SEQUENCE_WORDS[key[0]].slice(1)} to ${RANKS[key[1]]}`;
  return `${key[0] === 4 ? 'Quatorze' : 'Trio'} of ${RANKS[key[1]]}`;
}
const upperFirst = text => text[0].toUpperCase() + text.slice(1);
const lowerFirst = text => text[0].toLowerCase() + text.slice(1);

// ---- Table flow ---------------------------------------------------------------

function newPartie() {
  totals = [0, 0]; history = []; dealNumber = 0;
  firstDealer = Math.random() < 0.5 ? ME : BOT;
  startDeal();
}

function startDeal() {
  generation++; dealNumber++; scored = false; selected = []; notes = new Map(); failure = false; busy = false;
  hint = null; reading = null;
  // The cut for deal decides the first dealer; then the deal alternates. Each
  // deal is a fresh context whose tokens carry the score, as in training.
  deal = new PiquetDeal({ deck: shuffledDeck(), dealer: firstDealer ^ ((dealNumber - 1) % 2), partie: { totals, deal: dealNumber - 1 } });
  engine = deal.engine;
  stateId++;
  setAutoplay(false);
  $('game-error').hidden = true; $('result-dialog').hidden = true;
  $('setup').hidden = true; $('game').hidden = false; $('loading').hidden = true;
  render();
  window.scrollTo({ top: 0 });
  void advanceBots();
}

const partieOver = () => dealNumber >= PARTIE_DEALS;

function apply(action) {
  deal.apply(action);
  stateId++;
  render();
  if (engine.done) setTimeout(finishDeal, 500);
}

async function advanceBots() {
  if (busy || failure || !engine || engine.done) return;
  const version = generation;
  busy = true;
  try {
    while (version === generation && !engine.done && agentSeat(engine.current)) {
      render();
      const acting = engine.current, head = engine.head, legal = engine.legalActions();
      // Auto-play plays your hand with the agent's best move; the difficulty is for the opponent.
      const temperature = acting === ME ? 0 : temperatureFor(difficulty);
      // Choosing discards is private and quick: only the first choice waits.
      const wait = head === 'exchange' && engine.selected ? 0 : moveDelay();
      const [action] = await Promise.all([agent.choose(deal.streams[acting], head, legal, temperature), pause(wait)]);
      if (version !== generation) return;
      // Turning off auto-play during inference gives control back before the move.
      if (!agentSeat(acting)) break;
      apply(action);
    }
  } catch (error) {
    if (version !== generation) return;
    failure = true;
    $('game-error-message').textContent = `The agent stopped: ${error.message}`;
    $('game-error').hidden = false;
  } finally {
    if (version === generation) { busy = false; render(); void requestHint(); }
  }
}

// ---- Your moves ----------------------------------------------------------------

function userMove(actions, note) {
  if (!humanTurn()) return;
  const entry = deal.log.length;
  for (const action of actions) {
    if (!humanTurn() || !engine.legalActions().includes(action)) break;
    deal.apply(action);
  }
  // The remark goes on the first event the move logged.
  if (note) notes.set(entry, note);
  selected = []; stateId++;
  render();
  if (engine.done) setTimeout(finishDeal, 500);
  void advanceBots();
}

// Your discards go to the engine one at a time, as the agent chooses its own,
// then "stop" (unless the last allowed card already closed the exchange).
function userExchange() {
  if (!humanTurn() || engine.phase !== EXCHANGE || selected.length < engine.minDiscards) return;
  const advice = currentHint(), cards = [...selected];
  let note = '';
  if (advice?.plan) {
    const theirs = advice.plan.cards;
    note = sameSet(theirs, cards) ? ' The agent agrees.' : ` The agent would exchange ${theirs.length ? chipsText(theirs) : 'nothing'}.`;
  }
  const moves = [...cards];
  if (cards.length < engine.maxDiscards) moves.push(STOP);
  userMove(moves, note);
}

const sameSet = (a, b) => a.length === b.length && a.every(card => b.includes(card));
const chipsText = cards => handOrder(cards).map(name).join(' ');

function userAction(action) {
  const advice = currentHint();
  let note = '';
  if (advice) {
    const pick = advice.actions[advice.argmax];
    note = pick === action ? ' The agent agrees.' : ` The agent would ${lowerFirst(describeAction(pick))}.`;
  }
  userMove([action], note);
}

function describeAction(action) {
  if (engine.phase === PLAY) return `Play the ${name(action)}`;
  if (engine.phase === DECLARE) return declareLabel(action).replace(/\.$/, '');
  return action === STOP ? 'Stop choosing' : `Exchange the ${name(action)}`;
}

// ---- The agent's readouts ---------------------------------------------------------
// Two switches: the agent's move (its odds on every move) and the advantage.
const showOdds = () => $('hints').checked, showWorth = () => $('values').checked;
const wantsAdvice = () => showOdds() || showWorth();
const currentAdvice = () => wantsAdvice() && hint && hint.id === stateId ? hint : null;
const currentHint = () => showOdds() ? currentAdvice() : null;
const currentWorth = () => showWorth() && currentAdvice() ? hint : null;

// The value head reads both seats from the viewer's; its zero-sum part is what
// you can expect to score: the partie's Rubicon payoff (positive when you win
// it), or with a single-deal model your points minus your opponent's this deal.
const ownValue = values => (values[0] - values[1]) / 2;
const partieValue = () => agentInfo?.valueTarget !== 'deal';
// Payoffs run to hundreds: whole points. Deal margins: tenths.
const worthDigits = () => (partieValue() ? 0 : 1);
const worthMeaning = () => (partieValue()
  ? 'the agent’s estimate of what this partie will score for you: the Rubicon payoff, positive if you win it'
  : 'the agent’s estimate of your points minus Fern’s at the end of this deal');
// The value head learned from the states the agent's own play reaches: after a
// move it all but never makes, its reading is an extrapolation, shown greyed.
const RARE = 0.01;
const EXCHANGE_SAMPLES = 16, CONCEDE_SAMPLES = 12, TRIES = 6000;

// The decision the readouts are about. While you choose discards, it is the
// one after the cards you picked so far (applied on a copy of the table).
function adviceState() {
  if (engine.phase !== EXCHANGE) return { sim: deal, full: false };
  const full = selected.length >= engine.maxDiscards;
  const sim = deal.clone();
  for (const card of full ? selected.slice(0, -1) : selected) sim.apply(card);
  return { sim, full };
}

// Each move's after-state is your stream plus one token: your own event (a card
// played, a declaration, an exchange), or your next decision while you choose
// discards. The value head is trained at every token, so this is the state the
// agent itself values. When that token would show cards you cannot see (what
// an exchange draws from the talon, the cards your opponent shows when you
// concede), it is averaged over re-deals of the cards hidden from you instead.
function needsSamples(sim, seat, action) {
  const e = sim.engine;
  if (e.phase === EXCHANGE) return action === STOP || popcount(e.selected) + 1 >= e.maxDiscards;
  return e.phase === DECLARE && seat !== e.elder && e.announced !== null && action === QUIET;
}

const firstToken = (sim, seat, action) => {
  const before = sim.streams[seat].length;
  sim.apply(action);
  return sim.streams[seat][before];
};

// The combinations each announcement claimed, which a re-deal must reproduce.
// Point: length and total; sequence: length and top; sets: size and rank (a point's suit is never said).
const keyFields = key => [key[0], key[1]];
function claims(sim) {
  return sim.engine.events.filter(ev => ev.kind === EV_ANNOUNCE && ev.status === DECLARED).map(ev => [ev.category, keyFields(ev.key)]);
}

// Reassign the cards `seat` cannot place among the places they could be, as
// the seat sees it: its view (every token) is unchanged, the hidden truth is not.
function determinize(sim, seat, claimed) {
  const e = sim.engine, codes = viewCodes(e, seat), opponent = 1 - seat;
  const loose = [], fixedToOpponent = [];
  codes.forEach((code, card) => {
    if (code === V_UNKNOWN) loose.push(card);
    // Shown by carte blanche, now in the opponent's hand or discards.
    else if (code === V_OPP_MAYBE && e.info[seat][card] !== 1) fixedToOpponent.push(card);
  });
  const slots = [...loose, ...fixedToOpponent].map(card => e.where[card]);
  const opponentSlots = slots.map((w, i) => (w < 10 ? i : -1)).filter(i => i >= 0);
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const order = [...slots.keys()];
    const free = new Set(order);
    const placed = new Map();
    // Carte blanche cards first, into the opponent's hand or discards only.
    const pool = [...opponentSlots];
    for (const card of fixedToOpponent) {
      const pick = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      placed.set(card, slots[pick]); free.delete(pick);
    }
    const rest = [...free];
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    loose.forEach((card, i) => placed.set(card, slots[rest[i]]));
    const hand = [...placed].reduce((mask, [card, w]) => (w === opponent ? (mask | (1 << card)) >>> 0 : mask), e.hands[opponent] & ~maskOfCards([...placed.keys()]));
    if (claimed.every(([category, fields]) => { const key = best(category, hand); return key && keyFields(key).every((v, i) => v === fields[i]); })) {
      for (const [card, w] of placed) e.where[card] = w;
      e.rebuild();
      return true;
    }
  }
  return false;
}
const maskOfCards = cards => cards.reduce((m, c) => (m | (1 << c)) >>> 0, 0);

// Every move's after-state tokens; a plan entry lists its tokens.
function lookAhead(sim, seat, actions) {
  const rows = [], plan = [];
  for (const action of actions) {
    if (!needsSamples(sim, seat, action)) {
      rows.push(firstToken(sim.clone(), seat, action));
      plan.push([rows.length - 1]);
      continue;
    }
    const exchange = sim.engine.phase === EXCHANGE, claimed = exchange ? [] : claims(sim), parts = [];
    for (let k = 0; k < (exchange ? EXCHANGE_SAMPLES : CONCEDE_SAMPLES); k++) {
      const copy = sim.clone();
      if (!determinize(copy, seat, claimed)) break;
      rows.push(firstToken(copy, seat, action));
      parts.push(rows.length - 1);
    }
    plan.push(parts);
  }
  return { rows, plan };
}

// Your advantage now and after each move. The moves' values are shifted
// together so that they average to the value now under the policy, as an
// advantage function's must; the shift is the value head's noise.
function advantages(policy, plan) {
  const now = ownValue(policy.value);
  const raw = plan.map(parts => parts.length ? parts.reduce((sum, row) => sum + ownValue(policy.after[row]), 0) / parts.length : null);
  let mass = 0, expected = 0;
  raw.forEach((v, i) => { if (v !== null) { mass += policy.probabilities[i]; expected += policy.probabilities[i] * v; } });
  const gap = mass ? expected / mass - now : 0;
  const after = raw.map(v => (v === null ? null : v - gap));
  const usable = after.filter((v, i) => v !== null && policy.probabilities[i] >= RARE);
  return { now, after, best: usable.length ? Math.max(...usable) : null };
}

// The cards the agent would exchange from here: its top choice, one card at a time, until it stops.
async function exchangePlan(sim, first) {
  const cards = [];
  let state = sim, action = first;
  while (action !== STOP && cards.length < 8) {
    cards.push(action);
    state = state.clone();
    state.apply(action);
    if (state.engine.phase !== EXCHANGE || state.engine.current !== ME) break;
    action = await agent.choose(state.streams[ME], 'exchange', state.engine.legalActions(), 0);
  }
  return cards;
}

async function assess() {
  const asked = stateId, { sim, full } = adviceState();
  const actions = sim.engine.legalActions(), head = sim.engine.head;
  const ahead = lookAhead(sim, ME, actions);
  const policy = await agent.policy(sim.streams[ME], head, actions, ahead.rows);
  if (asked !== stateId) return null;
  let plan = null;
  if (head === 'exchange') {
    const extra = full ? [] : await exchangePlan(sim, actions[policy.argmax]);
    if (asked !== stateId) return null;
    plan = { cards: full ? [...selected] : [...selected, ...extra] };
  }
  return { id: asked, head, actions, full, plan, probabilities: policy.probabilities, argmax: policy.argmax, belief: policy.belief, ...advantages(policy, ahead.plan) };
}

async function requestHint() {
  const request = ++hintRequest;
  if (!wantsAdvice() || !humanTurn()) { if (hint) { hint = null; render(); } return; }
  if (hint?.id === stateId) return;
  try {
    const advice = await assess();
    if (request !== hintRequest || !advice) return;
    hint = advice;
    render();
  } catch (error) {
    console.error('The agent’s readout failed.', error);
  }
}

// The agent's belief head for your seat: where each card you cannot place is.
async function requestReading() {
  if (!$('beliefs').checked || !deal) return;
  const key = `${generation}:${deal.streams[ME].length}`;
  if (reading?.key === key) return;
  const request = ++readRequest;
  try {
    const stream = deal.streams[ME];
    const { belief } = await agent.policy(stream, 'declare', [QUIET, SPEAK]);
    if (request !== readRequest) return;
    reading = { key, belief, codes: viewCodes(engine, ME) };
    renderCardRead();
  } catch (error) {
    console.error('The agent’s card read failed.', error);
  }
}

const percent = p => `${Math.round(p * 100)}%`;
// Points with their sign, a true minus, and `digits` decimals.
const points = (v, digits = 0) => {
  const text = Math.abs(v).toFixed(digits);
  return Number(text) === 0 ? text : `${v < 0 ? '−' : '+'}${text}`;
};

// A badge naming the move, on the thing the move uses: with the agent's move
// on, its odds (the agent's own pick is the highlighted one); with the
// advantage on, your advantage once the move is made.
function marks(index, word) {
  const advice = currentAdvice();
  if (!advice || index < 0) return '';
  const odds = Boolean(currentHint()), worth = Boolean(currentWorth()), pick = odds && advice.argmax === index;
  if (!worth && (!odds || (!pick && advice.probabilities[index] < 0.005))) return '';
  const value = advice.after[index];
  const known = worth && value !== null;
  const rare = advice.probabilities[index] < RARE;
  const digits = worthDigits();
  const title = [pick ? 'The agent’s next move' : '', known ? `Your advantage after this move: ${points(value, digits)} (now ${points(advice.now, digits)})` : '', known && rare ? 'The agent almost never plays this, so this value is a rough extrapolation' : ''].filter(Boolean).join('. ');
  // The best move, and any that shows the same number.
  const cls = rare ? 'is-rare' : advice.best !== null && value >= advice.best - 0.5 * 10 ** -digits ? 'is-best' : '';
  return `<span class="prob-badge ${pick ? 'is-pick' : ''}" title="${title}"><span class="badge-verb">${word}</span>${odds ? `<b>${percent(advice.probabilities[index])}</b>` : ''}${known ? `<i class="badge-value ${cls}">${points(value, digits)}</i>` : ''}</span>`;
}

// ---- Rendering --------------------------------------------------------------------

function render() {
  if (!engine) return;
  const interactive = humanTurn();
  $('plaque').innerHTML = `<strong>Deal ${dealNumber} of ${PARTIE_DEALS}</strong>You are ${roleOf(ME)}`;
  $('agent-label').textContent = agentInfo ? `Self-play agent · checkpoint ${agentInfo.run} / ${agentInfo.iteration.toLocaleString()}.` : '';
  renderStatus(interactive);
  renderOpponent();
  renderTalon();
  renderBoard();
  renderTrick();
  renderHand(interactive);
  renderActions(interactive);
  renderScores();
  renderLog();
  if ($('beliefs').checked) { renderCardRead(); void requestReading(); }
}

function renderStatus(interactive) {
  const latest = deal.log.length ? describe(deal.log.at(-1)) : '';
  let status;
  if (engine.done) status = `${latest} The deal is over.`;
  else if (failure) status = 'The agent stopped. Retry to continue this deal.';
  else if (engine.current !== ME || autoplay()) {
    const doing = engine.current === ME ? 'The agent is playing for you' : engine.phase === EXCHANGE ? 'Fern is choosing discards' : 'Fern is thinking';
    status = `${doing}…${latest ? ` ${latest}` : ''}`;
  } else if (engine.phase === EXCHANGE) status = `Your exchange.${latest ? ` ${latest}` : ''}`;
  else if (engine.phase === DECLARE) status = `${upperFirst(CATEGORY_NAMES[engine.category])}: your call.${latest ? ` ${latest}` : ''}`;
  else status = `${engine.trick.length ? 'Your play.' : 'Your lead.'}${latest ? ` ${latest}` : ''}`;
  const advice = interactive && currentHint();
  if (advice) status = adviceText(advice);
  else if (interactive && wantsAdvice() && !currentAdvice()) status += ' The agent is considering…';
  $('status').textContent = status;
  $('status').classList.toggle('is-advice', Boolean(advice));
}

function adviceText(advice) {
  if (advice.head === 'exchange') {
    const cards = advice.plan.cards;
    return cards.length ? `The agent would exchange ${plural(cards.length, 'card')}: ${chipsText(cards)}` : 'The agent would keep its hand.';
  }
  return `The agent would: ${lowerFirst(describeAction(advice.actions[advice.argmax]))} · ${percent(advice.probabilities[advice.argmax])}`;
}

// What the opponent's latest event says, in a few words under its seat.
function shortAction(ev) {
  if (ev.kind === EV_CARTE_BLANCHE) return 'Carte blanche';
  if (ev.kind === EV_EXCHANGE) return `Exchanged ${ev.count}`;
  if (ev.kind === EV_ANNOUNCE) return ev.status === DECLARED ? upperFirst(describeKey(ev.category, ev.key)) : `Nothing for ${CATEGORY_NAMES[ev.category]}`;
  if (ev.kind === EV_RESOLVE) return ev.status === CONCEDED ? '“Good”' : ev.status === DECLARED ? (ev.winner < 0 ? '“Equal”' : upperFirst(describeKey(ev.category, ev.key))) : `Nothing for ${CATEGORY_NAMES[ev.category]}`;
  if (ev.kind === EV_PLAY) return `${ev.winner < 0 ? 'Led' : 'Played'} ${name(ev.card)}`;
  return '';
}

function renderOpponent() {
  const seat = BOT, current = !engine.done && engine.current === seat;
  const codes = viewCodes(engine, ME);
  const count = popcount(engine.hands[seat]);
  const known = codes.flatMap((code, card) => (code === V_OPP ? [card] : []));
  const maybe = codes.flatMap((code, card) => (code === V_OPP_MAYBE ? [card] : []));
  const last = [...deal.log].reverse().find(ev => ev.actor === seat && ev.kind !== EV_DEAL);
  const tag = current && busy ? 'thinking…' : 'AI';
  $('opponent').className = `seat piquet-seat ${current ? 'is-current' : ''}`;
  $('opponent').innerHTML = `<div class="seat-name"><span>Fern · ${roleOf(seat)}</span><span>${tag}</span></div>
    <div class="opponent-hand" aria-hidden="true">${'<span class="opponent-card"></span>'.repeat(count)}</div>
    <div class="seat-stats"><span>${plural(count, 'card')}</span><span>${plural(engine.tricks[seat], 'trick')}</span><span>${engine.points[seat]} pts</span><span>Σ ${totals[seat]}</span></div>
    <div class="seat-notes">${known.length ? `<span class="seat-known">Holds ${chips(handOrder(known))}</span>` : ''}${maybe.length ? `<span class="seat-known">Hand or discards ${chips(handOrder(maybe))}</span>` : ''}${last ? `<span class="seat-action">${escapeHtml(shortAction(last))}</span>` : ''}</div>`;
}

function renderTalon() {
  const codes = viewCodes(engine, ME), size = engine.talon.length;
  const seen = codes.flatMap((code, card) => (code === V_SEEN_TALON ? [card] : []));
  const mine = codes.flatMap((code, card) => (code === V_DISCARDED ? [card] : []));
  const theirs = engine.exchanged[BOT] ? engine.exchangedCount[BOT] : null;
  const layers = Math.min(size, 4);
  $('talon-area').innerHTML = `<div class="pile-stack talon-stack">${size ? Array.from({ length: layers }, (_, i) => `<span class="pile-card card-back" style="--layer:${layers - 1 - i}"></span>`).join('') : '<span class="pile-empty">Empty</span>'}</div>
    <span class="pile-label">Talon <b>${size}</b></span>
    ${seen.length ? `<p class="talon-note"><span>Left for Younger</span>${chips(handOrder(seen))}</p>` : ''}
    ${mine.length ? `<p class="talon-note"><span>Your discards</span>${chips(handOrder(mine))}</p>` : ''}
    ${theirs !== null ? `<p class="talon-note"><span>Fern’s discards</span>${theirs ? `${plural(theirs, 'card')}, face down` : 'none'}</p>` : ''}`;
}

// The declarations so far: each category's call, answer and score.
function declarations() {
  const rows = [0, 1, 2].map(() => ({}));
  for (const ev of deal.log) {
    if (ev.kind === EV_ANNOUNCE) rows[ev.category].call = ev;
    if (ev.kind === EV_RESOLVE) rows[ev.category].answer = ev;
  }
  return rows;
}

function renderBoard() {
  if (engine.phase === EXCHANGE) {
    const elder = engine.elder, younger = 1 - elder;
    const line = seat => {
      const who = NAMES[seat];
      if (engine.exchanged[seat]) return `<li><b>${who}</b> exchanged ${plural(engine.exchangedCount[seat], 'card')}.</li>`;
      if (engine.current === seat) return `<li class="is-current"><b>${who}</b> ${seat === elder ? `must exchange 1 to ${engine.maxDiscards} cards` : `may exchange up to ${plural(engine.maxDiscards, 'card')}`}…</li>`;
      return `<li><b>${who}</b> ${verb(seat, 'exchange', 'exchanges')} next.</li>`;
    };
    const blanche = deal.log.filter(ev => ev.kind === EV_CARTE_BLANCHE).map(ev => `<li class="is-score"><b>${NAMES[ev.actor]}</b> ${verb(ev.actor, 'show', 'shows')} carte blanche: +10.</li>`).join('');
    $('board').innerHTML = `<h3>The exchange</h3><ol class="board-lines">${blanche}${line(elder)}${line(younger)}</ol>`;
    return;
  }
  const rows = declarations();
  const body = rows.map(({ call, answer }, category) => {
    const active = engine.phase === DECLARE && engine.category === category;
    const elderSays = !call ? '' : call.status === DECLARED ? shortKey(category, call.key) : '—';
    let youngerSays = '';
    if (answer) {
      if (answer.status === CONCEDED) youngerSays = 'Good';
      else if (answer.status === DECLARED) youngerSays = `${shortKey(category, answer.key)}${call?.status === DECLARED ? (answer.winner < 0 ? ' · equal' : ' · not good') : ''}`;
      else youngerSays = '—';
    }
    const result = !answer ? (active ? '…' : '') : answer.winner < 0 ? 'No score' : `${NAMES[answer.winner]} +${answer.points}${answer.bonus === BONUS_REPIQUE ? ' · repique +60' : ''}`;
    const winner = answer && answer.winner >= 0 ? (answer.winner === ME ? 'is-mine' : 'is-theirs') : '';
    return `<tr class="${active ? 'is-active' : ''} ${winner}"><th>${upperFirst(CATEGORY_NAMES[category])}</th><td>${escapeHtml(elderSays)}</td><td>${escapeHtml(youngerSays)}</td><td class="board-result">${escapeHtml(result)}</td></tr>`;
  }).join('');
  const elderName = engine.elder === ME ? 'You' : 'Fern', youngerName = engine.elder === ME ? 'Fern' : 'You';
  $('board').innerHTML = `<h3>Declarations</h3><table class="board-table"><thead><tr><th></th><th>${elderName} <small>Elder</small></th><th>${youngerName} <small>Younger</small></th><th>Score</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderTrick() {
  const trickCard = (seat, card, label, winner) => `<figure class="played-card ${winner ? 'is-winner' : ''}"><img src="${cardAsset(card)}" alt="${name(card)}" width="90" height="126" draggable="false" /><figcaption>${label}</figcaption></figure>`;
  let cards = '', caption = '';
  if (engine.trick.length) {
    const [[seat, card]] = engine.trick;
    cards = trickCard(seat, card, `${NAMES[seat]} led`, false) + `<figure class="played-card is-empty"><span></span><figcaption>${NAMES[1 - seat]}</figcaption></figure>`;
    caption = `Trick ${engine.trickIndex + 1} of 12`;
  } else if (engine.lastTrick) {
    const { leader, led, follower, card, winner } = engine.lastTrick;
    cards = trickCard(leader, led, `${NAMES[leader]} led`, winner === leader) + trickCard(follower, card, NAMES[follower], winner === follower);
    caption = `Trick ${engine.trickIndex}: ${named(winner)} ${verb(winner, 'win', 'wins')} it`;
  } else if (engine.phase === PLAY) caption = `${roleOf(ME) === 'Elder' ? 'You lead' : 'Fern leads'} to the first trick`;
  else caption = 'Twelve tricks follow the declarations';
  $('trick').innerHTML = `<div class="played-cards">${cards}</div><p class="trick-caption">${escapeHtml(caption)}</p><p class="trick-count">Tricks · You ${engine.tricks[ME]} · Fern ${engine.tricks[BOT]}</p>`;
}

function renderHand(interactive) {
  const worth = interactive && currentWorth();
  $('human-label').innerHTML = `<span>You · ${roleOf(ME)}</span><span>${plural(popcount(engine.hands[ME]), 'card')}</span><span>${plural(engine.tricks[ME], 'trick')}</span><span>${engine.points[ME]} pts</span><span>Σ ${totals[ME]}</span>${worth ? `<span class="advantage-now" title="${upperFirst(worthMeaning())}">Advantage ${points(worth.now, worthDigits())}</span>` : ''}`;
  $('human-label').classList.toggle('is-current', !engine.done && engine.current === ME);
  const exchanging = interactive && engine.phase === EXCHANGE, playing = interactive && engine.phase === PLAY;
  const legal = new Set(interactive ? engine.legalActions() : []);
  const advice = currentAdvice(), odds = currentHint();
  // The cards the agent's move would use glow: its whole exchange, or the card it would play.
  const advised = new Set(odds ? (odds.head === 'exchange' ? odds.plan.cards : odds.head === 'play' ? [odds.actions[odds.argmax]] : []) : []);
  const focused = document.activeElement?.dataset?.card;
  $('hand').classList.toggle('is-waiting', !interactive && !engine.done);
  $('hand').innerHTML = handOrder(cardsOf(engine.hands[ME])).map(card => {
    const chosen = exchanging && selected.includes(card);
    const usable = exchanging ? chosen || (selected.length < engine.maxDiscards) : playing && legal.has(card);
    let badge = '';
    if (advice && exchanging && !chosen && !advice.full) badge = marks(advice.actions.indexOf(card), 'Swap');
    else if (advice && playing && legal.has(card)) badge = marks(advice.actions.indexOf(card), 'Play');
    const label = `${name(card)}${chosen ? ', chosen to exchange' : ''}${playing && !legal.has(card) ? ', cannot be played: follow suit' : ''}`;
    return `<button type="button" class="rummy-card ${chosen ? 'is-selected' : ''} ${advised.has(card) ? 'is-advised' : ''} ${playing && !legal.has(card) ? 'is-illegal' : ''}" data-card="${card}" aria-label="${label}" ${exchanging ? `aria-pressed="${chosen}"` : ''} ${usable ? '' : 'disabled'}><img src="${cardAsset(card)}" alt="" draggable="false" />${badge}</button>`;
  }).join('');
  if (focused) $('hand').querySelector(`[data-card="${focused}"]`)?.focus({ preventScroll: true });
  fitHand();
}

// Fan the hand as wide as the room allows, as Rummy's does.
function fitHand() {
  const hand = $('hand'), cards = hand.querySelectorAll('.rummy-card');
  hand.style.removeProperty('--peek');
  if (cards.length < 2) return;
  const width = cards[0].offsetWidth, widest = parseFloat(getComputedStyle(hand).getPropertyValue('--peek-max')) || 0.68;
  const peek = Math.max(0.3, Math.min(widest, (hand.clientWidth - 8 - width) / ((cards.length - 1) * width)));
  hand.style.setProperty('--peek', peek.toFixed(3));
  hand.classList.remove('is-narrow');
  const badges = [...hand.querySelectorAll('.rummy-card .prob-badge:not(.is-pick)')];
  hand.classList.toggle('is-narrow', badges.some(badge => badge.offsetWidth + 3 > peek * width));
}

// The words on a declaration button.
function declareLabel(action) {
  const category = engine.category, mine = best(category, engine.hands[ME]), word = CATEGORY_NAMES[category];
  if (engine.current === engine.elder) return action === SPEAK ? `Declare a ${describeKey(category, mine)}` : `Say nothing (sink your ${word})`;
  const announced = engine.announced;
  if (announced !== null) {
    if (action === QUIET) return `“Good”: concede the ${word}`;
    return compare(category, mine, announced) > 0 ? `“Not good”: ${describeKey(category, mine)}` : `“Equal”: ${describeKey(category, mine)}`;
  }
  return action === SPEAK ? `Declare a ${describeKey(category, mine)}` : `Say nothing for the ${word}`;
}

function renderActions(interactive) {
  let help = '', buttons = '';
  const advice = currentAdvice();
  if (engine.done) {
    help = 'The deal is over.';
    if ($('result-dialog').hidden && scored) buttons = '<button class="game-button is-default" type="button" data-results>Show scores &amp; next deal</button>';
  } else if (failure) help = 'The agent stopped. Retry to continue.';
  else if (!interactive) help = engine.current === ME && autoplay() ? 'The agent is playing your hand.' : 'Fern is playing. Your cards stay private.';
  else if (engine.phase === EXCHANGE) {
    const elder = engine.elder === ME, count = selected.length, max = engine.maxDiscards, min = engine.minDiscards;
    help = count ? `${plural(count, 'card')} chosen. You draw as many from the talon.` : elder ? `Choose 1 to ${max} cards to exchange. Elder usually takes all ${max}.` : `Choose up to ${plural(max, 'card')} to exchange, or keep your hand.`;
    if (count >= max && max) help = `${plural(count, 'card')} chosen, the most you may exchange.`;
    const stopIndex = advice ? (advice.full ? advice.actions.indexOf(selected.at(-1)) : advice.actions.indexOf(STOP)) : -1;
    const pick = currentHint()?.plan?.cards;
    buttons = `<button class="game-button" type="button" data-clear ${count ? '' : 'disabled'}>Clear</button>`
      + (pick && !sameSet(pick, selected) ? '<button class="game-button" type="button" data-agent-pick>Choose the agent’s cards</button>' : '')
      + `<button class="game-button exchange-button ${count >= min ? 'is-default' : ''}" type="button" data-exchange ${count >= min ? '' : 'disabled'}>${count ? `Exchange ${plural(count, 'card')}` : min ? 'Exchange' : 'Keep my hand'}${count >= min ? marks(stopIndex, count ? 'Exchange' : 'Keep') : ''}</button>`;
  } else if (engine.phase === DECLARE) {
    const category = engine.category, mine = best(category, engine.hands[ME]);
    const announced = engine.announced, word = CATEGORY_NAMES[category];
    help = engine.current === engine.elder
      ? `Your ${word}: ${describeKey(category, mine)}, worth ${score(category, engine.hands[ME])}. Declare it, or sink it to keep your cards hidden.`
      : announced !== null
        ? `Fern declares a ${describeKey(category, announced)}. ${compare(category, mine, announced) > 0 ? 'Yours is better.' : 'Yours is equal: nobody scores it.'}`
        : `Fern said nothing for the ${word}. Yours is a ${describeKey(category, mine)}, worth ${score(category, engine.hands[ME])}.`;
    buttons = [SPEAK, QUIET].map(action => `<button class="game-button declare-button ${action === SPEAK ? 'is-default' : ''}" type="button" data-declare="${action}">${escapeHtml(declareLabel(action))}${marks(action, action === SPEAK ? 'Declare' : 'Quiet')}</button>`).join('');
  } else if (engine.phase === PLAY) {
    help = engine.trick.length ? `Follow suit if you can: ${SUITS[suitOf(engine.trick[0][1])]} was led.` : 'Your lead: play any card.';
  }
  $('selection-help').textContent = help;
  $('action-buttons').innerHTML = buttons;
}

function renderScores() {
  const head = '<thead><tr><th>Deal</th><th>You</th><th>Fern</th></tr></thead>';
  const cell = (v, other) => `<td class="${v > other ? 'is-hit' : ''}">${v}</td>`;
  const rows = history.map(h => `<tr><td>${h.deal}</td>${cell(h.points[ME], h.points[BOT])}${cell(h.points[BOT], h.points[ME])}</tr>`).join('');
  const live = engine && !scored ? `<tr class="is-active"><td>${dealNumber}</td><td>${engine.points[ME]}</td><td>${engine.points[BOT]}</td></tr>` : '';
  $('score-table').innerHTML = `${head}<tbody>${rows}${live}<tr class="score-total-row"><td>Total</td><td>${totals[ME]}</td><td>${totals[BOT]}</td></tr></tbody>`;
  $('score-caption').textContent = `Deal ${dealNumber} of ${PARTIE_DEALS}`;
  $('score-legend').textContent = 'Six deals. The higher total wins 100 plus the difference; a loser under 100 is rubiconed, and the winner scores 100 plus both totals.';
}

function renderLog() {
  $('turn-count').textContent = engine.phase === PLAY || engine.done ? `Trick ${Math.min(engine.trickIndex + 1, 12)}` : '';
  $('activity').innerHTML = deal.log.map((ev, i) => `<li>${escapeHtml(describe(ev) + (notes.get(i) ?? ''))}</li>`).reverse().join('');
}

// The agent's read of the cards you cannot see, from your seat.
function renderCardRead() {
  const panel = $('card-read');
  panel.hidden = !$('beliefs').checked;
  if (panel.hidden || !engine) return;
  const codes = viewCodes(engine, ME), fresh = reading && reading.key === `${generation}:${deal.streams[ME].length}`;
  const PLACE = { [V_MINE]: 'You', [V_MINE_LEGAL]: 'You', [V_SELECTED]: 'You', [V_DISCARDED]: 'Your discard', [V_SEEN_TALON]: 'Talon', [V_OPP]: 'Fern', [V_PLAYED_ME]: 'Played', [V_PLAYED_OPP]: 'Played', [V_TRICK_ME]: 'Played', [V_TRICK_OPP]: 'Played' };
  const cell = card => {
    const code = codes[card], hidden = code === V_UNKNOWN || code === V_OPP_MAYBE;
    if (!hidden) return `<span class="read-card is-${PLACE[code] === 'Played' ? 'played' : PLACE[code] === 'Fern' ? 'theirs' : PLACE[code] === 'Talon' ? 'talon' : 'mine'}" title="${name(card)}: ${PLACE[code]}"><b>${RANKS[rankOf(card)]}</b></span>`;
    const [hand, discard, talon] = fresh ? reading.belief[card] : [1 / 3, 1 / 3, 1 / 3];
    return `<span class="read-card is-hidden" title="${name(card)}: Fern’s hand ${percent(hand)} · Fern’s discards ${percent(discard)} · talon ${percent(talon)}" style="--hand:${hand.toFixed(3)};--discard:${discard.toFixed(3)};--talon:${talon.toFixed(3)}"><b>${RANKS[rankOf(card)]}</b><i aria-hidden="true"></i></span>`;
  };
  panel.innerHTML = `<div class="read-grid">${SUIT_ORDER.map(suit => `<span class="read-suit ${suit === 1 || suit === 2 ? 'is-red' : ''}">${SUITS[suit]}</span>${[0, 1, 2, 3, 4, 5, 6, 7].map(rank => cell(suit * 8 + rank)).join('')}`).join('')}</div>
    <p class="read-legend"><span class="key-hand"></span>Fern’s hand <span class="key-discard"></span>Fern’s discards <span class="key-talon"></span>Talon${fresh ? '' : ' · reading…'}</p>
    <p class="score-legend">For every card you cannot see, where the agent in your seat thinks it is. Hover a card for the numbers.</p>`;
}

function describe(ev) {
  const who = NAMES[ev.actor] ?? '', word = CATEGORY_NAMES[ev.category];
  switch (ev.kind) {
    case EV_DEAL: return `Deal ${dealNumber}: ${engine.dealer === ME ? 'you deal, Fern is Elder' : 'Fern deals, you are Elder'}.`;
    case EV_CARTE_BLANCHE: return `${who} ${verb(ev.actor, 'have', 'has')} carte blanche, +10: ${chipsText(cardsOf(ev.cards))}.${ev.bonus === BONUS_REPIQUE ? ' Repique, +60!' : ''}`;
    case EV_EXCHANGE: {
      const swap = ev.actor === ME && ev.count ? `: out ${chipsText(cardsOf(ev.discarded))}, in ${chipsText(cardsOf(ev.cards))}` : '';
      return ev.count ? `${who} exchanged ${plural(ev.count, 'card')}${swap}.` : `${who} kept ${verb(ev.actor, 'your hand', 'every card')}.`;
    }
    case EV_ANNOUNCE: return ev.status === DECLARED ? `${who} ${verb(ev.actor, 'declare', 'declares')} a ${describeKey(ev.category, ev.key)}.` : `${who} ${verb(ev.actor, 'say', 'says')} nothing for the ${word}.`;
    case EV_RESOLVE: {
      const repique = ev.bonus === BONUS_REPIQUE ? ` Repique: ${named(ev.bonusSeat)} ${verb(ev.bonusSeat, 'score', 'scores')} 60 more!` : '';
      const shows = ev.cards ? `, showing ${chipsText(cardsOf(ev.cards))}` : '';
      const winner = NAMES[ev.winner];
      if (ev.status === CONCEDED) return `${who}: “Good.” ${winner} ${verb(ev.winner, 'score', 'scores')} ${ev.points} for the ${word}${shows}.${repique}`;
      if (ev.status === DECLARED && ev.winner < 0) return `${who}: “Equal”, a ${describeKey(ev.category, ev.key)}. Nobody scores the ${word}.`;
      if (ev.status === DECLARED) return `${who} ${verb(ev.actor, 'declare', 'declares')} a ${describeKey(ev.category, ev.key)} and ${verb(ev.actor, 'score', 'scores')} ${ev.points}${shows}.${repique}`;
      return `Nobody scores the ${word}.`;
    }
    case EV_PLAY: {
      const pique = ev.bonus === BONUS_PIQUE ? ` Pique: ${named(ev.bonusSeat)} ${verb(ev.bonusSeat, 'score', 'scores')} 30 more!` : '';
      if (ev.winner < 0) return `${who} ${verb(ev.actor, 'lead', 'leads')} the ${name(ev.card)}.${pique}`;
      return `${who} ${verb(ev.actor, 'play', 'plays')} the ${name(ev.card)}; ${named(ev.winner)} ${verb(ev.winner, 'win', 'wins')} the trick${ev.points ? ` (+${ev.points})` : ''}.${pique}`;
    }
    case EV_DEAL_END:
      if (ev.bonus === BONUS_CAPOT) return `${NAMES[ev.winner]} ${verb(ev.winner, 'take', 'takes')} all twelve tricks: capot, +40!`;
      if (ev.bonus === BONUS_CARDS) return `${NAMES[ev.winner]} ${verb(ev.winner, 'win', 'wins')} the cards, +10.`;
      return 'Six tricks each: the cards are divided.';
    default: return '';
  }
}

// ---- The end of a deal and of the partie ----------------------------------------------

// Each seat's points this deal by where they came from, read off the deal's events.
function breakdown() {
  const parts = { blanche: [0, 0], point: [0, 0], sequence: [0, 0], sets: [0, 0], bonus: [0, 0], play: [0, 0], cards: [0, 0] };
  for (const ev of deal.log) {
    if (ev.kind === EV_CARTE_BLANCHE) parts.blanche[ev.actor] += ev.points;
    if (ev.kind === EV_RESOLVE && ev.winner >= 0) parts[CATEGORY_NAMES[ev.category]][ev.winner] += ev.points;
    if (ev.kind === EV_PLAY) parts.play[ev.winner < 0 ? ev.actor : ev.winner] += ev.points;
    if (ev.kind === EV_DEAL_END && ev.winner >= 0) parts.cards[ev.winner] += ev.points;
    if (ev.bonus === BONUS_REPIQUE) parts.bonus[ev.bonusSeat] += 60;
    if (ev.bonus === BONUS_PIQUE) parts.bonus[ev.bonusSeat] += 30;
  }
  return parts;
}

function finishDeal() {
  if (scored || !engine?.done) return;
  scored = true;
  totals = totals.map((t, seat) => t + engine.points[seat]);
  history.push({ deal: dealNumber, points: [...engine.points] });
  showResult();
}

function showResult() {
  const [mine, theirs] = engine.points, parts = breakdown();
  const over = partieOver();
  $('result-kicker').textContent = over ? 'Partie complete' : `Deal ${dealNumber} complete`;
  if (over) {
    const { winner, payoff, rubiconed } = rubicon(totals);
    $('result-title').textContent = winner < 0 ? 'The partie is tied.' : winner === ME ? `You win the partie, ${totals[ME]} to ${totals[BOT]}.` : `Fern wins the partie, ${totals[BOT]} to ${totals[ME]}.`;
    $('result-description').textContent = winner < 0 ? 'Equal totals: nobody scores the game.' : `${rubiconed ? `${winner === ME ? 'Fern' : 'You'} stayed under 100: rubiconed! ` : ''}Rubicon score: ${winner === ME ? 'you' : 'Fern'} +${payoff}.`;
  } else {
    $('result-title').textContent = mine === theirs ? `A tie, ${mine} all.` : mine > theirs ? `You win the deal, ${mine} to ${theirs}.` : `Fern wins the deal, ${theirs} to ${mine}.`;
    $('result-description').textContent = `Totals: you ${totals[ME]}, Fern ${totals[BOT]}. ${plural(PARTIE_DEALS - dealNumber, 'deal')} to go.`;
  }
  const lines = [['Carte blanche', 'blanche'], ['Point', 'point'], ['Sequence', 'sequence'], ['Sets', 'sets'], ['Repique / pique', 'bonus'], ['Tricks played', 'play'], ['The cards / capot', 'cards']];
  $('scores').innerHTML = `<table class="score-table"><thead><tr><th></th><th>You</th><th>Fern</th></tr></thead><tbody>${lines.filter(([, key]) => parts[key][0] || parts[key][1] || key === 'play').map(([label, key]) => `<tr><td>${label}</td><td>${parts[key][ME]}</td><td>${parts[key][BOT]}</td></tr>`).join('')}<tr class="score-total-row"><td>Deal</td><td>${mine}</td><td>${theirs}</td></tr></tbody></table>`;
  const discards = cardsOf(engine.discards[BOT]), talon = engine.talon;
  $('result-reveal').innerHTML = `Fern’s discards: ${discards.length ? chips(handOrder(discards)) : 'none'}${talon.length ? ` · left in the talon: ${chips(handOrder(talon))}` : ''}`;
  $('next-round').textContent = over ? 'New partie' : 'Deal next';
  $('result-dialog').hidden = false;
  render();
  $('next-round').focus({ preventScroll: true });
}

// ---- Loading and controls ---------------------------------------------------------

function setAutoplay(on) {
  $('autoplay').setAttribute('aria-pressed', String(on));
  $('autoplay').textContent = on ? 'Stop auto-play' : 'Auto-play my hand';
}

function updateSpeed() {
  const delay = moveDelay();
  $('speed-output').textContent = delay ? `${(delay / 1000).toFixed(2)} s` : 'instant';
}

const setSetupError = (message = '') => { $('setup-error').hidden = !message; $('setup-error').textContent = message; };

async function loadAgent() {
  setSetupError();
  $('start').disabled = true; $('loading').hidden = false;
  try {
    const manifest = await agent.load(({ percent, message }) => {
      $('load-message').textContent = message; $('load-percent').textContent = `${percent}%`; $('load-bar').style.width = `${percent}%`;
    });
    agentInfo = { run: manifest.run, iteration: manifest.iteration, valueTarget: manifest.valueTarget };
    $('model-state').textContent = `Agent ${manifest.run} · ${manifest.iteration.toLocaleString()}`;
    $('model-state').classList.add('is-ready');
    return true;
  } catch (error) {
    setSetupError(error.message);
    $('loading').hidden = true;
    return false;
  } finally {
    $('start').disabled = false;
  }
}

$('setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  difficulty = Number($('difficulty').value);
  if (await loadAgent()) newPartie();
});
$('difficulty').addEventListener('input', () => {
  snapDifficulty($('difficulty'));
  $('difficulty-output').textContent = difficultyLabel(Number($('difficulty').value));
});
$('hand').addEventListener('click', event => {
  const button = event.target.closest('[data-card]');
  if (!button || button.disabled || !humanTurn()) return;
  const card = Number(button.dataset.card);
  if (engine.phase === EXCHANGE) {
    selected = selected.includes(card) ? selected.filter(c => c !== card) : selected.length < engine.maxDiscards ? [...selected, card] : selected;
    stateId++; render(); void requestHint();
  } else if (engine.phase === PLAY) userAction(card);
});
$('action-buttons').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.matches('[data-results]')) { $('result-dialog').hidden = false; render(); $('next-round').focus(); return; }
  if (!humanTurn()) return;
  if (button.matches('[data-clear]')) { selected = []; stateId++; render(); void requestHint(); }
  else if (button.matches('[data-agent-pick]')) { selected = [...currentHint().plan.cards]; stateId++; render(); void requestHint(); }
  else if (button.matches('[data-exchange]')) userExchange();
  else if (button.matches('[data-declare]')) userAction(Number(button.dataset.declare));
});
$('autoplay').addEventListener('click', () => { setAutoplay(!autoplay()); selected = []; stateId++; render(); void advanceBots(); });
$('speed').addEventListener('input', updateSpeed);
for (const id of ['hints', 'values']) $(id).addEventListener('change', () => { render(); void requestHint(); });
$('beliefs').addEventListener('change', () => { render(); renderCardRead(); });
window.addEventListener('resize', () => { if (engine) fitHand(); });
// On phones the score sheet is a drawer over the table.
const showScores = open => { $('game').dataset.drawer = open ? 'scores' : ''; $('scores-toggle').setAttribute('aria-expanded', String(open)); };
$('scores-toggle').addEventListener('click', () => showScores($('game').dataset.drawer !== 'scores'));
$('scores-close').addEventListener('click', () => showScores(false));
// On phones the table controls fold into a menu under the toolbar.
const showMenu = open => { $('table-menu').classList.toggle('is-open', open); $('menu-toggle').setAttribute('aria-expanded', String(open)); };
$('menu-toggle').addEventListener('click', () => showMenu($('menu-toggle').getAttribute('aria-expanded') !== 'true'));
$('table-menu').addEventListener('click', event => { if (event.target.closest('button')) showMenu(false); });
document.addEventListener('click', event => { if (!event.target.closest('#table-menu, #menu-toggle')) showMenu(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { showScores(false); showMenu(false); } });
document.querySelectorAll('[data-rules]').forEach(button => button.addEventListener('click', () => $('rules-dialog').showModal()));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('review').addEventListener('click', () => { $('result-dialog').hidden = true; render(); });
$('next-round').addEventListener('click', () => { if (partieOver()) newPartie(); else startDeal(); });
$('new-table').addEventListener('click', () => $('leave-dialog').showModal());
$('leave').addEventListener('click', () => {
  $('leave-dialog').close();
  generation++; deal = null; engine = null; busy = false; failure = false; hint = null; selected = [];
  $('result-dialog').hidden = true; $('game-error').hidden = true; $('game').hidden = true; $('setup').hidden = false;
});
$('retry').addEventListener('click', async () => {
  $('retry').disabled = true;
  try { await agent.load(); failure = false; $('game-error').hidden = true; void advanceBots(); }
  catch (error) { $('game-error-message').textContent = error.message; }
  finally { $('retry').disabled = false; }
});
updateSpeed();
