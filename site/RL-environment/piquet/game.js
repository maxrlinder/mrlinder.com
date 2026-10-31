import {
  PiquetDeal, PiquetEngine, shuffledDeck, rubicon, name, isRed, suitOf, rankOf, popcount, cardsOf, has, best, compare, score, viewCodes,
  EXCHANGE, DECLARE, PLAY, STOP, QUIET, SPEAK, POINT, SEQUENCE, SETS, RANKS, SUITS, SUIT_WORDS, NO_CARD,
  EV_DEAL, EV_CARTE_BLANCHE, EV_EXCHANGE, EV_ANNOUNCE, EV_RESOLVE, EV_PLAY, EV_DEAL_END,
  SAID_NOTHING, DECLARED, CONCEDED, BONUS_REPIQUE, BONUS_PIQUE, BONUS_CARDS, BONUS_CAPOT,
  V_UNKNOWN, V_MINE, V_MINE_LEGAL, V_SELECTED, V_DISCARDED, V_SEEN_TALON, V_OPP, V_OPP_MAYBE, V_PLAYED_ME, V_PLAYED_OPP, V_TRICK_ME, V_TRICK_OPP,
} from './engine.js?v=2';
import { PiquetAgent } from './model-client.js?v=3';
import { PeerRoom, generateRoomCode, normalizeRoomCode, validRoomCode } from '../multiplayer.js';
import { difficultyLabel, snapDifficulty, temperatureFor } from '../difficulty.js';

const $ = id => document.getElementById(id);
const agent = new PiquetAgent();
// Seats: `me` is the local player, `them` the other; the deal decides who is
// Elder. Solo: you are seat 0 and the agent, Fern, seat 1. `names` is how this
// screen calls each seat ("You" for your own).
let me = 0, them = 1, playerNames = ['You', 'Fern'], names = ['You', 'Fern'], aiSeats = new Set([1]);
// A partie: six deals, Rubicon scoring.
const PARTIE_DEALS = 6;
let deal = null, engine = null, busy = false, failure = false, generation = 0, stateId = 0, decisionId = 0;
let selected = [], difficulty = 50, dealNumber = 0, firstDealer = 0;
let totals = [0, 0], history = [], scored = false, agentInfo = null, resultShown = -1;
// Local remarks on log entries, by entry number: whether the agent agreed with your move.
let notes = new Map();
// The agent's readout of your decision, and its read of the hidden cards.
let hint = null, hintRequest = 0, reading = null, readRequest = 0;
// Multiplayer: the host deals, checks every move and runs the agent; the guest mirrors its view.
let role = null, room = null, lobbyPhase = 'idle', hostPeer = null, pending = false;
let guests = new Map(), peerSeat = new Map(), seatPeer = new Map(), sent = new Map();
let revision = 0, applied = -1, syncQueued = false;
// A guest mirrors the host's deal number, and asks the host for its readouts:
// the table state the open request is for, and the card read last asked for.
let hostDeal = -1, askedState = -1, guestReadKey = '', readAsked = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const autoplay = () => $('autoplay').getAttribute('aria-pressed') === 'true';
// Slider 0..100 → a pause of 1.1 s down to nothing between the agent's moves.
const moveDelay = () => Math.round(1100 * Math.pow(1 - Number($('speed').value) / 100, 1.5));
const agentSeat = seat => aiSeats.has(seat) || (seat === me && autoplay());
const humanTurn = () => engine && !engine.done && engine.current === me && !autoplay() && !busy && !failure && !pending;
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
// Verbs agree with "You" or the other player's name.
const verb = (seat, mine, theirs) => seat === me ? mine : theirs;
// A seat's name inside a sentence.
const named = seat => seat === me ? 'you' : names[seat];
// What this screen may see of the cards: a guest gets its codes from the host.
const seatCodes = () => engine.codes ?? viewCodes(engine, me);
const handSize = seat => engine.counts ? engine.counts[seat] : popcount(engine.hands[seat]);

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
  firstDealer = Math.random() < 0.5 ? 0 : 1;
  startDeal();
}

function showGame() {
  $('setup').hidden = true; $('game').hidden = false; $('loading').hidden = true;
  $('autoplay').hidden = Boolean(role);
  $('speed-control').hidden = role === 'guest';
  $('live-badge').hidden = !role;
  $('live-badge').textContent = role === 'host' ? `Hosting · ${room.code}` : `Live table · ${room?.code}`;
}

function startDeal() {
  generation++; dealNumber++; scored = false; selected = []; notes = new Map(); failure = false; busy = false;
  hint = null; reading = null;
  // The cut for deal decides the first dealer; then the deal alternates. Each
  // deal is a fresh context whose tokens carry the score, as in training.
  deal = new PiquetDeal({ deck: shuffledDeck(), dealer: firstDealer ^ ((dealNumber - 1) % 2), partie: { totals, deal: dealNumber - 1 } });
  engine = deal.engine;
  stateId++; decisionId++;
  setAutoplay(false);
  $('game-error').hidden = true; $('result-dialog').hidden = true;
  showGame();
  render();
  window.scrollTo({ top: 0 });
  void advanceBots();
}

const partieOver = () => dealNumber >= PARTIE_DEALS;

function apply(action) {
  deal.apply(action);
  stateId++; decisionId++;
  render();
  if (engine.done) setTimeout(finishDeal, 500);
}

async function advanceBots() {
  if (role === 'guest' || busy || failure || !engine || engine.done) return;
  const version = generation;
  busy = true;
  try {
    while (version === generation && !engine.done && agentSeat(engine.current)) {
      render();
      const acting = engine.current, head = engine.head, legal = engine.legalActions();
      // Auto-play plays your hand with the agent's best move; the difficulty is for the opponent.
      const temperature = acting === me ? 0 : temperatureFor(difficulty);
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
  // The remark goes on the first event the move logged.
  if (note) notes.set(entry, note);
  if (role === 'guest') {
    pending = true; selected = []; stateId++; render();
    room.send({ type: 'move', id: decisionId, moves: actions }, hostPeer).catch(() => {
      pending = false; notes.delete(entry); render();
      $('status').textContent = 'The move did not reach the host. Try again.';
    });
    return;
  }
  for (const action of actions) {
    if (!humanTurn() || !engine.legalActions().includes(action)) break;
    deal.apply(action); decisionId++;
  }
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
  : `the agent’s estimate of your points minus ${names[them]}’s at the end of this deal`);
// The decision the readouts are about. While a seat chooses discards, it is the
// one after the cards `chosen` so far (applied on a copy of the table).
function adviceState(chosen) {
  if (engine.phase !== EXCHANGE) return { sim: deal, full: false };
  const full = chosen.length >= engine.maxDiscards;
  const sim = deal.clone();
  for (const card of full ? chosen.slice(0, -1) : chosen) sim.apply(card);
  return { sim, full };
}

// The cards the agent would exchange for `seat` from here: its top choice, one card at a time, until it stops.
async function exchangePlan(sim, first, seat) {
  const cards = [];
  let state = sim, action = first;
  while (action !== STOP && cards.length < 8) {
    cards.push(action);
    state = state.clone();
    state.apply(action);
    if (state.engine.phase !== EXCHANGE || state.engine.current !== seat) break;
    action = await agent.choose(state.streams[seat], 'exchange', state.engine.legalActions(), 0);
  }
  return cards;
}

// The readouts for `seat`'s decision (the host also runs them for its guest, from the guest's own stream).
async function assess(seat = me, chosen = selected) {
  const asked = stateId, { sim, full } = adviceState(chosen);
  const actions = sim.engine.legalActions(), head = sim.engine.head;
  const policy = await agent.policy(sim.streams[seat], head, actions);
  if (asked !== stateId) return null;
  let plan = null;
  if (head === 'exchange') {
    const extra = full ? [] : await exchangePlan(sim, actions[policy.argmax], seat);
    if (asked !== stateId) return null;
    plan = { cards: full ? [...chosen] : [...chosen, ...extra] };
  }
  return { id: asked, head, actions, full, plan, probabilities: policy.probabilities, argmax: policy.argmax, now: ownValue(policy.value) };
}

async function requestHint() {
  if (!wantsAdvice() || !humanTurn()) { hintRequest++; askedState = -1; if (hint) { hint = null; render(); } return; }
  if (hint?.id === stateId) return;
  if (role === 'guest') {
    if (askedState === stateId) return;
    askedState = stateId;
    room.send({ type: 'advise', request: ++hintRequest, id: decisionId, selected }, hostPeer).catch(() => { askedState = -1; });
    return;
  }
  const request = ++hintRequest;
  try {
    const advice = await assess();
    if (request !== hintRequest || !advice) return;
    hint = advice;
    render();
  } catch (error) {
    console.error('The agent’s readout failed.', error);
  }
}

// The reading that matches the table now: this deal, as far as your stream has come.
const readKey = () => role === 'guest' ? guestReadKey : `${generation}:${deal.streams[me].length}`;

// The agent's belief head for your seat: where each card you cannot place is.
async function requestReading() {
  if (!$('beliefs').checked || !deal) return;
  const key = readKey();
  if (reading?.key === key) return;
  if (role === 'guest') {
    if (readAsked === key) return;
    readAsked = key;
    room.send({ type: 'read', request: ++readRequest }, hostPeer).catch(() => { readAsked = ''; });
    return;
  }
  const request = ++readRequest;
  try {
    const { belief } = await agent.policy(deal.streams[me], 'declare', [QUIET, SPEAK]);
    if (request !== readRequest) return;
    reading = { key, belief };
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

// A badge naming the move and its odds, on the thing the move uses; the agent's
// own pick is the highlighted one.
function marks(index, word) {
  const advice = currentHint();
  if (!advice || index < 0) return '';
  const pick = advice.argmax === index;
  // Moves the agent all but rules out stay unmarked, to keep the table readable.
  if (!pick && advice.probabilities[index] < 0.005) return '';
  return `<span class="prob-badge ${pick ? 'is-pick' : ''}" ${pick ? 'title="The agent’s next move"' : ''}><span class="badge-verb">${word}</span><b>${percent(advice.probabilities[index])}</b></span>`;
}

// ---- Rendering --------------------------------------------------------------------

function render() {
  if (!engine) return;
  const interactive = humanTurn();
  $('plaque').innerHTML = `<strong>Deal ${dealNumber} of ${PARTIE_DEALS}</strong>You are ${roleOf(me)}`;
  $('agent-label').textContent = agentInfo ? `Self-play agent · checkpoint ${agentInfo.run} / ${agentInfo.iteration.toLocaleString()}${role === 'guest' ? ', run by the host' : ''}.` : '';
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
  sync();
}

function renderStatus(interactive) {
  const latest = deal.log.length ? describe(deal.log.at(-1)) : '';
  let status;
  if (engine.done) status = `${latest} The deal is over.`;
  else if (failure) status = role === 'guest' ? 'The host’s agent stopped. Waiting for the host to retry.' : 'The agent stopped. Retry to continue this deal.';
  else if (pending) status = 'Sending your move to the host…';
  else if (engine.current !== me || autoplay()) {
    const who = names[engine.current];
    const doing = engine.current === me ? 'The agent is playing for you'
      : engine.phase === EXCHANGE ? `${who} is choosing discards` : aiSeats.has(engine.current) ? `${who} is thinking` : `Waiting for ${who}`;
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
  if (ev.left) return 'Left the table';
  if (ev.kind === EV_CARTE_BLANCHE) return 'Carte blanche';
  if (ev.kind === EV_EXCHANGE) return `Exchanged ${ev.count}`;
  if (ev.kind === EV_ANNOUNCE) return ev.status === DECLARED ? upperFirst(describeKey(ev.category, ev.key)) : `Nothing for ${CATEGORY_NAMES[ev.category]}`;
  if (ev.kind === EV_RESOLVE) return ev.status === CONCEDED ? '“Good”' : ev.status === DECLARED ? (ev.winner < 0 ? '“Equal”' : upperFirst(describeKey(ev.category, ev.key))) : `Nothing for ${CATEGORY_NAMES[ev.category]}`;
  if (ev.kind === EV_PLAY) return `${ev.winner < 0 ? 'Led' : 'Played'} ${name(ev.card)}`;
  return '';
}

function seatTag(seat, current) {
  if (aiSeats.has(seat)) return current && busy ? 'thinking…' : 'AI';
  if (current) return 'playing…';
  return seat === 0 ? 'Host' : 'Friend';
}

function renderOpponent() {
  const seat = them, current = !engine.done && engine.current === seat;
  const codes = seatCodes();
  const count = handSize(seat);
  const known = codes.flatMap((code, card) => (code === V_OPP ? [card] : []));
  const maybe = codes.flatMap((code, card) => (code === V_OPP_MAYBE ? [card] : []));
  const last = [...deal.log].reverse().find(ev => ev.actor === seat && ev.kind !== EV_DEAL);
  $('opponent').className = `seat piquet-seat ${current ? 'is-current' : ''}`;
  $('opponent').innerHTML = `<div class="seat-name"><span>${names[seat]} · ${roleOf(seat)}</span><span>${seatTag(seat, current)}</span></div>
    <div class="opponent-hand" aria-hidden="true">${'<span class="opponent-card"></span>'.repeat(count)}</div>
    <div class="seat-stats"><span>${plural(count, 'card')}</span><span>${plural(engine.tricks[seat], 'trick')}</span><span>${engine.points[seat]} pts</span><span>Σ ${totals[seat]}</span></div>
    <div class="seat-notes">${known.length ? `<span class="seat-known">Holds ${chips(handOrder(known))}</span>` : ''}${maybe.length ? `<span class="seat-known">Hand or discards ${chips(handOrder(maybe))}</span>` : ''}${last ? `<span class="seat-action">${escapeHtml(shortAction(last))}</span>` : ''}</div>`;
}

function renderTalon() {
  const codes = seatCodes(), size = engine.talon.length;
  const seen = codes.flatMap((code, card) => (code === V_SEEN_TALON ? [card] : []));
  const mine = codes.flatMap((code, card) => (code === V_DISCARDED ? [card] : []));
  const theirs = engine.exchanged[them] ? engine.exchangedCount[them] : null;
  const layers = Math.min(size, 4);
  $('talon-area').innerHTML = `<div class="pile-stack talon-stack">${size ? Array.from({ length: layers }, (_, i) => `<span class="pile-card card-back" style="--layer:${layers - 1 - i}"></span>`).join('') : '<span class="pile-empty">Empty</span>'}</div>
    <span class="pile-label">Talon <b>${size}</b></span>
    ${seen.length ? `<p class="talon-note"><span>Left for Younger</span>${chips(handOrder(seen))}</p>` : ''}
    ${mine.length ? `<p class="talon-note"><span>Your discards</span>${chips(handOrder(mine))}</p>` : ''}
    ${theirs !== null ? `<p class="talon-note"><span>${names[them]}’s discards</span>${theirs ? `${plural(theirs, 'card')}, face down` : 'none'}</p>` : ''}`;
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
      const who = names[seat];
      if (engine.exchanged[seat]) return `<li><b>${who}</b> exchanged ${plural(engine.exchangedCount[seat], 'card')}.</li>`;
      if (engine.current === seat) return `<li class="is-current"><b>${who}</b> ${seat === elder ? `must exchange 1 to ${engine.maxDiscards} cards` : `may exchange up to ${plural(engine.maxDiscards, 'card')}`}…</li>`;
      return `<li><b>${who}</b> ${verb(seat, 'exchange', 'exchanges')} next.</li>`;
    };
    const blanche = deal.log.filter(ev => ev.kind === EV_CARTE_BLANCHE).map(ev => `<li class="is-score"><b>${names[ev.actor]}</b> ${verb(ev.actor, 'show', 'shows')} carte blanche: +10.</li>`).join('');
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
    const result = !answer ? (active ? '…' : '') : answer.winner < 0 ? 'No score' : `${names[answer.winner]} +${answer.points}${answer.bonus === BONUS_REPIQUE ? ' · repique +60' : ''}`;
    const winner = answer && answer.winner >= 0 ? (answer.winner === me ? 'is-mine' : 'is-theirs') : '';
    return `<tr class="${active ? 'is-active' : ''} ${winner}"><th>${upperFirst(CATEGORY_NAMES[category])}</th><td>${escapeHtml(elderSays)}</td><td>${escapeHtml(youngerSays)}</td><td class="board-result">${escapeHtml(result)}</td></tr>`;
  }).join('');
  $('board').innerHTML = `<h3>Declarations</h3><table class="board-table"><thead><tr><th></th><th>${names[engine.elder]} <small>Elder</small></th><th>${names[1 - engine.elder]} <small>Younger</small></th><th>Score</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderTrick() {
  const trickCard = (seat, card, label, winner) => `<figure class="played-card ${winner ? 'is-winner' : ''}"><img src="${cardAsset(card)}" alt="${name(card)}" width="90" height="126" draggable="false" /><figcaption>${label}</figcaption></figure>`;
  let cards = '', caption = '';
  if (engine.trick.length) {
    const [[seat, card]] = engine.trick;
    cards = trickCard(seat, card, `${names[seat]} led`, false) + `<figure class="played-card is-empty"><span></span><figcaption>${names[1 - seat]}</figcaption></figure>`;
    caption = `Trick ${engine.trickIndex + 1} of 12`;
  } else if (engine.lastTrick) {
    const { leader, led, follower, card, winner } = engine.lastTrick;
    cards = trickCard(leader, led, `${names[leader]} led`, winner === leader) + trickCard(follower, card, names[follower], winner === follower);
    caption = `Trick ${engine.trickIndex}: ${named(winner)} ${verb(winner, 'win', 'wins')} it`;
  } else if (engine.phase === PLAY) caption = `${roleOf(me) === 'Elder' ? 'You lead' : `${names[them]} leads`} to the first trick`;
  else caption = 'Twelve tricks follow the declarations';
  $('trick').innerHTML = `<div class="played-cards">${cards}</div><p class="trick-caption">${escapeHtml(caption)}</p><p class="trick-count">Tricks · You ${engine.tricks[me]} · ${names[them]} ${engine.tricks[them]}</p>`;
}

function renderHand(interactive) {
  const worth = interactive && currentWorth();
  $('human-label').innerHTML = `<span>You · ${roleOf(me)}</span><span>${plural(popcount(engine.hands[me]), 'card')}</span><span>${plural(engine.tricks[me], 'trick')}</span><span>${engine.points[me]} pts</span><span>Σ ${totals[me]}</span>${worth ? `<span class="advantage-now" title="${upperFirst(worthMeaning())}">Advantage ${points(worth.now, worthDigits())}</span>` : ''}`;
  $('human-label').classList.toggle('is-current', !engine.done && engine.current === me);
  const exchanging = interactive && engine.phase === EXCHANGE, playing = interactive && engine.phase === PLAY;
  const legal = new Set(interactive ? engine.legalActions() : []);
  const advice = currentAdvice(), odds = currentHint();
  // The cards the agent's move would use glow: its whole exchange, or the card it would play.
  const advised = new Set(odds ? (odds.head === 'exchange' ? odds.plan.cards : odds.head === 'play' ? [odds.actions[odds.argmax]] : []) : []);
  const focused = document.activeElement?.dataset?.card;
  $('hand').classList.toggle('is-waiting', !interactive && !engine.done);
  $('hand').innerHTML = handOrder(cardsOf(engine.hands[me])).map(card => {
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
  const category = engine.category, mine = best(category, engine.hands[me]), word = CATEGORY_NAMES[category];
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
  } else if (failure) help = role === 'guest' ? 'The host’s agent stopped. Waiting for the host to retry.' : 'The agent stopped. Retry to continue.';
  else if (pending) help = 'Sending your move to the host…';
  else if (!interactive) help = engine.current === me && autoplay() ? 'The agent is playing your hand.' : `${names[engine.current]} is playing. Your cards stay private.`;
  else if (engine.phase === EXCHANGE) {
    const elder = engine.elder === me, count = selected.length, max = engine.maxDiscards, min = engine.minDiscards;
    help = count ? `${plural(count, 'card')} chosen. You draw as many from the talon.` : elder ? `Choose 1 to ${max} cards to exchange. Elder usually takes all ${max}.` : `Choose up to ${plural(max, 'card')} to exchange, or keep your hand.`;
    if (count >= max && max) help = `${plural(count, 'card')} chosen, the most you may exchange.`;
    const stopIndex = advice ? (advice.full ? advice.actions.indexOf(selected.at(-1)) : advice.actions.indexOf(STOP)) : -1;
    const pick = currentHint()?.plan?.cards;
    buttons = `<button class="game-button" type="button" data-clear ${count ? '' : 'disabled'}>Clear</button>`
      + (pick && !sameSet(pick, selected) ? '<button class="game-button" type="button" data-agent-pick>Choose the agent’s cards</button>' : '')
      + `<button class="game-button exchange-button ${count >= min ? 'is-default' : ''}" type="button" data-exchange ${count >= min ? '' : 'disabled'}>${count ? `Exchange ${plural(count, 'card')}` : min ? 'Exchange' : 'Keep my hand'}${count >= min ? marks(stopIndex, count ? 'Exchange' : 'Keep') : ''}</button>`;
  } else if (engine.phase === DECLARE) {
    const category = engine.category, mine = best(category, engine.hands[me]);
    const announced = engine.announced, word = CATEGORY_NAMES[category];
    help = engine.current === engine.elder
      ? `Your ${word}: ${describeKey(category, mine)}, worth ${score(category, engine.hands[me])}. Declare it, or sink it to keep your cards hidden.`
      : announced !== null
        ? `${names[them]} declares a ${describeKey(category, announced)}. ${compare(category, mine, announced) > 0 ? 'Yours is better.' : 'Yours is equal: nobody scores it.'}`
        : `${names[them]} said nothing for the ${word}. Yours is a ${describeKey(category, mine)}, worth ${score(category, engine.hands[me])}.`;
    buttons = [SPEAK, QUIET].map(action => `<button class="game-button declare-button ${action === SPEAK ? 'is-default' : ''}" type="button" data-declare="${action}">${escapeHtml(declareLabel(action))}${marks(action, action === SPEAK ? 'Declare' : 'Quiet')}</button>`).join('');
  } else if (engine.phase === PLAY) {
    help = engine.trick.length ? `Follow suit if you can: ${SUITS[suitOf(engine.trick[0][1])]} was led.` : 'Your lead: play any card.';
  }
  $('selection-help').textContent = help;
  $('action-buttons').innerHTML = buttons;
}

function renderScores() {
  const head = `<thead><tr><th>Deal</th><th>You</th><th>${names[them]}</th></tr></thead>`;
  const cell = (v, other) => `<td class="${v > other ? 'is-hit' : ''}">${v}</td>`;
  const rows = history.map(h => `<tr><td>${h.deal}</td>${cell(h.points[me], h.points[them])}${cell(h.points[them], h.points[me])}</tr>`).join('');
  const live = engine && !scored ? `<tr class="is-active"><td>${dealNumber}</td><td>${engine.points[me]}</td><td>${engine.points[them]}</td></tr>` : '';
  $('score-table').innerHTML = `${head}<tbody>${rows}${live}<tr class="score-total-row"><td>Total</td><td>${totals[me]}</td><td>${totals[them]}</td></tr></tbody>`;
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
  const codes = seatCodes(), fresh = reading && reading.key === readKey(), other = names[them];
  // Where each card you can place is, and how it is drawn.
  const PLACE = {
    [V_MINE]: ['You', 'mine'], [V_MINE_LEGAL]: ['You', 'mine'], [V_SELECTED]: ['You', 'mine'], [V_DISCARDED]: ['Your discard', 'mine'],
    [V_SEEN_TALON]: ['Talon', 'talon'], [V_OPP]: [other, 'theirs'],
    [V_PLAYED_ME]: ['Played', 'played'], [V_PLAYED_OPP]: ['Played', 'played'], [V_TRICK_ME]: ['Played', 'played'], [V_TRICK_OPP]: ['Played', 'played'],
  };
  const cell = card => {
    const code = codes[card], hidden = code === V_UNKNOWN || code === V_OPP_MAYBE;
    if (!hidden) return `<span class="read-card is-${PLACE[code][1]}" title="${name(card)}: ${PLACE[code][0]}"><b>${RANKS[rankOf(card)]}</b></span>`;
    const [hand, discard, talon] = fresh ? reading.belief[card] : [1 / 3, 1 / 3, 1 / 3];
    return `<span class="read-card is-hidden" title="${name(card)}: ${other}’s hand ${percent(hand)} · ${other}’s discards ${percent(discard)} · talon ${percent(talon)}" style="--hand:${hand.toFixed(3)};--discard:${discard.toFixed(3)};--talon:${talon.toFixed(3)}"><b>${RANKS[rankOf(card)]}</b><i aria-hidden="true"></i></span>`;
  };
  panel.innerHTML = `<div class="read-grid">${SUIT_ORDER.map(suit => `<span class="read-suit ${suit === 1 || suit === 2 ? 'is-red' : ''}">${SUITS[suit]}</span>${[0, 1, 2, 3, 4, 5, 6, 7].map(rank => cell(suit * 8 + rank)).join('')}`).join('')}</div>
    <p class="read-legend"><span class="key-hand"></span>${other}’s hand <span class="key-discard"></span>${other}’s discards <span class="key-talon"></span>Talon${fresh ? '' : ' · reading…'}</p>
    <p class="score-legend">For every card you cannot see, where the agent in your seat thinks it is. Hover a card for the numbers.</p>`;
}

function describe(ev) {
  const who = names[ev.actor] ?? '', word = CATEGORY_NAMES[ev.category];
  if (ev.left) return `${who} left the table; the agent plays their hand now.`;
  switch (ev.kind) {
    case EV_DEAL: return `Deal ${dealNumber}: ${engine.dealer === me ? `you deal, ${names[them]} is Elder` : `${names[them]} deals, you are Elder`}.`;
    case EV_CARTE_BLANCHE: return `${who} ${verb(ev.actor, 'have', 'has')} carte blanche, +10: ${chipsText(cardsOf(ev.cards))}.${ev.bonus === BONUS_REPIQUE ? ' Repique, +60!' : ''}`;
    case EV_EXCHANGE: {
      const swap = ev.actor === me && ev.count ? `: out ${chipsText(cardsOf(ev.discarded))}, in ${chipsText(cardsOf(ev.cards))}` : '';
      return ev.count ? `${who} exchanged ${plural(ev.count, 'card')}${swap}.` : `${who} kept ${verb(ev.actor, 'your hand', 'every card')}.`;
    }
    case EV_ANNOUNCE: return ev.status === DECLARED ? `${who} ${verb(ev.actor, 'declare', 'declares')} a ${describeKey(ev.category, ev.key)}.` : `${who} ${verb(ev.actor, 'say', 'says')} nothing for the ${word}.`;
    case EV_RESOLVE: {
      const repique = ev.bonus === BONUS_REPIQUE ? ` Repique: ${named(ev.bonusSeat)} ${verb(ev.bonusSeat, 'score', 'scores')} 60 more!` : '';
      const shows = ev.cards ? `, showing ${chipsText(cardsOf(ev.cards))}` : '';
      const winner = names[ev.winner];
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
      if (ev.bonus === BONUS_CAPOT) return `${names[ev.winner]} ${verb(ev.winner, 'take', 'takes')} all twelve tricks: capot, +40!`;
      if (ev.bonus === BONUS_CARDS) return `${names[ev.winner]} ${verb(ev.winner, 'win', 'wins')} the cards, +10.`;
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
  if (role === 'guest' || scored || !engine?.done) return;
  scored = true;
  totals = totals.map((t, seat) => t + engine.points[seat]);
  history.push({ deal: dealNumber, points: [...engine.points] });
  showResult();
}

function showResult() {
  resultShown = role === 'guest' ? hostDeal : generation;
  const mine = engine.points[me], theirs = engine.points[them], other = names[them], parts = breakdown();
  const over = partieOver();
  $('result-kicker').textContent = over ? 'Partie complete' : `Deal ${dealNumber} complete`;
  if (over) {
    const { winner, payoff, rubiconed } = rubicon(totals);
    $('result-title').textContent = winner < 0 ? 'The partie is tied.' : winner === me ? `You win the partie, ${totals[me]} to ${totals[them]}.` : `${other} wins the partie, ${totals[them]} to ${totals[me]}.`;
    $('result-description').textContent = winner < 0 ? 'Equal totals: nobody scores the game.' : `${rubiconed ? `${winner === me ? other : 'You'} stayed under 100: rubiconed! ` : ''}Rubicon score: ${winner === me ? 'you' : other} +${payoff}.`;
  } else {
    $('result-title').textContent = mine === theirs ? `A tie, ${mine} all.` : mine > theirs ? `You win the deal, ${mine} to ${theirs}.` : `${other} wins the deal, ${theirs} to ${mine}.`;
    $('result-description').textContent = `Totals: you ${totals[me]}, ${other} ${totals[them]}. ${plural(PARTIE_DEALS - dealNumber, 'deal')} to go.`;
  }
  const lines = [['Carte blanche', 'blanche'], ['Point', 'point'], ['Sequence', 'sequence'], ['Sets', 'sets'], ['Repique / pique', 'bonus'], ['Tricks played', 'play'], ['The cards / capot', 'cards']];
  $('scores').innerHTML = `<table class="score-table"><thead><tr><th></th><th>You</th><th>${other}</th></tr></thead><tbody>${lines.filter(([, key]) => parts[key][0] || parts[key][1] || key === 'play').map(([label, key]) => `<tr><td>${label}</td><td>${parts[key][me]}</td><td>${parts[key][them]}</td></tr>`).join('')}<tr class="score-total-row"><td>Deal</td><td>${mine}</td><td>${theirs}</td></tr></tbody></table>`;
  const discards = cardsOf(engine.discards[them]), talon = engine.talon;
  $('result-reveal').innerHTML = `${other}’s discards: ${discards.length ? chips(handOrder(discards)) : 'none'}${talon.length ? ` · left in the talon: ${chips(handOrder(talon))}` : ''}`;
  $('next-round').disabled = role === 'guest';
  $('next-round').textContent = role === 'guest' ? 'The host deals next' : over ? 'New partie' : 'Deal next';
  $('result-dialog').hidden = false;
  render();
  $(role === 'guest' ? 'review' : 'next-round').focus({ preventScroll: true });
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

async function startSolo() {
  difficulty = Number($('difficulty').value);
  if (!(await loadAgent())) return;
  role = null; me = 0; them = 1;
  playerNames = ['You', 'Fern']; names = ['You', 'Fern']; aiSeats = new Set([1]);
  newPartie();
}

// ---- Multiplayer -------------------------------------------------------
// The host owns the deal, both token streams and the agent. The guest gets the
// table as its seat sees it: its own hand, the public cards and the codes of
// what it knows, and its legal moves on its turn. It sends moves, which the
// host checks against the legal list before playing them, and asks the host
// for its readouts, which the agent computes from the guest's own stream.

// Names travel between browsers and land in the page: no markup characters.
const cleanName = (value, fallback = 'Player') => String(value || '').replace(/[<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18) || fallback;
const playMode = () => $('setup-form').elements.playMode.value;
const lobbyRole = () => $('setup-form').elements.multiplayerRole.value;

function configureSetup() {
  const multi = playMode() === 'multiplayer', joining = multi && lobbyRole() === 'guest';
  $('multiplayer-setup').hidden = !multi;
  $('join-code-row').hidden = !joining;
  $('join-code').required = joining;
  $('host-settings').hidden = joining;
  $('difficulty-label').textContent = multi ? 'Agent difficulty, if your friend leaves' : 'Agent difficulty';
  if (lobbyPhase === 'idle') $('start').textContent = !multi ? 'Load agent & deal' : joining ? 'Join multiplayer table' : 'Create multiplayer table';
  setSetupError();
}

function renderLobby({ hostName, names: friends = [], status = '' }) {
  const rows = [[hostName, 'Host'], ...friends.map(n => [n, 'Friend'])];
  $('lobby-roster').innerHTML = rows.map(([n, kind]) => `<li><span>${escapeHtml(n)}</span><span>${kind}</span></li>`).join('');
  $('lobby-status').textContent = status;
}

function updateHostLobby() {
  if (role !== 'host' || lobbyPhase !== 'lobby') return;
  const hostName = cleanName($('player-name').value, 'Host'), friends = [...guests.values()];
  $('start-multiplayer').hidden = false;
  $('start-multiplayer').disabled = !guests.size;
  renderLobby({ hostName, names: friends, status: guests.size ? `${friends[0]} is at the table. Deal when you are ready.` : 'Share the code with a friend. You can deal once they appear here.' });
  room.send({ type: 'lobby', code: room.code, hostName, names: friends }).catch(() => {});
}

// Engine fields every seat may see. Everything else (the hands, the talon's
// order, the discards, each side's knowledge) is filled in per seat below.
const PUBLIC_FIELDS = ['dealer', 'rubicon', 'totals', 'dealIndex', 'done', 'elder', 'exchanged', 'exchangedCount', 'shownHand', 'points', 'declared',
  'result', 'category', 'announced', 'tricks', 'trickIndex', 'trick', 'played', 'voids', 'phase', 'current', 'minDiscards', 'maxDiscards', 'lastTrick'];

// The table as `seat` may see it: the other hand, the talon and the other side's
// exchange stay hidden; the discards and the talon show once the deal is over.
function statePacket(seat) {
  const open = engine.done;
  const view = Object.fromEntries(PUBLIC_FIELDS.map(key => [key, engine[key]]));
  Object.assign(view, {
    hands: engine.hands.map((hand, s) => (s === seat ? hand : 0)),
    counts: engine.hands.map(popcount),
    discards: open ? engine.discards : engine.discards.map((cards, s) => (s === seat ? cards : 0)),
    talon: open ? engine.talon : engine.talon.map(() => NO_CARD),
    selected: 0,
    codes: viewCodes(engine, seat),
    actions: !open && engine.current === seat ? engine.legalActions() : [],
  });
  return {
    seat, code: room.code, names: playerNames, ai: [...aiSeats], dealNumber, totals, history, scored, busy, failure,
    deal: generation, decision: decisionId, readKey: `${generation}:${deal.streams[seat].length}`, engine: view,
    // The other side's exchange: how many cards, not which.
    log: deal.log.map(ev => (ev.kind === EV_EXCHANGE && ev.actor !== seat ? { ...ev, cards: 0, discarded: 0, seen: 0 } : ev)),
    agent: agentInfo,
  };
}

// Send the guest its view whenever it changed. Called after every render.
function sync() {
  if (role !== 'host' || !room || !engine || syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    if (role !== 'host' || !engine) return;
    for (const [seat, peer] of seatPeer) {
      const packet = JSON.stringify(statePacket(seat));
      if (sent.get(peer) === packet) continue;
      sent.set(peer, packet);
      room.send({ type: 'state', revision: ++revision, state: JSON.parse(packet) }, peer).catch(() => {});
    }
  });
}

function remoteMove(message, peer) {
  const seat = peerSeat.get(peer);
  if (seat === undefined) return;
  // An exchange arrives as its cards and then "stop"; each move is checked in turn.
  const moves = Array.isArray(message.moves) ? message.moves.slice(0, 9) : [];
  let played = 0;
  for (const move of moves) {
    const open = engine && !engine.done && !busy && !failure && engine.current === seat && (played || message.id === decisionId);
    if (!open || !engine.legalActions().includes(move)) break;
    deal.apply(move); decisionId++; played++;
  }
  if (!played) { sent.delete(peer); sync(); return; }  // Resend the table so the guest can try again.
  stateId++;
  render();
  if (engine.done) setTimeout(finishDeal, 500);
  void advanceBots();
}

// The guest's readouts for its decision, with the cards it has chosen to exchange so far.
async function adviseGuest(message, peer) {
  const seat = peerSeat.get(peer);
  if (seat === undefined || !engine || engine.done || busy || failure || engine.current !== seat || message.id !== decisionId) return;
  const chosen = Array.isArray(message.selected) ? message.selected : [];
  const valid = engine.phase === EXCHANGE
    ? chosen.length <= engine.maxDiscards && new Set(chosen).size === chosen.length && chosen.every(card => Number.isInteger(card) && has(engine.hands[seat], card))
    : !chosen.length;
  if (!valid) return;
  try {
    const advice = await assess(seat, chosen);
    if (advice) room?.send({ type: 'advice', request: message.request, advice }, peer).catch(() => {});
  } catch (error) { console.error('The guest’s readout failed.', error); }
}

// The agent's card read from the guest's seat.
async function readForGuest(message, peer) {
  const seat = peerSeat.get(peer);
  if (seat === undefined || !deal) return;
  const key = `${generation}:${deal.streams[seat].length}`;
  try {
    const { belief } = await agent.policy(deal.streams[seat], 'declare', [QUIET, SPEAK]);
    room?.send({ type: 'reading', request: message.request, key, belief }, peer).catch(() => {});
  } catch (error) { console.error('The guest’s card read failed.', error); }
}

function applyState({ revision: number, state }) {
  if (number <= applied) return;
  applied = number;
  const newDeal = state.deal !== hostDeal, moved = newDeal || state.decision !== decisionId;
  me = state.seat; them = 1 - me;
  playerNames = state.names.map(n => cleanName(n)); names = playerNames.map((n, s) => (s === me ? 'You' : n));
  aiSeats = new Set(state.ai);
  ({ dealNumber, totals, history, scored, busy, failure } = state);
  hostDeal = state.deal; decisionId = state.decision; guestReadKey = state.readKey; agentInfo = state.agent;
  const actions = state.engine.actions;
  engine = Object.assign(Object.create(PiquetEngine.prototype), state.engine, { legalActions: () => actions });
  deal = { log: state.log, engine };
  if (newDeal) { notes = new Map(); hint = null; reading = null; readAsked = ''; $('result-dialog').hidden = true; }
  if (moved) { selected = []; stateId++; }
  pending = false;
  lobbyPhase = 'playing';
  $('model-state').textContent = agentInfo ? `Agent ${agentInfo.run} · ${agentInfo.iteration.toLocaleString()} · host` : 'Host agent';
  $('model-state').classList.toggle('is-ready', Boolean(agentInfo));
  showGame();
  render();
  void requestHint();
  if (engine.done && scored && resultShown !== hostDeal) showResult();
}

function onMessage(message, peer) {
  if (!message || typeof message !== 'object') return;
  if (role === 'host') {
    if (message.type === 'join') {
      if (lobbyPhase !== 'lobby') { room.send({ type: 'rejected', message: 'That table has already started.' }, peer).catch(() => {}); return; }
      if (!guests.has(peer) && guests.size >= 1) { room.send({ type: 'rejected', message: 'That table is full.' }, peer).catch(() => {}); return; }
      guests.set(peer, cleanName(message.name));
      updateHostLobby();
    } else if (message.type === 'move') remoteMove(message, peer);
    else if (message.type === 'advise') void adviseGuest(message, peer);
    else if (message.type === 'read') void readForGuest(message, peer);
    return;
  }
  if (message.type === 'host_hello') {
    if (hostPeer && hostPeer !== peer) return;
    hostPeer = peer;
    room.send({ type: 'join', name: cleanName($('player-name').value) }, peer).catch(() => {});
    return;
  }
  if (peer !== hostPeer) return;
  if (message.type === 'lobby') {
    renderLobby({ hostName: cleanName(message.hostName, 'Host'), names: (message.names ?? []).map(n => cleanName(n)), status: 'Connected. Waiting for the host to deal.' });
  } else if (message.type === 'starting') {
    $('lobby-status').textContent = 'The host is loading the agent and dealing…';
  } else if (message.type === 'state') {
    applyState(message);
  } else if (message.type === 'advice') {
    if (message.request !== hintRequest || askedState !== stateId) return;
    hint = { ...message.advice, id: stateId };
    render();
  } else if (message.type === 'reading') {
    if (message.request !== readRequest) return;
    reading = { key: message.key, belief: message.belief };
    renderCardRead();
  } else if (message.type === 'rejected' || message.type === 'closed') {
    void leaveTable(message.message || 'The host closed this table.');
  }
}

function onPeerJoin(peer) {
  if (role === 'host') room.send({ type: 'host_hello' }, peer).catch(() => {});
}

function onPeerLeave(peer) {
  if (role === 'guest') { if (peer === hostPeer) void leaveTable('The host left, so the table has closed.'); return; }
  if (lobbyPhase !== 'playing') { guests.delete(peer); updateHostLobby(); return; }
  const seat = peerSeat.get(peer);
  if (seat === undefined) return;
  peerSeat.delete(peer); seatPeer.delete(seat); sent.delete(peer);
  // The agent takes over the seat, so the partie plays on.
  aiSeats.add(seat);
  if (engine) {
    deal.log.push({ left: true, actor: seat });
    render();
    void advanceBots();
  }
}

function onNetworkError(message) {
  if (lobbyPhase === 'playing') $('status').textContent = message; else setSetupError(message);
}

const lockModes = locked => document.querySelectorAll('input[name="playMode"], input[name="multiplayerRole"]').forEach(input => { input.disabled = locked; });

async function openLobby() {
  setSetupError();
  const hosting = lobbyRole() === 'host';
  const playerName = cleanName($('player-name').value, hosting ? 'Host' : 'Player');
  $('player-name').value = playerName;
  try { localStorage.setItem('piquet-player-name', playerName); } catch {}
  const code = hosting ? generateRoomCode() : normalizeRoomCode($('join-code').value);
  if (!validRoomCode(code)) { $('join-code').focus(); setSetupError('Enter the complete 8-character table code.'); return; }
  $('start').disabled = true;
  $('start').textContent = hosting ? 'Opening table…' : 'Finding table…';
  lockModes(true);
  role = hosting ? 'host' : 'guest'; lobbyPhase = 'connecting'; hostPeer = null;
  guests = new Map(); peerSeat = new Map(); seatPeer = new Map(); sent = new Map();
  revision = 0; applied = -1; resultShown = -1; hostDeal = -1; askedState = -1; readAsked = '';
  room = new PeerRoom({ game: 'piquet', role, code, onMessage, onPeerJoin, onPeerLeave, onError: onNetworkError });
  try { await room.connect(); }
  catch (error) {
    room = null; role = null; lobbyPhase = 'idle';
    $('start').disabled = false; lockModes(false); configureSetup();
    setSetupError(error.message || 'The multiplayer network could not be loaded.');
    return;
  }
  lobbyPhase = 'lobby';
  $('start').hidden = true; $('start').disabled = false;
  $('lobby').hidden = false;
  $('lobby-code').textContent = code;
  $('start-multiplayer').hidden = !hosting;
  if (hosting) updateHostLobby();
  else {
    $('model-state').textContent = 'Waiting for host';
    renderLobby({ hostName: 'Finding host…', status: 'Looking for the host. Keep this tab open while the table connects.' });
  }
}

async function startHosted() {
  if (role !== 'host' || lobbyPhase !== 'lobby' || !guests.size) return;
  lobbyPhase = 'starting';
  $('start-multiplayer').disabled = true;
  room.send({ type: 'starting' }).catch(() => {});
  difficulty = Number($('difficulty').value);
  if (!(await loadAgent()) || !guests.size) { lobbyPhase = 'lobby'; $('loading').hidden = true; updateHostLobby(); return; }
  const [[peer, friend]] = guests;
  peerSeat.set(peer, 1); seatPeer.set(1, peer);
  me = 0; them = 1; lobbyPhase = 'playing';
  playerNames = [cleanName($('player-name').value, 'Host'), friend]; names = ['You', friend]; aiSeats = new Set();
  newPartie();
}

// Leave the multiplayer table (or the solo game) and return to the setup screen.
async function leaveTable(error = '') {
  const active = room;
  if (role === 'host' && active) await active.send({ type: 'closed', message: 'The host closed this table.' }).catch(() => {});
  generation++; deal = null; engine = null; busy = false; failure = false; pending = false; selected = []; hint = null; reading = null;
  room = null; role = null; lobbyPhase = 'idle'; hostPeer = null; me = 0; them = 1;
  guests = new Map(); peerSeat = new Map(); seatPeer = new Map(); sent = new Map();
  $('result-dialog').hidden = true; $('game-error').hidden = true; $('game').hidden = true; $('setup').hidden = false;
  $('lobby').hidden = true; $('start').hidden = false; $('start').disabled = false; $('start-multiplayer').hidden = true; $('live-badge').hidden = true;
  $('model-state').textContent = agentInfo && agent.manifest ? `Agent ${agentInfo.run} · ${agentInfo.iteration.toLocaleString()}` : 'Agent not loaded';
  $('model-state').classList.toggle('is-ready', Boolean(agent.manifest));
  lockModes(false); configureSetup();
  if (error) setSetupError(error);
  await active?.leave().catch(() => {});
}

$('setup-form').addEventListener('submit', event => {
  event.preventDefault();
  if (playMode() === 'solo') void startSolo(); else void openLobby();
});
document.querySelectorAll('input[name="playMode"], input[name="multiplayerRole"]').forEach(input => input.addEventListener('change', configureSetup));
$('join-code').addEventListener('input', () => { $('join-code').value = normalizeRoomCode($('join-code').value); });
$('start-multiplayer').addEventListener('click', startHosted);
$('leave-lobby').addEventListener('click', () => leaveTable());
$('copy-code').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('lobby-code').textContent.trim()); $('lobby-status').textContent = 'Code copied. Send it to your friend.'; }
  catch {
    const range = document.createRange(); range.selectNodeContents($('lobby-code'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
    $('lobby-status').textContent = 'Code selected — copy it and send it to your friend.';
  }
});
$('difficulty').addEventListener('input', () => {
  snapDifficulty($('difficulty'));
  $('difficulty-output').textContent = difficultyLabel(Number($('difficulty').value));
});
$('setup-hints').addEventListener('change', () => { $('hints').checked = $('setup-hints').checked; });
$('setup-values').addEventListener('change', () => { $('values').checked = $('setup-values').checked; });
window.addEventListener('beforeunload', () => { room?.leave(); });
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
  if (button.matches('[data-results]')) { $('result-dialog').hidden = false; render(); $(role === 'guest' ? 'review' : 'next-round').focus(); return; }
  if (!humanTurn()) return;
  if (button.matches('[data-clear]')) { selected = []; stateId++; render(); void requestHint(); }
  else if (button.matches('[data-agent-pick]')) { selected = [...currentHint().plan.cards]; stateId++; render(); void requestHint(); }
  else if (button.matches('[data-exchange]')) userExchange();
  else if (button.matches('[data-declare]')) userAction(Number(button.dataset.declare));
});
$('autoplay').addEventListener('click', () => { setAutoplay(!autoplay()); selected = []; stateId++; render(); void advanceBots(); });
$('speed').addEventListener('input', updateSpeed);
for (const [id, mirror] of [['hints', 'setup-hints'], ['values', 'setup-values']]) {
  $(id).addEventListener('change', () => { $(mirror).checked = $(id).checked; render(); void requestHint(); });
}
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
$('next-round').addEventListener('click', () => { if (role === 'guest') return; if (partieOver()) newPartie(); else startDeal(); });
$('new-table').addEventListener('click', () => {
  $('leave-copy').textContent = role === 'host' ? 'This closes the table for both of you. The score sheet will be cleared.'
    : role === 'guest' ? 'You will leave this multiplayer table; the agent takes over your seat.' : 'The current partie and the score sheet will be cleared.';
  $('leave-dialog').showModal();
});
$('leave').addEventListener('click', () => { $('leave-dialog').close(); void leaveTable(); });
$('retry').addEventListener('click', async () => {
  $('retry').disabled = true;
  try { await agent.load(); failure = false; $('game-error').hidden = true; void advanceBots(); }
  catch (error) { $('game-error-message').textContent = error.message; }
  finally { $('retry').disabled = false; }
});
updateSpeed();
try { $('player-name').value = cleanName(localStorage.getItem('piquet-player-name') || localStorage.getItem('rummy-player-name') || localStorage.getItem('plump-player-name')); } catch {}
configureSetup();
