import {
  HjarterEngine, PASS, PLAY, K_DEAL, K_TURN, K_PASS, K_RECEIVE, K_PLAY, HEARTS, SPADES, CLUBS, DIAMONDS,
  QUEEN_OF_SPADES, MAX_DEALS, REMOVED, HAND_SIZES, name, isRed, suitOf, rankOf, SUIT_WORDS, RANKS,
} from './engine.js?v=1';
import { heuristicCard } from './heuristic.js?v=1';
import { ObservationWriter, MODE_DEAL, MODE_GAME, F_TYPE, TYPE_TURN } from './tokens.js?v=1';
import { HjarterAgent } from './model-client.js?v=2';
import { PeerRoom, generateRoomCode, normalizeRoomCode, validRoomCode } from '../multiplayer.js';
import { difficultyLabel, snapDifficulty, temperatureFor } from '../difficulty.js';
import { AI_NAMES, savePlayerName, savedPlayerName } from '../players.js';
import { aiBadge, aiTotals, centered, formatValue, startReplay, valueCell } from '../score-compare.js';

const $ = id => document.getElementById(id);
// The table: player count, the rule variants, and how the computer seats play
// (the agent, the rule-based player, or random cards).
let settings = { players: 4, rules: { passCards: 2, jackOfDiamonds: false, endScore: 100 } };
// Seats: `me` is the local player. `names` is how this screen calls each seat ("You" for your own).
let me = 0, playerNames = [], names = [], aiSeats = new Set();
// A game: deals until someone reaches the end score. Each deal is its own engine,
// started from the totals so far; `log` is the deal's events as this screen may see them.
let engine = null, log = [], generation = 0, busy = false, decisionId = 0;
// The agent (loaded once, in a worker) and every seat's token stream of the deal.
// It plays the computer seats at `difficulty`, and your hand on auto-play at its best.
const agent = new HjarterAgent();
let writer = null, difficulty = 50, agentFailed = false, agentLoading = null, published = null;
// The agent's readout of your decision (`key` says which), the agent's own pass
// for each seat this deal, and remarks on your moves in the log.
let hint = null, hintRequest = 0, askedKey = '', passPlans = new Map(), notes = new Map();
let dealNumber = 0, firstDealer = 0, totals = [], history = [], scored = false, resultShown = -1;
// The deal replayed by the agent in every seat, for the score sheet (kept with the deal's history),
// and the game it belongs to: a new game leaves the old one's replays unfinished.
let replay = null, gameNumber = 0;
// Your pass while you choose it, and the passes chosen but not yet reached by the
// engine (the seats pass in turn, but everyone may choose at once).
let selected = [], passChoice = new Map();
// Multiplayer: the host deals, checks every move and plays the computer seats; a guest mirrors its view.
let role = null, room = null, lobbyPhase = 'idle', hostPeer = null, pending = false;
let guests = new Map(), peerSeat = new Map(), seatPeer = new Map(), sent = new Map();
let revision = 0, applied = -1, syncQueued = false, hostDeal = -1;
// A guest's copy of what the host says about the passes: who has passed, and its own pass.
let passedSeats = [], myPass = [];
// Whether the host can answer a guest's readouts: '' (no), 'loading' (its agent loads on the first ask) or 'ready'.
let hostReadouts = '';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const autoplay = () => $('autoplay').getAttribute('aria-pressed') === 'true';
// Slider 0..100 → a pause of 1.3 s down to nothing between the computer's moves.
const moveDelay = () => Math.round(1300 * Math.pow(1 - Number($('speed').value) / 100, 1.5));
const P = () => settings.players;
const passCount = () => settings.rules.passCards;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const cardAsset = c => `/resources/cards/${SUIT_WORDS[suitOf(c)]}-${RANKS[rankOf(c)].toLowerCase()}.svg`;
const chip = c => `<b class="card-chip ${isRed(c) ? 'is-red' : ''}">${name(c)}</b>`;
// Hand order: suits alternate colour (♠ ♥ ♣ ♦), low to high within each.
const SUIT_ORDER = [SPADES, HEARTS, CLUBS, DIAMONDS];
const handOrder = cards => [...cards].sort((a, b) => SUIT_ORDER.indexOf(suitOf(a)) - SUIT_ORDER.indexOf(suitOf(b)) || a - b);
const chips = cards => handOrder(cards).map(chip).join(' ');
const chipsText = cards => handOrder(cards).map(name).join(' ');
const verb = (seat, mine, theirs) => (seat === me ? mine : theirs);
const upperFirst = text => text[0].toUpperCase() + text.slice(1);
// Scores can go below zero with the jack of diamonds: a true minus.
const num = n => (n < 0 ? `−${-n}` : `${n}`);
// Where a seat sits from here: 0 is you, then clockwise from your left.
const offsetOf = seat => (seat - me + P()) % P();
const seatsFromMe = () => Array.from({ length: P() }, (_, offset) => (me + offset) % P());
const SUIT_NAMES = ['clubs', 'diamonds', 'spades', 'hearts'];

// ---- Rules in words ------------------------------------------------------------

function directionWord(direction, players = P()) {
  if (!direction) return 'none';
  if (direction === 1) return 'left';
  if (direction === players - 1) return 'right';
  return 'across';
}

function rulesSummary(s = settings) {
  const pass = s.rules.passCards ? `pass ${s.rules.passCards}` : 'no passing';
  return `${s.players} players · ${pass}${s.rules.jackOfDiamonds ? ' · J♦ −10' : ''} · to ${s.rules.endScore}`;
}

function cardsRemoved(players) {
  const removed = REMOVED[players];
  return removed.length ? `${removed.map(name).join(' and ')} removed` : 'the full deck';
}

// ---- Table flow ------------------------------------------------------------------

function newGame() {
  totals = Array(P()).fill(0); history = []; dealNumber = 0; gameNumber++;
  firstDealer = Math.floor(Math.random() * P());
  startDeal();
}

function showGame() {
  $('setup').hidden = true; $('game').hidden = false;
  $('autoplay').hidden = Boolean(role);
  $('speed-control').hidden = role === 'guest';
  $('live-badge').hidden = !role;
  $('live-badge').textContent = role === 'host' ? `Hosting · ${room.code}` : `Live table · ${room?.code}`;
}

const agentReady = () => Boolean(agent.manifest) && !agentFailed;

// The seats' streams as the agent trained: a single-deal agent saw every deal
// fresh (no score, its training's end score); a whole-game agent sees the score.
// Written from the published manifest even before the agent loads, so the
// readouts can start mid-deal when a switch loads it.
function agentWriter() {
  const training = (agent.manifest ?? published)?.training;
  if (!training) return null;
  if (training.mode === 'game') return new ObservationWriter(P(), settings.rules, MODE_GAME);
  return new ObservationWriter(P(), settings.rules, MODE_DEAL, { scores: Array(P()).fill(0), endScore: training.endScore });
}

function startDeal() {
  generation++; dealNumber++; scored = false; selected = []; passChoice = new Map(); busy = false; log = [];
  hint = null; askedKey = ''; passPlans = new Map(); notes = new Map();
  writer = agentWriter();
  // The deal moves left each hand; the passing cycle starts to the right.
  const deal = { players: P(), rules: settings.rules, deals: 1, dealIndex: dealNumber - 1, dealer: (firstDealer + dealNumber - 1) % P(), scores: [...totals] };
  engine = new HjarterEngine({ ...deal, listener: (table, event) => { log.push(event); writer?.onEvent(table, event); } });
  replay = role === 'guest' ? null : agentReplay(deal, engine.dealt);
  decisionId++;
  $('result-dialog').hidden = true;
  showGame();
  render();
  window.scrollTo({ top: 0 });
  void advance();
}

// The deal replayed by the agent at its best in every seat, its passes too, from the same
// hands and score: what it would have scored in each seat, for the score sheet.
function agentReplay(deal, dealt) {
  const game = gameNumber, hands = dealt.map(hand => [...hand]);
  return startReplay(async () => {
    if (!agentReady()) throw new Error('The agent is not loaded.');
    const streams = agentWriter();
    const table = new HjarterEngine({ ...deal, nextHands: () => hands, listener: (t, event) => streams.onEvent(t, event) });
    while (!table.done) {
      if (game !== gameNumber) return null;
      const legal = table.legalCards();
      table.apply(legal.length === 1 ? legal[0] : await agent.choose(streams.streams[table.current], table.head, legal, 0));
    }
    return game === gameNumber ? [...table.results[0].points] : null;
  }, () => { if (game === gameNumber) render(); });
}

const gameOver = () => totals.length > 0 && (Math.max(...totals) >= settings.rules.endScore || dealNumber >= MAX_DEALS);

// Seats the computer plays now: its own, yours on auto-play.
const computerSeat = seat => aiSeats.has(seat) || (seat === me && autoplay());
const forcedNow = () => engine.phase === PLAY && engine.legalCards().length === 1;

// The computer's card for `seat`: the agent's (at the difficulty for its own
// seats, its best for yours), or the rule-based player's if the agent stopped.
async function chooseFor(seat) {
  const table = engine, legal = table.legalCards();
  if (legal.length === 1) return legal[0];
  const computer = aiSeats.has(seat);
  if (writer && agentReady()) {
    try {
      return await agent.choose(writer.streams[seat], table.head, legal, computer ? temperatureFor(difficulty) : 0);
    } catch {
      // The rule-based player takes over for the rest of the session.
      agentFailed = true;
      showModelState();
    }
  }
  return heuristicCard(table);
}

function apply(c) {
  engine.apply(c);
  decisionId++;
  if (engine.done) setTimeout(finishDeal, 700);
}

// Play every move that does not wait for a person: the computer seats and passes
// people have chosen. A person plays every card themselves, even their only legal
// one, unless auto-play has their hand.
async function advance() {
  if (role === 'guest' || busy || !engine || engine.done) return;
  const version = generation;
  busy = true;
  try {
    while (version === generation && !engine.done) {
      const seat = engine.current;
      if (engine.phase === PASS) {
        // A pass is private and quick: nobody waits for the computer's.
        if (computerSeat(seat)) {
          const c = await chooseFor(seat);
          if (version !== generation) return;
          // Turning off auto-play while the agent chose gives the pass back.
          if (engine.current === seat && engine.phase === PASS && computerSeat(seat)) { apply(c); render(); }
          continue;
        }
        const choice = passChoice.get(seat);
        if (!choice) break;
        for (const c of choice) apply(c);
        passChoice.delete(seat);
        continue;
      }
      if (!computerSeat(seat)) break;
      render();
      // A new lead waits a little longer, so the finished trick can be seen.
      const delay = engine.trick.length ? moveDelay() : Math.round(moveDelay() * 1.5);
      const [c] = await Promise.all([chooseFor(seat), pause(delay)]);
      if (version !== generation) return;
      // Turning off auto-play during the pause gives the move back.
      if (engine.current !== seat || !computerSeat(seat)) continue;
      apply(c);
      render();
    }
  } finally {
    if (version === generation) { busy = false; render(); }
  }
}

// ---- Your moves ----------------------------------------------------------------------

// Whether a seat has chosen its pass this deal (it may not have reached the engine yet).
function hasPassed(seat) {
  if (role === 'guest') return Boolean(passedSeats[seat]);
  return engine.pending[seat].length === passCount() || passChoice.has(seat);
}

const canPass = () => engine && !engine.done && engine.phase === PASS && !hasPassed(me) && !autoplay() && !pending;
const myTurn = () => engine && !engine.done && engine.phase === PLAY && engine.current === me && !autoplay() && !pending;
// Your pass this deal, chosen or made.
const myPassCards = () => (role === 'guest' ? myPass : passChoice.get(me) ?? engine.pending[me]);
const passTarget = (seat = me) => (seat + engine.direction) % P();
const passSource = (seat = me) => (seat - engine.direction + P()) % P();

function userPass() {
  if (!canPass() || selected.length !== passCount()) return;
  const cards = [...selected], own = currentHint()?.own;
  if (own) notes.set('pass', sameSet(own, cards) ? ' The agent agrees.' : ` The agent would pass ${chipsText(own)}.`);
  if (role === 'guest') {
    pending = true; render();
    room.send({ type: 'pass', cards }, hostPeer).catch(() => {
      pending = false; notes.delete('pass'); render();
      $('status').textContent = 'Your pass did not reach the host. Try again.';
    });
    return;
  }
  passChoice.set(me, cards);
  selected = [];
  render();
  void advance();
}

function userPlay(c) {
  if (!myTurn() || !engine.legalCards().includes(c)) return;
  const advice = currentHint();
  if (advice) {
    const pick = advice.actions[advice.argmax];
    notes.set(`play:${c}`, pick === c ? ' The agent agrees.' : ` The agent would play the ${name(pick)}.`);
  }
  if (role === 'guest') {
    pending = true; render();
    room.send({ type: 'move', id: decisionId, card: c }, hostPeer).catch(() => {
      pending = false; notes.delete(`play:${c}`); render();
      $('status').textContent = 'The move did not reach the host. Try again.';
    });
    return;
  }
  apply(c);
  render();
  void advance();
}

const sameSet = (a, b) => a.length === b.length && a.every(c => b.includes(c));

// ---- The agent's readouts ----------------------------------------------------------------
// Two switches: the agent's move (its odds on every card) and the advantage.
const showOdds = () => $('hints').checked, showWorth = () => $('values').checked;
const wantsAdvice = () => showOdds() || showWorth();
// The decision the readouts are about: your pass as chosen so far, or your play.
const readoutOpen = () => canPass() || myTurn();
const adviceKey = () => `${role === 'guest' ? hostDeal : generation}:${engine.phase === PASS ? `pass:${selected.join()}` : `play:${decisionId}`}`;
const readoutsAvailable = () => (role === 'guest' ? hostReadouts : Boolean(writer) && !agentFailed);
const currentAdvice = () => (engine && wantsAdvice() && readoutOpen() && hint?.key === adviceKey() ? hint : null);
const currentHint = () => (showOdds() ? currentAdvice() : null);
const currentWorth = () => (showWorth() ? currentAdvice() : null);

// The value probe reads every seat from the viewer's: the other seats' average
// points this deal minus its own, so positive is good. Zero-sum over the seats in play.
const ownValue = values => values[0] - values.slice(0, P()).reduce((a, b) => a + b, 0) / P();

// `seat`'s stream at its pass, as the agent will read it: it is the seat's turn
// even while the seats before it are still passing, and the cards in `chosen`
// are on their way. Built on a copy, so the streams stay as they are.
function passTokens(seat, table = engine) {
  const sim = Object.assign(Object.create(ObservationWriter.prototype), writer, { streams: writer.streams.map(stream => [...stream]) });
  if (sim.streams[seat].at(-1)[F_TYPE] !== TYPE_TURN) sim.onEvent(table, { kind: K_TURN, seat, nextSeat: seat, nextPhase: PASS });
  const start = sim.streams[seat];
  return chosen => {
    sim.streams[seat] = [...start];
    for (const c of chosen) sim.onEvent(table, { kind: K_PASS, seat, card: c, nextSeat: seat, nextPhase: PASS });
    return sim.streams[seat];
  };
}

// Everything the readouts show for `seat`'s decision (the host also runs them
// for a guest, from the guest's own stream): the odds on its cards, the agent's
// own pass while passing, and the advantage now. While a seat chooses its pass,
// the odds are for its next card after the ones `chosen` so far.
async function assess(seat, chosen = []) {
  const table = engine, decision = decisionId;
  if (table.phase === PASS) {
    const tokens = passTokens(seat, table), hand = [...table.hands[seat]], k = passCount();
    const still = () => engine === table && table.phase === PASS && !hasPassed(seat);
    // The agent's own pass: its best card, then its best given that one, and so on.
    let own = passPlans.get(seat);
    if (!own) {
      own = { cards: [] };
      while (own.cards.length < k) {
        const actions = hand.filter(c => !own.cards.includes(c));
        const policy = await agent.policy(tokens(own.cards), 'pass', actions);
        if (!still()) return null;
        own.first ??= { actions, policy };
        own.cards.push(actions[policy.argmax]);
      }
      passPlans.set(seat, own);
    }
    // With every card chosen, the readout is about the last of them.
    const full = chosen.length >= k, before = full ? chosen.slice(0, -1) : chosen;
    let { actions, policy } = own.first;
    if (before.length) {
      actions = hand.filter(c => !before.includes(c));
      policy = await agent.policy(tokens(before), 'pass', actions);
      if (!still()) return null;
    }
    return { head: 'pass', actions, full, own: own.cards, probabilities: policy.probabilities, argmax: policy.argmax, now: ownValue(policy.value) };
  }
  const actions = table.legalCards();
  const policy = await agent.policy(writer.streams[seat], 'play', actions);
  if (engine !== table || decisionId !== decision) return null;
  return { head: 'play', actions, probabilities: policy.probabilities, argmax: policy.argmax, now: ownValue(policy.value) };
}

// The switches load the agent if the computer seats did not need it.
function ensureAgent() {
  if (agentReady() || agentFailed || agentLoading) return;
  agentLoading = agent.load()
    .catch(() => { agentFailed = true; })
    .finally(() => { agentLoading = null; showModelState(); render(); });
}

// Ask the agent about your decision; one request serves both switches. A
// guest's readout comes from the host, which runs the agent on the guest's own stream.
async function requestHint() {
  if (!engine || !wantsAdvice() || !readoutOpen() || !readoutsAvailable()) { askedKey = ''; if (hint) { hint = null; render(); } return; }
  if (role !== 'guest' && !agentReady()) { ensureAgent(); return; }
  const key = adviceKey();
  if (hint?.key === key || askedKey === key) return;
  askedKey = key;
  const request = ++hintRequest, chosen = engine.phase === PASS ? [...selected] : [];
  if (role === 'guest') {
    room.send({ type: 'advise', request, id: decisionId, selected: chosen }, hostPeer).catch(() => { if (askedKey === key) askedKey = ''; });
    return;
  }
  try {
    const advice = await assess(me, chosen);
    if (request !== hintRequest || !advice) return;
    hint = { ...advice, key };
    render();
  } catch (error) {
    console.error('The agent’s readout failed.', error);
  }
}

const percent = p => `${Math.round(p * 100)}%`;
// Points with their sign, a true minus, and `digits` decimals.
const points = (v, digits = 0) => {
  const text = Math.abs(v).toFixed(digits);
  return Number(text) === 0 ? text : `${v < 0 ? '−' : '+'}${text}`;
};

// A badge naming the move and its odds, on the card it uses; the agent's own
// pick is the highlighted one.
function marks(index, word) {
  const advice = currentHint();
  if (!advice || index < 0) return '';
  const pick = advice.argmax === index;
  // Cards the agent all but rules out stay unmarked, to keep the hand readable.
  if (!pick && advice.probabilities[index] < 0.005) return '';
  return `<span class="prob-badge ${pick ? 'is-pick' : ''}" ${pick ? 'title="The agent’s next card"' : ''}><span class="badge-verb">${word}</span><b>${percent(advice.probabilities[index])}</b></span>`;
}

function adviceText(advice) {
  if (advice.head === 'pass') return `The agent would pass ${chipsText(advice.own)}`;
  return `The agent would play the ${name(advice.actions[advice.argmax])} · ${percent(advice.probabilities[advice.argmax])}`;
}

// ---- Rendering ---------------------------------------------------------------------------

function render() {
  if (!engine) return;
  $('table-rules').textContent = rulesSummary();
  const direction = engine.direction;
  $('plaque').innerHTML = `<strong>Deal ${dealNumber}</strong>${direction ? `Pass ${passCount()} ${directionWord(direction)}` : 'No passing'} · to ${settings.rules.endScore}`;
  $('felt').className = `table-felt hjarter-felt players-${P()}`;
  $('game').style.setProperty('--pace', Math.max(0.25, Math.min(1.4, moveDelay() / 700)).toFixed(2));
  renderStatus();
  renderSeats();
  renderTrick();
  renderHand();
  renderActions();
  renderScores();
  renderLog();
  sync();
  void requestHint();
}

function waitingFor() {
  if (engine.phase === PASS) return seatsFromMe().filter(seat => !hasPassed(seat));
  return engine.current >= 0 ? [engine.current] : [];
}

function renderStatus() {
  const lines = logLines(), latest = lines.at(-1) ?? '';
  let status;
  if (engine.done) status = latest;
  else if (pending) status = 'Sending your move to the host…';
  else if (engine.phase === PASS) {
    if (canPass()) status = `Choose ${plural(passCount(), 'card')} to pass ${directionWord(engine.direction)} to ${names[passTarget()]}.`;
    else {
      const left = waitingFor().filter(seat => seat !== me);
      status = hasPassed(me) || autoplay() ? (left.length ? `Waiting for ${listNames(left)} to pass…` : 'Passing the cards…') : 'Passing…';
    }
  } else if (engine.current === me && !autoplay()) {
    status = forcedNow() ? `Your only legal card: the ${name(engine.legalCards()[0])}.` : engine.trick.length ? `Your play. ${latest}` : `Your lead. ${latest}`;
  } else {
    const who = names[engine.current];
    const doing = engine.current === me ? 'The computer is playing for you' : aiSeats.has(engine.current) ? `${who} is thinking` : `Waiting for ${who}`;
    status = `${doing}…${latest ? ` ${latest}` : ''}`;
  }
  const advice = currentHint();
  if (advice) status = adviceText(advice);
  else if (readoutOpen() && wantsAdvice() && readoutsAvailable()) status += ' The agent is considering…';
  $('status').textContent = status;
  $('status').classList.toggle('is-advice', Boolean(advice));
}

const listNames = seats => {
  const words = seats.map(seat => (seat === me ? 'you' : names[seat]));
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
};

function seatTag(seat, current) {
  if (aiSeats.has(seat)) return current && busy ? 'thinking…' : 'AI';
  if (current) return 'playing…';
  return seat === 0 ? 'Host' : 'Friend';
}

// A seat's place at the table: the opponents sit round the far side of the
// oval, clockwise from your left; `x`, `y` are its direction from the middle.
function direction(seat) {
  const angle = (-90 - (offsetOf(seat) * 360) / P()) * (Math.PI / 180);
  return { x: Math.cos(angle), y: -Math.sin(angle) };
}

function penaltyChips(seat) {
  const parts = [];
  if (engine.queenTaker === seat) parts.push('<span class="seat-known penalty-chip">took <b class="card-chip">Q♠</b></span>');
  if (engine.jackTaker === seat) parts.push('<span class="seat-known bonus-chip">took <b class="card-chip is-red">J♦</b></span>');
  return parts.join('');
}

function handSize(seat) {
  return engine.counts ? engine.counts[seat] : engine.hands[seat].length;
}

function renderSeats() {
  const passing = engine.phase === PASS;
  // The cards you passed, while the seat you gave them to still holds them.
  const mine = myPassCards();
  const given = passing || !mine?.length ? [] : mine.filter(c => !engine.played.includes(c));
  $('seats').innerHTML = seatsFromMe().slice(1).map(seat => {
    const current = !engine.done && (passing ? !hasPassed(seat) : engine.current === seat);
    const { x, y } = direction(seat);
    const count = handSize(seat);
    const notes = [penaltyChips(seat)];
    if (passing) notes.push(`<span class="seat-action">${hasPassed(seat) ? `Passed ${plural(passCount(), 'card')}` : 'Choosing a pass…'}</span>`);
    else if (given.length && seat === passTarget()) notes.push(`<span class="seat-known">Has your ${chips(given)}</span>`);
    return `<div class="seat hjarter-seat ${current ? 'is-current' : ''}" style="--sx:${(50 + x * 45).toFixed(1)}%;--sy:${(50 + y * 42).toFixed(1)}%">
      <div class="seat-name"><span>${escapeHtml(names[seat])}</span><span>${seatTag(seat, current && !passing)}</span></div>
      <div class="opponent-hand" aria-label="${plural(count, 'card')}">${'<span class="opponent-card"></span>'.repeat(count)}</div>
      <div class="seat-stats"><span>${plural(count, 'card')}</span><span title="Penalty points taken this deal">♥ ${engine.taken[seat]}</span><span title="Score">Σ ${num(totals[seat])}</span></div>
      <div class="seat-notes">${notes.join('')}</div>
    </div>`;
  }).join('');
}

// The trick in the middle: each card sits towards whoever played it, and flies
// in from their seat. The last finished trick stays until the next lead.
function renderTrick() {
  const live = engine.trick.length > 0, finished = !live && engine.lastTrick;
  const cards = live ? engine.trick : finished ? engine.lastTrick.cards : [];
  const index = live ? engine.trickIndex : finished ? engine.lastTrick.index : -1;
  const zone = $('trick'), key = `${generation}:${hostDeal}:${index}`;
  if (zone.dataset.key !== key) { zone.replaceChildren(); zone.dataset.key = key; }
  const winner = finished ? engine.lastTrick.winner : -1;
  const keep = new Set();
  cards.forEach(([seat, c], position) => {
    const id = `${seat}:${c}`;
    keep.add(id);
    let figure = zone.querySelector(`[data-play="${id}"]`);
    if (!figure) {
      const { x, y } = direction(seat);
      figure = document.createElement('div');
      figure.className = 'trick-card';
      figure.dataset.play = id;
      figure.setAttribute('role', 'img');
      figure.style.setProperty('--tx', x.toFixed(3));
      figure.style.setProperty('--ty', y.toFixed(3));
      figure.style.setProperty('--card-rotate', `${((seat * 7 + rankOf(c) * 3) % 9) - 4}deg`);
      figure.innerHTML = `<img src="${cardAsset(c)}" alt="" draggable="false" />`;
      zone.append(figure);
    }
    figure.setAttribute('aria-label', `${names[seat]} ${position ? 'played' : 'led'} the ${name(c)}${seat === winner ? ', and took the trick' : ''}`);
    figure.classList.toggle('is-lead', position === 0);
    figure.classList.toggle('is-winner', seat === winner);
  });
  zone.querySelectorAll('.trick-card').forEach(figure => { if (!keep.has(figure.dataset.play)) figure.remove(); });

  const parts = [];
  if (engine.phase === PASS) parts.push(`Pass ${directionWord(engine.direction)}: to ${names[passTarget()]}, from ${names[passSource()]}`);
  else if (finished) parts.push(`Trick ${engine.lastTrick.index + 1}: ${winnerText(engine.lastTrick)}`);
  else if (!engine.done) parts.push(`Trick ${engine.trickIndex + 1} of ${engine.handSize}`);
  if (engine.phase !== PASS) {
    parts.push(engine.broken ? '<span class="info-chip is-broken">♥ broken</span>' : '<span class="info-chip">♥ not broken</span>');
    parts.push(engine.queenTaker >= 0 ? `<span class="info-chip">Q♠ → ${escapeHtml(names[engine.queenTaker])}</span>` : `<span class="info-chip">Q♠ ${engine.played.includes(QUEEN_OF_SPADES) ? 'played' : 'out'}</span>`);
    if (settings.rules.jackOfDiamonds) parts.push(engine.jackTaker >= 0 ? `<span class="info-chip">J♦ → ${escapeHtml(names[engine.jackTaker])}</span>` : '<span class="info-chip">J♦ out</span>');
  }
  $('trick-info').innerHTML = parts.map(part => (part.startsWith('<') ? part : `<span>${escapeHtml(part)}</span>`)).join('');
}

function winnerText(trick) {
  const taker = trick.winner === me ? 'you take it' : `${names[trick.winner]} takes it`;
  return trick.points ? `${taker}, ${trick.points > 0 ? '+' : '−'}${Math.abs(trick.points)}` : taker;
}

function renderHand() {
  const passing = canPass(), playing = myTurn();
  const legal = new Set(playing ? engine.legalCards() : []);
  const passed = engine.phase === PASS ? myPassCards() ?? [] : [];
  const received = new Set(engine.phase === PLAY && engine.trickIndex === 0 ? engine.received[me] : []);
  const hand = handOrder(engine.hands[me].filter(c => !passed.includes(c)));
  const worth = currentWorth();
  $('human-label').innerHTML = `<span>You</span><span>${plural(hand.length, 'card')}</span><span title="Penalty points taken this deal">♥ ${engine.taken[me]}</span><span title="Score">Σ ${num(totals[me])}</span>${engine.queenTaker === me ? '<span>took Q♠</span>' : ''}${engine.jackTaker === me ? '<span>took J♦</span>' : ''}${worth ? `<span class="advantage-now" title="The agent’s estimate of the other players’ average points this deal, minus yours: positive when you take fewer">Advantage ${points(worth.now, 1)}</span>` : ''}`;
  $('human-label').classList.toggle('is-current', !engine.done && (engine.phase === PASS ? !hasPassed(me) : engine.current === me));
  // The cards the agent's move would use are framed: its whole pass, or the card it would play.
  const odds = currentHint();
  const advised = new Set(odds ? (odds.head === 'pass' ? odds.own : [odds.actions[odds.argmax]]) : []);
  const focused = document.activeElement?.dataset?.card;
  $('hand').classList.toggle('is-waiting', !passing && !playing && !engine.done);
  $('hand').innerHTML = hand.map(c => {
    const chosen = passing && selected.includes(c);
    const usable = passing ? chosen || selected.length < passCount() : playing && legal.has(c);
    const illegal = playing && !legal.has(c);
    const fresh = received.has(c) ? `<span class="new-badge" title="Passed to you by ${escapeHtml(names[passSource()])}">New</span>` : '';
    let badge = '';
    if (odds && passing && !chosen && !odds.full) badge = marks(odds.actions.indexOf(c), 'Pass');
    else if (odds && playing && legal.has(c)) badge = marks(odds.actions.indexOf(c), 'Play');
    const label = `${name(c)}${chosen ? ', chosen to pass' : ''}${illegal ? ', cannot be played now' : ''}${fresh ? ', passed to you' : ''}`;
    return `<button type="button" class="rummy-card ${chosen ? 'is-selected' : ''} ${advised.has(c) ? 'is-advised' : ''} ${illegal ? 'is-illegal' : ''}" data-card="${c}" aria-label="${label}" ${passing ? `aria-pressed="${chosen}"` : ''} ${usable ? '' : 'disabled'}><img src="${cardAsset(c)}" alt="" draggable="false" />${fresh}${badge}</button>`;
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
  const peek = Math.max(0.28, Math.min(widest, (hand.clientWidth - 8 - width) / ((cards.length - 1) * width)));
  hand.style.setProperty('--peek', peek.toFixed(3));
  hand.classList.remove('is-narrow');
  const badges = [...hand.querySelectorAll('.rummy-card .prob-badge:not(.is-pick)')];
  hand.classList.toggle('is-narrow', badges.some(badge => badge.offsetWidth + 3 > peek * width));
}

function playHelp() {
  const legal = engine.legalCards();
  if (!engine.trick.length) {
    if (engine.trickIndex === 0) return `You hold the ${name(engine.lead)}: play it to lead the first trick.`;
    if (legal.length === 1) return `Your lead: the ${name(legal[0])} is your only legal card.`;
    if (!engine.broken) return legal.some(c => suitOf(c) === HEARTS) ? 'Your lead: you hold only hearts, so you may lead one.' : 'Your lead. Hearts are not broken yet: lead another suit.';
    return 'Your lead: any card.';
  }
  const suit = SUIT_NAMES[engine.led];
  if (legal.length === 1) return `Your only legal card is the ${name(legal[0])}: play it.`;
  if (legal.every(c => suitOf(c) === engine.led)) return `Follow suit: ${suit} were led.`;
  if (engine.trickIndex === 0 && legal.length < engine.hands[me].length) return `You have no ${suit}. No hearts and no Q♠ in the first trick.`;
  return `You have no ${suit}: play any card.`;
}

function renderActions() {
  let help = '', buttons = '';
  if (engine.done) {
    help = 'The deal is over.';
    if ($('result-dialog').hidden && scored) buttons = `<button class="game-button is-default" type="button" data-results>${gameOver() ? 'Show the final scores' : 'Show scores &amp; next deal'}</button>`;
  } else if (pending) help = 'Sending your move to the host…';
  else if (engine.phase === PASS) {
    const target = names[passTarget()], k = passCount();
    if (canPass()) {
      const count = selected.length;
      help = count < k ? `Choose ${plural(k - count, count ? 'more card' : 'card', count ? 'more cards' : 'cards')} to pass ${directionWord(engine.direction)} to ${target}.` : `Pass ${chipsText(selected)} to ${target}?`;
      const own = currentHint()?.own;
      buttons = `<button class="game-button" type="button" data-clear ${count ? '' : 'disabled'}>Clear</button>`
        + (own && !sameSet(own, selected) ? '<button class="game-button" type="button" data-agent-pick>Choose the agent’s cards</button>' : '')
        + `<button class="game-button ${count === k ? 'is-default' : ''}" type="button" data-pass ${count === k ? '' : 'disabled'}>Pass ${plural(k, 'card')}</button>`;
    } else if (autoplay() && !hasPassed(me)) help = 'The computer is choosing your pass.';
    else {
      const left = waitingFor().filter(seat => seat !== me);
      help = `You pass ${chipsText(myPassCards() ?? [])} to ${target}.${left.length ? ` Waiting for ${listNames(left)}…` : ''}`;
    }
  } else if (engine.current === me && autoplay()) help = 'The computer is playing your hand.';
  else if (myTurn()) help = playHelp();
  else help = `${names[engine.current]} ${aiSeats.has(engine.current) ? 'is thinking' : 'is playing'}. Your cards stay private.`;
  $('selection-help').textContent = help;
  $('action-buttons').innerHTML = buttons;
}

function renderScores() {
  const seats = seatsFromMe();
  const head = `<thead><tr><th>Deal</th>${seats.map(seat => `<th title="${escapeHtml(names[seat])}">${escapeHtml(names[seat])}</th>`).join('')}</tr></thead>`;
  // Each deal's points with V (the others' average minus yours: positive when you took fewer),
  // and the agent's in the same seat when it played the deal in every seat.
  const ai = (record, seat, what) => aiBadge(record, seat, { format: num, lower: true, what });
  const rows = history.map(h => `<tr><td>${h.deal}</td>${seats.map(seat => {
    const cls = h.moon === seat ? 'is-hit' : h.points[seat] >= 13 ? 'is-miss' : '';
    const value = centered(h.points, seat, true);
    return `<td class="${cls} has-ai-score" title="${escapeHtml(names[seat])}: ${num(h.points[seat])}, V ${formatValue(value)}">${valueCell(`${num(h.points[seat])}${h.moon === seat ? ' ☾' : ''}`, value)}${ai(h.ai, seat, 'this deal')}</td>`;
  }).join('')}</tr>`).join('');
  const live = !scored ? `<tr class="is-active"><td>${dealNumber}</td>${seats.map(seat => `<td>${engine.taken[seat]}</td>`).join('')}</tr>` : '';
  const low = Math.min(...totals), aiTotal = aiTotals(history.map(h => h.ai), P());
  const total = `<tr class="score-total-row"><td>Total</td>${seats.map(seat => {
    const cls = history.length && totals[seat] === low ? 'is-leader' : '';
    if (!history.length) return `<td class="${cls}">${num(totals[seat])}</td>`;
    return `<td class="${cls} has-ai-score">${valueCell(num(totals[seat]), centered(totals, seat, true))}${ai(aiTotal, seat, 'every deal so far')}</td>`;
  }).join('')}</tr>`;
  $('score-table').innerHTML = `${head}<tbody>${rows}${live}${total}</tbody>`;
  $('score-caption').textContent = `Deal ${dealNumber} · to ${settings.rules.endScore}`;
  const jack = settings.rules.jackOfDiamonds ? ' The J♦ scores −10.' : '';
  $('score-legend').textContent = `Hearts 1, Q♠ 13; the moon (all of them) gives everyone else 26.${jack} After the deal in which someone reaches ${settings.rules.endScore}, the lowest total wins. ${upperFirst(cardsRemoved(P()))}, ${HAND_SIZES[P()]} cards each. V: the others' average points minus yours, positive when you took fewer. AI: the same deal played by the agent at its best in every seat, from the same hands.`;
}

function renderLog() {
  $('turn-count').textContent = engine.phase === PLAY || engine.done ? `Trick ${Math.min(engine.trickIndex + 1, engine.handSize)}` : 'Passing';
  $('activity').innerHTML = logLines(true).map(line => `<li>${escapeHtml(line)}</li>`).reverse().join('');
}

// The deal's events in words. Passes show as a seat's whole pass (its cards only
// for your own); cards passed to you as one line. With `remarks`, your moves
// carry whether the agent agreed.
function logLines(remarks = false) {
  const remark = key => (remarks ? notes.get(key) ?? '' : '');
  const lines = [], passes = new Map();
  let heartsBroken = false, receivedShown = false;
  for (const ev of log) {
    const who = ev.seat === me ? 'You' : names[ev.seat];
    if (ev.left) { lines.push(`${names[ev.seat]} left the table; the computer plays their hand now.`); continue; }
    if (ev.kind === K_DEAL) {
      const dealer = engine.dealer === me ? 'You deal' : `${names[engine.dealer]} deals`;
      lines.push(`Deal ${dealNumber}: ${dealer}. ${engine.direction ? `Pass ${plural(passCount(), 'card')} ${directionWord(engine.direction)}.` : 'No passing this deal.'}`);
    } else if (ev.kind === K_PASS) {
      const cards = [...(passes.get(ev.seat) ?? []), ev.card];
      passes.set(ev.seat, cards);
      if (cards.length === passCount()) {
        const to = names[passTarget(ev.seat)];
        lines.push(ev.seat === me ? `You pass ${chipsText(cards)} to ${to}.${remark('pass')}` : `${who} passes ${plural(cards.length, 'card')} to ${passTarget(ev.seat) === me ? 'you' : to}.`);
      }
    } else if (ev.kind === K_RECEIVE) {
      if (ev.seat === me && !receivedShown) {
        receivedShown = true;
        lines.push(`You get ${chipsText(engine.received[me])} from ${names[ev.giver]}.`);
      }
    } else if (ev.kind === K_PLAY) {
      let line = `${who} ${ev.position ? verb(ev.seat, 'play', 'plays') : verb(ev.seat, 'lead', 'leads')} the ${name(ev.card)}`;
      if (suitOf(ev.card) === HEARTS && !heartsBroken) { heartsBroken = true; line += ': hearts are broken'; }
      if (ev.complete) {
        const taker = ev.winning === me ? 'you take' : `${names[ev.winning]} takes`;
        line += `; ${taker} the trick${ev.points ? ` (${ev.points > 0 ? '+' : '−'}${Math.abs(ev.points)})` : ''}`;
      }
      lines.push(`${line}.${ev.seat === me ? remark(`play:${ev.card}`) : ''}`);
    }
  }
  if (engine.done && scored) lines.push(dealSummary(history.at(-1)));
  return lines;
}

function dealSummary(h) {
  if (h.moon >= 0) return `${h.moon === me ? 'You take' : `${names[h.moon]} takes`} the moon: everyone else scores 26.`;
  const scores = seatsFromMe().map(seat => `${seat === me ? 'you' : names[seat]} ${num(h.points[seat])}`).join(', ');
  return `The deal scores ${scores}.`;
}

// ---- The end of a deal and of the game ------------------------------------------------

function finishDeal() {
  if (role === 'guest' || scored || !engine?.done) return;
  scored = true;
  const result = engine.results.at(-1);
  totals = [...engine.scores];
  history.push({
    deal: dealNumber, direction: result.direction, taken: result.taken, points: result.points, moon: result.moon,
    queen: result.queen, jack: result.jack, passed: result.passed, received: result.received, ai: replay,
  });
  showResult();
}

function showResult() {
  resultShown = role === 'guest' ? hostDeal : generation;
  const h = history.at(-1), over = gameOver(), seats = seatsFromMe();
  const nameOf = seat => (seat === me ? 'You' : names[seat]);
  $('result-kicker').textContent = over ? 'Game over' : `Deal ${h.deal} complete`;
  if (over) {
    const low = Math.min(...totals), winners = seats.filter(seat => totals[seat] === low);
    $('result-title').textContent = winners.length > 1 ? `A shared win: ${listNames(winners)}, ${num(low)} each.`
      : winners[0] === me ? `You win with ${num(low)}!` : `${names[winners[0]]} wins with ${num(low)}.`;
    const high = Math.max(...totals), losers = seats.filter(seat => totals[seat] === high);
    $('result-description').textContent = `${upperFirst(listNames(losers))} reached ${high}, past ${settings.rules.endScore}. The lowest score wins.`;
  } else {
    $('result-title').textContent = h.moon >= 0 ? `${h.moon === me ? 'You take' : `${names[h.moon]} takes`} the moon!`
      : h.queen === me ? 'You took the queen of spades.' : `${names[h.queen]} took the queen of spades.`;
    const low = Math.min(...totals), leaders = seats.filter(seat => totals[seat] === low);
    const high = Math.max(...totals);
    $('result-description').textContent = `${h.moon >= 0 ? 'Everyone else scores 26. ' : ''}${leaders.length > 1 ? `${upperFirst(listNames(leaders))} lead` : `${nameOf(leaders[0])} ${verb(leaders[0], 'lead', 'leads')}`} with ${num(low)}; the highest score is ${high}, ${settings.rules.endScore - high} from the end.`;
  }
  const jack = settings.rules.jackOfDiamonds;
  const order = over ? [...seats].sort((a, b) => totals[a] - totals[b]) : seats;
  const low = Math.min(...totals);
  const rows = order.map(seat => {
    const hearts = h.taken[seat] - (h.queen === seat ? 13 : 0);
    return `<tr class="${over && totals[seat] === low ? 'is-winner' : ''}"><td>${escapeHtml(nameOf(seat))}${h.moon === seat ? ' ☾' : ''}</td><td>${hearts}</td><td>${h.queen === seat ? '13' : ''}</td>${jack ? `<td>${h.jack === seat ? '−10' : ''}</td>` : ''}<td><b>${num(h.points[seat])}</b></td><td>${num(totals[seat])}</td></tr>`;
  }).join('');
  $('scores').innerHTML = `<table class="score-table"><thead><tr><th></th><th>♥</th><th>Q♠</th>${jack ? '<th>J♦</th>' : ''}<th>Deal</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>`;
  const passed = h.passed?.[me] ?? [], got = h.received?.[me] ?? [];
  $('result-reveal').innerHTML = h.direction && passed.length
    ? `You passed ${chips(passed)} to ${escapeHtml(names[(me + h.direction) % P()])} and got ${chips(got)} from ${escapeHtml(names[(me - h.direction + P()) % P()])}.`
    : 'No passing this deal.';
  $('next-round').disabled = role === 'guest';
  $('next-round').textContent = role === 'guest' ? (over ? 'The host starts the next game' : 'The host deals next') : over ? 'New game' : 'Deal next';
  $('result-dialog').hidden = false;
  render();
  $(role === 'guest' ? 'review' : 'next-round').focus({ preventScroll: true });
}

// ---- Setup and controls ------------------------------------------------------------------

function setAutoplay(on) {
  $('autoplay').setAttribute('aria-pressed', String(on));
  $('autoplay').textContent = on ? 'Stop auto-play' : 'Auto-play my hand';
}

function updateSpeed() {
  const delay = moveDelay();
  $('speed-output').textContent = delay ? `${(delay / 1000).toFixed(2)} s` : 'instant';
}

const setSetupError = (message = '') => { $('setup-error').hidden = !message; $('setup-error').textContent = message; };

function readSettings() {
  return {
    players: Number($('players').value),
    rules: { passCards: Number($('pass-cards').value), jackOfDiamonds: $('jack').value === 'on', endScore: Number($('end-score').value) },
  };
}

function showModelState() {
  const ready = agentReady();
  $('model-state').textContent = agentFailed ? 'Agent stopped · rule-based play'
    : ready ? `Agent ${agent.manifest.run} · ${agent.manifest.iteration.toLocaleString()}` : 'Agent not loaded';
  $('model-state').classList.toggle('is-ready', ready);
}

// Load the agent once; the progress shows under the setup.
async function loadAgent() {
  if (agentReady()) return true;
  setSetupError();
  agentFailed = false;
  $('start').disabled = true; $('start-multiplayer').disabled = true; $('loading').hidden = false;
  try {
    await agent.load(({ percent, message }) => {
      $('load-message').textContent = message; $('load-percent').textContent = `${percent}%`; $('load-bar').style.width = `${percent}%`;
    });
    showModelState();
    return true;
  } catch (error) {
    setSetupError(`${error.message} Try again, or reload the page.`);
    return false;
  } finally {
    $('loading').hidden = true;
    $('start').disabled = false; $('start-multiplayer').disabled = false;
  }
}

async function startSolo() {
  const table = readSettings();
  difficulty = Number($('difficulty').value);
  if (!(await loadAgent())) return;
  settings = table;
  role = null; me = 0;
  playerNames = ['You', ...AI_NAMES.slice(0, P() - 1)]; names = [...playerNames];
  aiSeats = new Set(Array.from({ length: P() - 1 }, (_, i) => i + 1));
  setAutoplay(false);
  newGame();
}

// What the agent has trained on so far, from its manifest (a small file; the
// weights load when you sit down).
async function describeAgent() {
  let manifest;
  try {
    const response = await fetch(new URL('./model/manifest.json', import.meta.url), { cache: 'no-cache' });
    if (!response.ok) return;
    manifest = await response.json();
  } catch { return; }
  published = manifest;
  const { training } = manifest;
  const list = items => (items.length < 2 ? `${items[0]}` : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);
  const players = training.players.length > 2 && training.players.every((n, i) => !i || n === training.players[i - 1] + 1)
    ? `${training.players[0]}–${training.players.at(-1)}` : list(training.players);
  const passing = training.passCards.filter(Boolean);
  const pass = passing.length ? `passing ${list(passing)} ${passing.length === 1 && passing[0] === 1 ? 'card' : 'cards'}${training.passCards.includes(0) ? ' or none' : ''}` : 'without passing';
  const jack = training.jackOfDiamonds.length > 1 ? 'with and without' : training.jackOfDiamonds[0] ? 'with' : 'without';
  const untrained = [0, 1, 2, 3].filter(k => !training.passCards.includes(k));
  $('agent-notice').innerHTML = `<strong>The agent is still in training</strong> (run ${escapeHtml(manifest.run)}, update ${Number(manifest.iteration).toLocaleString()}). `
    + `So far it has played ${training.mode === 'game' ? `whole games to ${training.endScore}` : 'single deals'} with ${players} players, ${pass}, ${jack} the jack of diamonds. `
    + (training.mode === 'game' ? 'It sees the score.' : 'It plays each deal for its own points and does not look at the game score.')
    + (untrained.length ? ` ${untrained.length === 1 && untrained[0] === 0 ? 'No passing is' : 'Other passing counts are'} new to it.` : '');
}

// ---- Multiplayer ------------------------------------------------------------------------
// The host owns the deal and plays the computer seats. A guest gets the table as
// its seat sees it: its own hand, the counts, the trick and what has been
// played, its own pass and the cards passed to it, and its legal cards on its
// turn. It sends its pass and its moves, which the host checks before playing.

// Names travel between browsers and land in the page: no markup characters.
const cleanName = (value, fallback = 'Player') => String(value || '').replace(/[<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18) || fallback;
const playMode = () => $('setup-form').elements.playMode.value;
const lobbyRole = () => $('setup-form').elements.multiplayerRole.value;

function cleanSettings(value) {
  const players = [3, 4, 5].includes(value?.players) ? value.players : 4;
  const rules = value?.rules ?? {};
  return {
    players,
    rules: {
      passCards: [0, 1, 2, 3].includes(rules.passCards) ? rules.passCards : 2,
      jackOfDiamonds: rules.jackOfDiamonds === true,
      endScore: [50, 100, 150].includes(rules.endScore) ? rules.endScore : 100,
    },
  };
}

// The deal button says when it loads the agent first.
const dealLabel = () => (agentReady() ? 'Deal' : 'Load agent & deal');

function configureSetup() {
  const multi = playMode() === 'multiplayer', joining = multi && lobbyRole() === 'guest';
  $('multiplayer-setup').hidden = !multi;
  $('join-code-row').hidden = !joining;
  $('join-code').required = joining;
  $('host-settings').hidden = joining;
  if (lobbyPhase === 'idle') $('start').textContent = !multi ? dealLabel() : joining ? 'Join multiplayer table' : 'Create multiplayer table';
  $('start-multiplayer').textContent = dealLabel();
  setSetupError();
}

function renderLobby({ hostName, names: friends = [], settings: table, status = '' }) {
  const rows = [[hostName, 'Host'], ...friends.map(n => [n, 'Friend'])];
  if (table) for (let seat = rows.length; seat < table.players; seat++) rows.push([AI_NAMES[seat - (friends.length + 1)], 'AI']);
  $('lobby-roster').innerHTML = rows.map(([n, kind]) => `<li><span>${escapeHtml(n)}</span><span>${kind}</span></li>`).join('');
  $('lobby-rules').textContent = table ? `${rulesSummary(table)} · computer players: the agent` : '';
  $('lobby-status').textContent = status;
}

function updateHostLobby() {
  if (role !== 'host' || lobbyPhase !== 'lobby') return;
  const hostName = cleanName($('player-name').value, 'Host'), friends = [...guests.values()], table = readSettings();
  const seats = table.players - 1 - friends.length;
  $('start-multiplayer').hidden = false;
  $('start-multiplayer').disabled = !guests.size || seats < 0;
  const status = seats < 0 ? `${plural(friends.length + 1, 'person', 'people')} are here, more than ${table.players} seats. Choose more players.`
    : guests.size ? `${plural(friends.length, 'friend')} at the table${seats ? `; the computer takes ${plural(seats, 'seat')}` : ''}. Deal when you are ready.`
      : 'Share the code with your friends. You can deal once one appears here.';
  renderLobby({ hostName, names: friends, settings: table, status });
  room.send({ type: 'lobby', code: room.code, hostName, names: friends, settings: table }).catch(() => {});
}

// The table as `seat` may see it.
function statePacket(seat) {
  const view = {};
  for (const key of ['players', 'rules', 'handSize', 'lead', 'direction', 'phase', 'current', 'trick', 'led', 'trickIndex', 'broken', 'taken',
    'queenTaker', 'jackTaker', 'played', 'lastTrick', 'dealer', 'dealIndex', 'done', 'scores']) view[key] = engine[key];
  Object.assign(view, {
    hands: engine.hands.map((hand, s) => (s === seat ? hand : [])),
    counts: engine.hands.map(hand => hand.length),
    received: engine.received.map((cards, s) => (s === seat ? cards : [])),
    legal: !engine.done && engine.phase === PLAY && engine.current === seat ? engine.legalCards() : [],
  });
  return {
    seat, code: room.code, names: playerNames, ai: [...aiSeats], settings, dealNumber, totals, scored, busy,
    readouts: readoutsAvailable() ? (agentReady() ? 'ready' : 'loading') : '',
    history: history.map(h => ({ ...h, passed: h.passed.map((cards, s) => (s === seat ? cards : [])), received: h.received.map((cards, s) => (s === seat ? cards : [])) })),
    deal: generation, decision: decisionId,
    passed: Array.from({ length: P() }, (_, s) => (engine.phase === PASS ? hasPassed(s) : true)),
    myPass: passChoice.get(seat) ?? engine.pending[seat],
    // Other seats' passes show as a count; the cards passed to them not at all.
    log: log.filter(ev => !(ev.kind === K_RECEIVE && ev.seat !== seat)).map(ev => (ev.kind === K_PASS && ev.seat !== seat ? { kind: K_PASS, seat: ev.seat, card: -1 } : ev)),
    engine: view,
  };
}

// Send each guest its view whenever it changed. Called after every render.
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

function resend(peer) { sent.delete(peer); sync(); }

function remotePass(message, peer) {
  const seat = peerSeat.get(peer);
  if (seat === undefined || !engine || engine.done || engine.phase !== PASS || hasPassed(seat)) { resend(peer); return; }
  const cards = Array.isArray(message.cards) ? message.cards : [];
  const valid = cards.length === passCount() && new Set(cards).size === cards.length && cards.every(c => Number.isInteger(c) && engine.hands[seat].includes(c));
  if (!valid) { resend(peer); return; }
  passChoice.set(seat, cards);
  render();
  void advance();
}

function remoteMove(message, peer) {
  const seat = peerSeat.get(peer);
  const open = seat !== undefined && engine && !engine.done && engine.phase === PLAY && engine.current === seat && message.id === decisionId;
  if (!open || !engine.legalCards().includes(message.card)) { if (seat !== undefined) resend(peer); return; }
  apply(message.card);
  render();
  void advance();
}

// The guest's readouts for its decision, with the cards it has chosen to pass so far.
async function adviseGuest(message, peer) {
  const seat = peerSeat.get(peer);
  if (seat === undefined || !engine || engine.done || !readoutsAvailable()) return;
  if (!agentReady()) { ensureAgent(); return; }
  const chosen = Array.isArray(message.selected) ? message.selected : [];
  const valid = engine.phase === PASS
    ? !hasPassed(seat) && chosen.length <= passCount() && new Set(chosen).size === chosen.length && chosen.every(c => Number.isInteger(c) && engine.hands[seat].includes(c))
    : engine.phase === PLAY && engine.current === seat && message.id === decisionId && !chosen.length;
  if (!valid) return;
  try {
    const advice = await assess(seat, chosen);
    if (advice) room?.send({ type: 'advice', request: message.request, advice }, peer).catch(() => {});
  } catch (error) { console.error('The guest’s readout failed.', error); }
}

function applyState({ revision: number, state }) {
  if (number <= applied) return;
  applied = number;
  const newDeal = state.deal !== hostDeal;
  settings = cleanSettings(state.settings);
  me = state.seat;
  playerNames = state.names.map(n => cleanName(n)); names = playerNames.map((n, s) => (s === me ? 'You' : n));
  aiSeats = new Set(state.ai);
  ({ dealNumber, totals, history, scored, busy } = state);
  hostDeal = state.deal; decisionId = state.decision; passedSeats = state.passed; myPass = state.myPass ?? []; log = state.log;
  const legal = state.engine.legal;
  engine = { ...state.engine, legalCards: () => [...legal] };
  if (newDeal) { selected = []; hint = null; notes = new Map(); $('result-dialog').hidden = true; }
  // The host's agent has just loaded: ask again.
  if (state.readouts === 'ready' && hostReadouts !== 'ready') askedKey = '';
  hostReadouts = ['loading', 'ready'].includes(state.readouts) ? state.readouts : '';
  if (engine.phase !== PASS || passedSeats[me]) selected = [];
  pending = false;
  lobbyPhase = 'playing';
  $('model-state').textContent = 'Hosted table';
  showGame();
  render();
  if (engine.done && scored && resultShown !== hostDeal) showResult();
}

function onMessage(message, peer) {
  if (!message || typeof message !== 'object') return;
  if (role === 'host') {
    if (message.type === 'join') {
      if (lobbyPhase !== 'lobby') { room.send({ type: 'rejected', message: 'That table has already started.' }, peer).catch(() => {}); return; }
      if (!guests.has(peer) && guests.size >= readSettings().players - 1) { room.send({ type: 'rejected', message: 'That table is full.' }, peer).catch(() => {}); return; }
      guests.set(peer, cleanName(message.name));
      updateHostLobby();
    } else if (message.type === 'pass') remotePass(message, peer);
    else if (message.type === 'move') remoteMove(message, peer);
    else if (message.type === 'advise') void adviseGuest(message, peer);
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
    renderLobby({ hostName: cleanName(message.hostName, 'Host'), names: (message.names ?? []).map(n => cleanName(n)), settings: cleanSettings(message.settings), status: 'Connected. Waiting for the host to deal.' });
  } else if (message.type === 'starting') {
    $('lobby-status').textContent = 'The host is dealing…';
  } else if (message.type === 'state') {
    applyState(message);
  } else if (message.type === 'advice') {
    if (message.request !== hintRequest || !askedKey || !Array.isArray(message.advice?.actions)) return;
    hint = { ...message.advice, key: askedKey };
    render();
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
  // The computer takes over the seat, so the game plays on.
  aiSeats.add(seat);
  if (engine) {
    log.push({ left: true, seat });
    render();
    void advance();
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
  savePlayerName(playerName);
  const code = hosting ? generateRoomCode() : normalizeRoomCode($('join-code').value);
  if (!validRoomCode(code)) { $('join-code').focus(); setSetupError('Enter the complete 8-character table code.'); return; }
  $('start').disabled = true;
  $('start').textContent = hosting ? 'Opening table…' : 'Finding table…';
  lockModes(true);
  role = hosting ? 'host' : 'guest'; lobbyPhase = 'connecting'; hostPeer = null;
  guests = new Map(); peerSeat = new Map(); seatPeer = new Map(); sent = new Map();
  revision = 0; applied = -1; resultShown = -1; hostDeal = -1;
  room = new PeerRoom({ game: 'hjarter', role, code, onMessage, onPeerJoin, onPeerLeave, onError: onNetworkError });
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
  const table = readSettings();
  if (guests.size > table.players - 1) { updateHostLobby(); return; }
  difficulty = Number($('difficulty').value);
  if (!agentReady()) {
    lobbyPhase = 'starting';
    room.send({ type: 'starting' }).catch(() => {});
    const loaded = await loadAgent();
    if (role !== 'host' || lobbyPhase !== 'starting') return;
    lobbyPhase = 'lobby';
    if (!loaded) { updateHostLobby(); return; }
    configureSetup();
    if (!guests.size) { updateHostLobby(); return; }
  }
  // Friends may have come or gone while the agent loaded.
  settings = readSettings();
  if (!guests.size || guests.size > P() - 1) { updateHostLobby(); return; }
  lobbyPhase = 'playing';
  room.send({ type: 'starting' }).catch(() => {});
  // You sit at seat 0, your friends to your left in the order they joined, then the computer.
  const friends = [...guests];
  me = 0;
  playerNames = [cleanName($('player-name').value, 'Host'), ...friends.map(([, friend]) => friend)];
  friends.forEach(([peer], index) => { peerSeat.set(peer, index + 1); seatPeer.set(index + 1, peer); });
  aiSeats = new Set();
  // The computer seats, after your friends', take the shared names in order.
  for (let seat = playerNames.length, index = 0; seat < P(); seat++, index++) { playerNames.push(AI_NAMES[index]); aiSeats.add(seat); }
  names = playerNames.map((n, s) => (s === me ? 'You' : n));
  newGame();
}

// Leave the multiplayer table (or the solo game) and return to the setup screen.
async function leaveTable(error = '') {
  const active = room;
  if (role === 'host' && active) await active.send({ type: 'closed', message: 'The host closed this table.' }).catch(() => {});
  generation++; engine = null; log = []; busy = false; pending = false; selected = []; passChoice = new Map();
  hint = null; askedKey = ''; passPlans = new Map(); notes = new Map(); hostReadouts = '';
  room = null; role = null; lobbyPhase = 'idle'; hostPeer = null; me = 0;
  guests = new Map(); peerSeat = new Map(); seatPeer = new Map(); sent = new Map();
  $('result-dialog').hidden = true; $('game').hidden = true; $('setup').hidden = false;
  $('lobby').hidden = true; $('start').hidden = false; $('start').disabled = false; $('start-multiplayer').hidden = true; $('live-badge').hidden = true;
  showModelState();
  lockModes(false); configureSetup();
  if (error) setSetupError(error);
  await active?.leave().catch(() => {});
}

$('setup-form').addEventListener('submit', event => {
  event.preventDefault();
  if (playMode() === 'solo') startSolo(); else void openLobby();
});
document.querySelectorAll('input[name="playMode"], input[name="multiplayerRole"]').forEach(input => input.addEventListener('change', configureSetup));
for (const id of ['players', 'pass-cards', 'jack', 'end-score']) $(id).addEventListener('change', updateHostLobby);
$('difficulty').addEventListener('input', () => {
  snapDifficulty($('difficulty'));
  difficulty = Number($('difficulty').value);
  $('difficulty-output').textContent = difficultyLabel(difficulty);
});
$('player-name').addEventListener('change', updateHostLobby);
$('join-code').addEventListener('input', () => { $('join-code').value = normalizeRoomCode($('join-code').value); });
$('start-multiplayer').addEventListener('click', startHosted);
$('leave-lobby').addEventListener('click', () => leaveTable());
$('copy-code').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('lobby-code').textContent.trim()); $('lobby-status').textContent = 'Code copied. Send it to your friends.'; }
  catch {
    const range = document.createRange(); range.selectNodeContents($('lobby-code'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
    $('lobby-status').textContent = 'Code selected — copy it and send it to your friends.';
  }
});
window.addEventListener('beforeunload', () => { room?.leave(); });
$('hand').addEventListener('click', event => {
  const button = event.target.closest('[data-card]');
  if (!button || button.disabled) return;
  const c = Number(button.dataset.card);
  if (canPass()) {
    selected = selected.includes(c) ? selected.filter(x => x !== c) : selected.length < passCount() ? [...selected, c] : selected;
    render();
  } else if (myTurn()) userPlay(c);
});
$('action-buttons').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.matches('[data-results]')) { $('result-dialog').hidden = false; render(); $(role === 'guest' ? 'review' : 'next-round').focus(); return; }
  if (button.matches('[data-clear]') && canPass()) { selected = []; render(); }
  else if (button.matches('[data-agent-pick]') && canPass() && currentHint()?.own) { selected = [...currentHint().own]; render(); }
  else if (button.matches('[data-pass]')) userPass();
});
$('autoplay').addEventListener('click', () => { setAutoplay(!autoplay()); selected = []; render(); void advance(); });
$('speed').addEventListener('input', () => { updateSpeed(); if (engine) render(); });
$('setup-hints').addEventListener('change', () => { $('hints').checked = $('setup-hints').checked; });
$('setup-values').addEventListener('change', () => { $('values').checked = $('setup-values').checked; });
for (const [id, mirror] of [['hints', 'setup-hints'], ['values', 'setup-values']]) {
  $(id).addEventListener('change', () => { $(mirror).checked = $(id).checked; if (engine) render(); });
}
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
$('next-round').addEventListener('click', () => { if (role === 'guest') return; if (gameOver()) newGame(); else startDeal(); });
$('new-table').addEventListener('click', () => {
  $('leave-copy').textContent = role === 'host' ? 'This closes the table for everyone. The score sheet will be cleared.'
    : role === 'guest' ? 'You will leave this multiplayer table; the computer takes over your seat.' : 'The current game and the score sheet will be cleared.';
  $('leave-dialog').showModal();
});
$('leave').addEventListener('click', () => { $('leave-dialog').close(); void leaveTable(); });
updateSpeed();
void describeAgent();
$('player-name').value = cleanName(savedPlayerName());
configureSetup();
