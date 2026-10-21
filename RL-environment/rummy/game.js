import { RummyEngine, ObservationWriter, candidateFeatures, name, RANKS, SUITS, DRAW, STOCK, TAKE, MELD_GROUP, MELD_RUN, LAYOFF_GROUP, LAYOFF_RUN, DISCARD, NO_CARD, EVENT_STOCK, EVENT_TAKE, EVENT_MELD, EVENT_LAYOFF } from './engine.js?v=mp-4';
import { RULES } from './rules-data.js';
import { RummyAgent } from './model-client.js?v=values-1';
import { PeerRoom, generateRoomCode, normalizeRoomCode, validRoomCode } from '../multiplayer.js';
import { difficultyLabel, snapDifficulty, temperatureFor } from '../difficulty.js';

const $ = id => document.getElementById(id);
const agent = new RummyAgent();
const AI_NAMES = ['Fern', 'Clover', 'Sage'];
let engine, writer, streams, decision, selected = [], sortBy = 'suit', busy = false, generation = 0, decisionId = 0;
let totals = [], history = [], round = 0, scored = false, failure = false;
// The round's events, oldest first; a guest holds only the latest, numbered from logStart.
let log = [], logStart = 0, lastMove = null;
// Local remarks on log entries, by entry number: whether the agent agreed with your move.
let notes = new Map();
let meldOwners = [], laidBy = [], lastActions = [], freshMeld = -1, freshDiscard = false;
// Table positions of the melds laid this turn, so cards added to them read as one lay.
let newMelds = new Set();
let difficulty = 50, players = 2, decks = 1;
// Seats: `me` is the local player. Everyone else is drawn around the table relative to it.
let me = 0, playerNames = [], aiSeats = new Set(), agentInfo = null;
// Multiplayer: the host deals, checks every move and runs the agent; guests mirror its state.
let role = null, room = null, lobbyPhase = 'idle', hostPeer = null, pending = false, resultShown = 0;
let guests = new Map(), peerSeat = new Map(), seatPeer = new Map(), hintPeers = new Set(), hinted = new Map(), sent = new Map();
let revision = 0, applied = -1, syncQueued = false;
// The flight of cards you just drew, from the stock or the pile into your hand.
let drawFx = null;
const DRAW_MS = 560, GLOW_MS = 2400;
// What the agent would do in your place: its policy over your current candidates.
let hint = null, hintRequest = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const autoplay = () => $('autoplay').getAttribute('aria-pressed') === 'true';
// Slider 0..100 → a pause of 0.9 s down to nothing between agent moves.
const moveDelay = () => Math.round(900 * Math.pow(1 - Number($('speed').value) / 100, 1.5));
const humanTurn = () => engine && !engine.done && engine.current === me && decision?.seat === me && !autoplay() && !busy && !failure && !pending;
const nameOf = seat => seat === me ? 'You' : playerNames[seat];
const agentSeat = seat => aiSeats.has(seat) || (seat === me && autoplay());
const lastMessage = () => log.length ? describe(log.at(-1)) : '';
const isMeld = move => move[0] === MELD_GROUP || move[0] === MELD_RUN;
const isLayoff = move => move[0] === LAYOFF_GROUP || move[0] === LAYOFF_RUN;
const sameCards = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
const selectedCards = () => selected.map(id => Number(id.split(':')[0]));
const legalMoves = () => decision?.actions ?? [];
const selectedDiscard = () => selected.length === 1 && legalMoves().find(a => a[0] === DISCARD && a[1] === selectedCards()[0]);
const selectedLayoff = position => selected.length === 1 && legalMoves().find(a => isLayoff(a) && a[2] === position && a[1] === selectedCards()[0]);
const cardAsset = card => `/resources/cards/${['clubs', 'diamonds', 'hearts', 'spades'][Math.floor(card / 13)]}-${RANKS[card % 13].toLowerCase()}.svg`;
const plural = (n, word) => `${n} ${n === 1 ? word : word + 's'}`;
const signed = n => (n > 0 ? '+' : '') + n;
const cardList = counts => counts.flatMap((n, c) => Array(n).fill(c));
const sameMove = (a, b) => a.every((v, i) => v === b[i]);
// Throwaway copies of the table and the token writer, to look one decision ahead.
const ownFields = source => structuredClone(Object.fromEntries(Object.entries(source).filter(([, v]) => typeof v !== 'function')));
const cloneEngine = source => Object.assign(Object.create(RummyEngine.prototype), ownFields(source));
const cloneWriter = (source, sim) => Object.assign(Object.create(ObservationWriter.prototype), ownFields({ ...source, engine: null }), { engine: sim });
// The meld a three-card meld becomes once `cards` are added to it in order.
const extendedMeld = (meld, cards) => cards.reduce((m, card) => RULES.extensions[m].find(([c]) => c === card)[1], meld);
const planMeld = plan => extendedMeld(plan[0][2], plan.slice(1).map(a => a[1]));
// Two plans agree when they leave the same meld (4-5-6 then 7, or 5-6-7 then 4), or are the same move.
const samePlan = (a, b) => isMeld(a[0]) && isMeld(b[0]) ? planMeld(a) === planMeld(b) : a.length === b.length && sameMove(a[0], b[0]);

// A meld of four or more goes down as three cards and then lay-offs onto them
// (4-5-6, then 7). Selecting all of them lays them in one go: the same moves,
// played back to back. `first` is the three-card meld to start from.
function layPlan(first, cards) {
  const rest = [...cards];
  for (const c of RULES.cards[first[2]]) {
    const at = rest.indexOf(c);
    if (at < 0) return null;
    rest.splice(at, 1);
  }
  if (!rest.length) return [first];
  const sim = cloneEngine(engine), plan = [first];
  sim.apply(first);
  const position = sim.table.length - 1;
  while (rest.length) {
    const next = sim.candidates().find(a => isLayoff(a) && a[2] === position && rest.includes(a[1]));
    if (!next) return null;
    sim.apply(next); plan.push(next); rest.splice(rest.indexOf(next[1]), 1);
  }
  return plan;
}

// The moves that lay the selected cards; the agent's own moves when they are its pick.
function selectedPlan() {
  const cards = selectedCards();
  if (cards.length < 3) return null;
  const advised = advisedPlan();
  if (advised && isMeld(advised[0]) && sameCards(RULES.cards[planMeld(advised)], cards)) return advised;
  for (const first of legalMoves().filter(isMeld)) {
    const plan = layPlan(first, cards);
    if (plan) return plan;
  }
  return null;
}

function prepareDecision() {
  if (engine.done) { decision = null; return; }
  const seat = engine.current;
  streams[seat].push(writer.observe(seat));
  decision = { id: ++decisionId, seat, actions: engine.candidates() };
}

function showGame() {
  $('setup').hidden = true; $('game').hidden = false; $('loading').hidden = true;
  $('autoplay').hidden = Boolean(role);
  $('speed-control').hidden = role === 'guest';
  $('live-badge').hidden = !role;
  $('live-badge').textContent = role === 'host' ? `Hosting · ${room.code}` : `Live table · ${room?.code}`;
}

function startRound() {
  generation++; round++; scored = false; selected = []; log = []; logStart = 0; lastMove = null; notes = new Map(); failure = false; busy = false;
  engine = new RummyEngine({ players, decks }); writer = new ObservationWriter(engine);
  streams = Array.from({ length: players }, () => []);
  meldOwners = []; laidBy = []; lastActions = Array(players).fill(''); freshMeld = -1; freshDiscard = false; newMelds = new Set();
  setAutoplay(false);
  $('game-error').hidden = true; $('result-dialog').hidden = true;
  showGame();
  prepareDecision(); render();
  window.scrollTo({ top: 0 });
  void advanceBots();
}

function describe(event) {
  const who = nameOf(event.actor);
  if (event.left) return `${playerNames[event.actor]} left the table; the agent plays their hand now.`;
  if (event.kind === EVENT_STOCK) return `${who} drew from the stock${event.actor === me && event.card !== NO_CARD ? `: ${name(event.card)}` : ''}.`;
  if (event.kind === EVENT_TAKE) return event.cards.length > 1
    ? `${who} dug ${name(event.card)} out of the discard pile, with ${plural(event.cards.length - 1, 'card')} above it.`
    : `${who} took ${name(event.card)} from the discard pile.`;
  if (event.kind === EVENT_MELD) return `${who} laid ${event.cards.map(name).join(' ')} (+${RULES.points[event.meld]}).`;
  if (event.kind === EVENT_LAYOFF) return `${who} added ${name(event.card)} to a meld.`;
  return `${who} discarded ${name(event.card)}.`;
}

// The few words under a seat that say what that player just did.
function shortAction(event) {
  if (event.kind === EVENT_STOCK) return 'Drew from stock';
  if (event.kind === EVENT_TAKE) return event.cards.length > 1 ? `Dug out ${name(event.card)} +${event.cards.length - 1}` : `Took ${name(event.card)}`;
  if (event.kind === EVENT_MELD) return `Laid ${event.cards.length} cards`;
  if (event.kind === EVENT_LAYOFF) return `Added ${name(event.card)}`;
  return `Discarded ${name(event.card)}`;
}

// Before your draw: where each card starts, and which cards you already hold.
const watchDraw = move => ({ sources: drawSources(move), held: new Set([...$('hand').querySelectorAll('[data-card]')].map(b => b.dataset.card)) });

function play(move) {
  const watched = engine.current === me && engine.phase === DRAW && watchDraw(move);
  const event = engine.apply(move);
  if (watched) drawFx = { ...watched, start: performance.now(), items: null };
  // A finished turn becomes a turn token in every other seat's stream.
  const turn = writer.record(event);
  if (turn) streams.forEach((stream, seat) => { if (seat !== event.actor) stream.push(turn[seat]); });
  if (event.kind === EVENT_MELD) { meldOwners.push(event.actor); laidBy.push({}); freshMeld = engine.table.length - 1; newMelds.add(freshMeld); }
  else if (event.kind === EVENT_LAYOFF) { laidBy[move[2]][event.card] = event.actor; freshMeld = move[2]; }
  else if (event.kind === EVENT_STOCK || event.kind === EVENT_TAKE) { freshMeld = -1; newMelds = new Set(); }
  freshDiscard = event.kind === 6;
  lastActions[event.actor] = event.kind === EVENT_LAYOFF && newMelds.has(move[2]) ? `Laid ${RULES.cards[engine.table[move[2]]].length} cards` : shortAction(event);
  lastMove = { n: log.length, actor: event.actor, move };
  log.push(event); selected = [];
  prepareDecision(); render();
  if (engine.done) finishRound();
}

// One move, or a plan of moves played back to back (a meld and the cards added to it).
function userPlay(moves) {
  if (!humanTurn() || !moves) return;
  const plan = typeof moves[0] === 'number' ? [moves] : moves;
  const suggested = advisedPlan();
  const note = suggested && (samePlan(suggested, plan) ? ' The agent agrees.' : ` The agent would: ${lowerFirst(describePlan(suggested))}.`);
  // The last entry these moves are about to add to the log.
  const entry = logStart + log.length + plan.length - 1;
  if (note) notes.set(entry, note);
  if (role === 'guest') {
    pending = true; selected = []; render();
    room.send({ type: 'move', id: decision.id, move: plan[0], moves: plan }, hostPeer).catch(() => {
      pending = false; notes.delete(entry);
      $('status').textContent = 'The move did not reach the host. Try again.';
    });
    return;
  }
  for (const move of plan) {
    const legal = humanTurn() && legalMoves().find(a => sameMove(a, move));
    if (!legal) break;
    play(legal);
  }
  void advanceBots();
}

const lowerFirst = text => text[0].toLowerCase() + text.slice(1);
// Two switches: the agent's move (its odds on every move) and the advantage.
const showOdds = () => $('hints').checked, showWorth = () => $('values').checked;
const wantsAdvice = () => showOdds() || showWorth();
const currentAdvice = () => wantsAdvice() && hint && decision && hint.id === decision.id ? hint : null;
const currentHint = () => showOdds() ? currentAdvice() : null;
const currentWorth = () => showWorth() && currentAdvice()?.after ? hint : null;

// Ask the agent about your decision: its policy (the readout reports temperature 1)
// and your advantage now and after each move. One request serves both switches.
// A guest's readout comes from the host, which runs the agent on the guest's own view.
async function requestHint() {
  if (role === 'guest') return;
  const request = ++hintRequest;
  if (!wantsAdvice() || !humanTurn()) { if (hint) { hint = null; render(); } return; }
  if (hint?.id === decision.id) { render(); return; }
  try {
    const advice = await assess(me, decision);
    if (request !== hintRequest || !advice) return;
    hint = advice;
    render();
  } catch (error) {
    console.error('The agent’s readout failed.', error);
  }
}

// When the agent's pick lays three cards, ask it about the decisions after:
// while its next move adds one of the seat's cards to that same meld, the lot is
// shown as one lay. Runs on copies, so the table and the streams stay as they are.
// Call it straight after an await that checked the decision is still current.
async function followUps(seat, move) {
  if (!isMeld(move)) return [];
  try {
    const sim = cloneEngine(engine), simWriter = cloneWriter(writer, sim), tokens = [...streams[seat]], chain = [];
    let event = sim.apply(move);
    const position = sim.table.length - 1;
    while (true) {
      simWriter.record(event);
      const actions = sim.candidates();
      if (!actions.some(a => isLayoff(a) && a[2] === position)) break;
      tokens.push(simWriter.observe(seat));
      const { argmax } = await agent.policy(tokens, candidateFeatures(sim, actions));
      const next = actions[argmax];
      if (!isLayoff(next) || next[2] !== position) break;
      chain.push(next);
      event = sim.apply(next);
    }
    return chain;
  } catch (error) {
    console.error('Looking past the meld failed.', error);
    return [];
  }
}

// ---- Advantage ----------------------------------------------------------
// The value head estimates a seat's points at the end of the round minus the
// other seats' average: its advantage over the table. Looking one decision
// ahead values every move. A draw, meld or lay-off leaves the seat deciding
// again, so its value is read at that next decision token, and a stock draw is
// averaged over every card the seat cannot see. A discard ends the turn, and
// what follows turns on the opponents' hidden hands, so the seat's next token
// is written as if it were deciding again straight away. That reads a few
// points high (it skips the opponents' turns), so the discards share one
// offset, set so that the moves' advantages average to the advantage now
// under the policy, as an advantage function's must. With little policy mass
// on discards the offset leans on its typical size. Going out scores exactly.
const OFFSET_PRIOR = 5, OFFSET_WEIGHT = 0.05;
// The value head learned from the states the agent's own play reaches: after a
// move it all but never makes, its reading is an extrapolation, shown greyed.
const RARE = 0.01;
const bestOf = (after, probabilities) => Math.max(...after.filter((_, i) => probabilities[i] >= RARE));
// The value head reads seats from the viewer's; zero-sum over the seats in play.
const ownValue = (values, n) => values[0] - values.slice(0, n).reduce((a, b) => a + b, 0) / n;

// Copies of each card type `seat` cannot see: in the stock or in hidden hands.
function unseenCopies(seat) {
  const unseen = Array(52).fill(engine.decks);
  engine.hands[seat].forEach((n, c) => { unseen[c] -= n; });
  engine.pile.forEach(c => { unseen[c]--; });
  for (let s = 0; s < engine.players; s++) {
    engine.placed[s].forEach((n, c) => { unseen[c] -= n; });
    if (s !== seat) engine.known[s].forEach((n, c) => { unseen[c] -= n; });
  }
  return unseen.map(n => Math.max(0, n));
}

// Each candidate's next decision token for `seat`, on copies of the table. A
// plan entry lists its tokens with weights, or holds the exact score of going out.
function lookAhead(seat, actions) {
  const rows = [], plan = [];
  const after = (move, card) => {
    const sim = cloneEngine(engine), simWriter = cloneWriter(writer, sim);
    if (card !== undefined) sim.stock[sim.stock.length - 1] = card;
    simWriter.record(sim.apply(move));
    if (sim.done) {
      const scores = sim.scores(), total = scores.reduce((a, b) => a + b, 0);
      return { exact: scores[seat] - (total - scores[seat]) / (sim.players - 1) };
    }
    rows.push(simWriter.observe(seat));
    return rows.length - 1;
  };
  for (const move of actions) {
    if (move[0] === STOCK) plan.push({ parts: unseenCopies(seat).flatMap((n, card) => n ? [[after(move, card), n]] : []) });
    else {
      const next = after(move);
      plan.push(typeof next === 'number' ? { parts: [[next, 1]], discard: move[0] === DISCARD } : next);
    }
  }
  return { rows, plan };
}

// The seat's advantage now and after each move, from one forward pass with the plan's tokens.
function advantages(policy, plan) {
  const n = engine.players, now = ownValue(policy.value, n);
  const raw = plan.map(entry => entry.exact ?? entry.parts.reduce((sum, [row, w]) => sum + w * ownValue(policy.after[row], n), 0) / entry.parts.reduce((sum, [, w]) => sum + w, 0));
  let mass = 0, gap = -now;
  plan.forEach((entry, i) => { gap += policy.probabilities[i] * raw[i]; if (entry.discard) mass += policy.probabilities[i]; });
  // Without discards (a draw) every after-state is a decision token: they miss
  // the value now only by the head's noise, a fraction of a point, and share it.
  const discards = plan.some(entry => entry.discard);
  const offset = discards ? (gap * mass + OFFSET_WEIGHT * OFFSET_PRIOR) / (mass * mass + OFFSET_WEIGHT) : gap;
  const after = raw.map((v, i) => (discards ? plan[i].discard : plan[i].exact === undefined) ? v - offset : v);
  return { now, after, best: bestOf(after, policy.probabilities) };
}

// Everything the readouts show for `seat`'s decision: policy, the meld it would grow, advantages.
async function assess(seat, asked) {
  const ahead = lookAhead(seat, asked.actions);
  const policy = await agent.policy(streams[seat], candidateFeatures(engine, asked.actions), ahead.rows);
  if (asked !== decision) return null;
  const chain = await followUps(seat, asked.actions[policy.argmax]);
  if (asked !== decision) return null;
  return { id: asked.id, probabilities: policy.probabilities, argmax: policy.argmax, chain, ...advantages(policy, ahead.plan) };
}

// The agent's next move, with the cards it would add to its new meld straight after.
const advisedPlan = () => {
  const advice = currentHint();
  return advice ? [decision.actions[advice.argmax], ...(advice.chain ?? [])] : null;
};

// The hand cards the agent's next move (or lay) would play.
function advisedCards() {
  const plan = advisedPlan();
  if (!plan) return new Set();
  const [kind, card] = plan[0];
  if (isMeld(plan[0])) return new Set(RULES.cards[planMeld(plan)]);
  return new Set(kind === STOCK || kind === TAKE ? [] : [card]);
}

// What the agent's pick does with the hand cards it plays, as a badge word.
function pickVerb() {
  const plan = advisedPlan();
  return !plan ? '' : isMeld(plan[0]) ? 'Lay' : isLayoff(plan[0]) ? 'Add' : 'Discard';
}

const describePlan = plan => plan.length > 1 ? `Lay ${RULES.cards[planMeld(plan)].map(name).join(' ')}` : describeMove(plan[0]);

function describeMove([kind, card, meld]) {
  if (kind === STOCK) return 'Draw from the stock';
  if (kind === TAKE) return meld ? `Dig out the ${name(card)} (with ${plural(meld, 'card')} above)` : `Take the ${name(card)}`;
  if (kind === MELD_GROUP || kind === MELD_RUN) return `Lay ${RULES.cards[meld].map(name).join(' ')}`;
  if (kind === LAYOFF_GROUP || kind === LAYOFF_RUN) return `Add the ${name(card)} to ${meldOwners[meld] === me ? 'your' : `${playerNames[meldOwners[meld]]}’s`} ${RULES.kinds[engine.table[meld]] ? 'run' : 'set'}`;
  return `Discard the ${name(card)}`;
}

// A badge naming the move, on the thing the move uses: with the agent's move
// on, its odds (the agent's own pick is the highlighted one, its next move);
// with the advantage on, your advantage once the move is made.
function marks(index, verb) {
  const advice = currentAdvice();
  if (!advice || index < 0) return '';
  const odds = Boolean(currentHint()), worth = Boolean(currentWorth()), pick = odds && advice.argmax === index;
  // Without the advantage, moves the agent all but rules out stay unmarked, to keep the table readable.
  if (!worth && (!odds || (!pick && advice.probabilities[index] < 0.005))) return '';
  const value = worth ? advice.after[index] : 0;
  const rare = advice.probabilities[index] < RARE;
  const title = [pick ? 'The agent’s next move' : '', worth ? `Your advantage after this move: ${points(value, 1)} (now ${points(advice.now, 1)})` : '', worth && rare ? 'The agent almost never plays this, so this value is a rough extrapolation' : ''].filter(Boolean).join('. ');
  return `<span class="prob-badge ${pick ? 'is-pick' : ''}" title="${title}"><span class="badge-verb">${verb}</span>${odds ? `<b>${percent(advice.probabilities[index])}</b>` : ''}${worth ? `<i class="badge-value ${rare ? 'is-rare' : value >= advice.best - 0.5 ? 'is-best' : ''}">${points(value)}</i>` : ''}</span>`;
}
const moveIndex = test => legalMoves().findIndex(test);
const percent = p => `${Math.round(p * 100)}%`;
// Points with their sign, a true minus, and `digits` decimals.
const points = (v, digits = 0) => {
  const text = Math.abs(v).toFixed(digits);
  return Number(text) === 0 ? text : `${v < 0 ? '−' : '+'}${text}`;
};
const adviceText = advice => `The agent would: ${lowerFirst(describePlan(advisedPlan()))} · ${percent(advice.probabilities[advice.argmax])}`;

async function advanceBots() {
  if (role === 'guest' || busy || failure || !engine || engine.done) return;
  const version = generation;
  busy = true;
  try {
    while (version === generation && !engine.done && agentSeat(engine.current)) {
      render();
      const acting = engine.current;
      // Auto-play plays your hand with the agent's best move; the difficulty is for opponents.
      const temperature = acting === me ? 0 : temperatureFor(difficulty);
      const [chosen] = await Promise.all([
        agent.choose(streams[acting], candidateFeatures(engine, decision.actions), temperature),
        pause(moveDelay()),
      ]);
      if (version !== generation) return;
      // Turning off auto-play during inference gives control back before the move.
      if (!agentSeat(acting)) break;
      play(decision.actions[chosen]);
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

// Where each drawn card starts: the stock, or its own place in the discard pile.
function drawSources([kind, , above]) {
  if (kind === STOCK) return { stock: $('stock-stack').getBoundingClientRect() };
  const pile = {};
  for (let depth = 0; depth <= above; depth++) {
    const card = engine.pile[engine.pile.length - 1 - depth], button = $('discard-spread').querySelector(`[data-above="${depth}"]`);
    if (button) (pile[card] ??= []).push(button.getBoundingClientRect());
  }
  return { pile };
}

// Fly freshly drawn cards from where they came from to their place in the hand.
// The hand is rebuilt on every render, so each rebuild resumes the flight.
function landDrawnCards() {
  if (!drawFx) return;
  const elapsed = performance.now() - drawFx.start;
  if (elapsed > GLOW_MS) { drawFx = null; return; }
  const hand = $('hand');
  if (!drawFx.items) {
    const fresh = [...hand.querySelectorAll('[data-card]')].filter(b => !drawFx.held.has(b.dataset.card));
    drawFx.items = fresh.map((button, i) => {
      const card = Number(button.dataset.card.split(':')[0]);
      const from = drawFx.sources.stock ?? drawFx.sources.pile[card]?.shift();
      const to = button.getBoundingClientRect();
      if (!from || !to.width) return { id: button.dataset.card };
      return {
        id: button.dataset.card, delay: i * 80, scale: from.width / to.width,
        dx: from.left + from.width / 2 - (to.left + to.width / 2), dy: from.top + from.height / 2 - (to.top + to.height / 2),
      };
    });
  }
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const item of drawFx.items) {
    const button = hand.querySelector(`[data-card="${item.id}"]`);
    if (!button) continue;
    button.classList.add('is-new');
    button.style.setProperty('--since', `${-elapsed}ms`);
    if (still || item.dx === undefined || elapsed > item.delay + DRAW_MS) continue;
    const flight = button.animate([
      { transform: `translate(${item.dx}px, ${item.dy}px) scale(${item.scale})`, zIndex: 6 },
      { transform: 'translate(0, 0) scale(1)', zIndex: 6 },
    ], { duration: DRAW_MS, delay: item.delay, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' });
    flight.currentTime = elapsed;
  }
}

function cardImage(card, extra = '') {
  return `<img class="table-card ${extra}" src="${cardAsset(card)}" alt="${name(card)}" width="90" height="126" draggable="false" />`;
}

const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// Seats in play order starting after yours, so the table turns to put you at the bottom.
const offsetOf = seat => (seat - me + players) % players;
const seatAt = offset => (me + offset) % players;

function seatTag(seat, current) {
  if (current && busy && aiSeats.has(seat)) return 'thinking…';
  if (aiSeats.has(seat)) return 'AI';
  if (current) return 'playing…';
  return seat === 0 ? 'Host' : 'Friend';
}

function renderSeats() {
  $('felt').className = `table-felt rummy-felt players-${players}`;
  $('seats').innerHTML = Array.from({ length: players - 1 }, (_, i) => {
    const seat = seatAt(i + 1), who = escapeHtml(playerNames[seat]), count = engine.count(seat), current = !engine.done && engine.current === seat;
    const hand = engine.done
      ? `<div class="seat-reveal" aria-label="${who}'s remaining cards">${cardList(engine.hands[seat]).map(c => cardImage(c)).join('')}</div>`
      : `<div class="opponent-hand" aria-hidden="true">${'<span class="opponent-card"></span>'.repeat(Math.min(count, 10))}</div>`;
    // Cards an opponent took from the discard pile and still holds are public.
    const known = engine.done ? [] : cardList(engine.known[seat]);
    return `<div class="seat seat-player-${i + 1} ${current ? 'is-current' : ''}" aria-label="${who}, ${plural(count, 'card')}">
      <div class="seat-name"><span>${who}</span><span>${seatTag(seat, current)}</span></div>
      ${hand}
      <div class="seat-stats"><span>${plural(count, 'card')}</span><span>+${engine.points[seat]}</span><span>Σ ${totals[seat] || 0}</span></div>
      <div class="seat-notes">${known.length ? `<span class="seat-known">Holds ${known.map(c => `<b class="${Math.floor(c / 13) % 3 ? 'is-red' : ''}">${name(c)}</b>`).join(' ')}</span>` : ''}${lastActions[seat] ? `<span class="seat-action">${lastActions[seat]}</span>` : ''}</div>
    </div>`;
  }).join('');
}

function renderPiles(interactive) {
  const canDraw = interactive && engine.phase === DRAW;
  const stockLayers = Math.min(3, Math.ceil(engine.stock.length / 12));
  $('stock-stack').innerHTML = engine.stock.length
    ? Array.from({ length: stockLayers }, (_, i) => `<span class="pile-card card-back" style="--layer:${stockLayers - 1 - i}"></span>`).join('')
    : '<span class="pile-empty">Empty</span>';
  if (canDraw) $('stock-stack').insertAdjacentHTML('beforeend', marks(moveIndex(a => a[0] === STOCK), 'Draw'));
  $('stock-count').textContent = engine.stock.length;
  $('draw-stock').disabled = !canDraw;
  $('draw-stock').classList.toggle('is-ready', canDraw);
  $('draw-stock').setAttribute('aria-label', `Draw from the stock, ${plural(engine.stock.length, 'card')} left`);
  // The discard pile, bottom to top: buried cards show only their corner index.
  const takeable = new Set(canDraw ? legalMoves().filter(a => a[0] === TAKE).map(a => a[2]) : []);
  const pile = engine.pile, top = pile.length - 1;
  $('discard-spread').innerHTML = pile.length ? pile.map((card, i) => {
    const above = top - i, open = takeable.has(above);
    const label = above ? `Take ${name(card)} and the ${plural(above, 'card')} above it` : `Take ${name(card)}`;
    return `<button class="spread-card ${open ? 'is-takeable' : ''} ${above === 0 && freshDiscard ? 'is-fresh' : ''}" type="button" data-above="${above}" ${open ? '' : 'disabled'} aria-label="${open ? label : name(card)}"><img src="${cardAsset(card)}" alt="" draggable="false" />${open ? marks(moveIndex(a => a[0] === TAKE && a[2] === above), 'Take') : ''}</button>`;
  }).join('') : '<span class="pile-empty spread-empty">Empty</span>';
  $('discard-area').classList.toggle('is-ready', canDraw && takeable.size > 0);
  $('pile-count').textContent = pile.length;
  $('pile-hint').textContent = canDraw && takeable.size > 1 ? ' · pick any lit card' : '';
  fitPile();
}

// Tighten the stagger until the whole pile fits beside the stock.
function fitPile() {
  const area = $('discard-area'), cards = area.querySelectorAll('.spread-card');
  if (cards.length < 2) return;
  const width = cards[0].offsetWidth;
  const room = area.parentElement.clientWidth - $('draw-stock').offsetWidth - 30;
  const strip = Math.max(7, Math.min(width * 0.27, (room - width) / (cards.length - 1)));
  area.style.setProperty('--strip', `${strip}px`);
}

// Every player's melds sit in their own zone, beside their seat; yours by your hand.
function renderMelds(interactive) {
  const zones = Array.from({ length: players }, () => []);
  const initial = seat => escapeHtml(nameOf(seat)[0]);
  engine.table.forEach((m, i) => {
    const owner = meldOwners[i], target = interactive && selectedLayoff(i), cards = RULES.cards[m];
    // A card laid off by someone else carries their initial: its points are theirs.
    const faces = cards.map(c => {
      const by = laidBy[i][c];
      const mini = `<span class="mini-card ${Math.floor(c / 13) % 3 ? 'is-red' : ''}" aria-hidden="true">${RANKS[c % 13]}<br />${SUITS[Math.floor(c / 13)]}</span>`;
      return `<span class="meld-card">${cardImage(c)}${mini}${by !== undefined && by !== owner ? `<i class="laid-by" title="Laid off by ${escapeHtml(nameOf(by))}">${initial(by)}</i>` : ''}</span>`;
    }).join('');
    // The agent's likeliest lay-off onto this meld, if any.
    const layoffs = legalMoves().map((a, index) => ({ a, index })).filter(({ a }) => isLayoff(a) && a[2] === i);
    const best = currentAdvice() && layoffs.sort((x, y) => hint.probabilities[y.index] - hint.probabilities[x.index])[0];
    zones[offsetOf(owner)].push(`<button class="rummy-meld ${target ? 'is-target' : ''} ${i === freshMeld ? 'is-fresh' : ''}" type="button" data-meld="${i}" ${target ? '' : 'disabled'}
      aria-label="${RULES.kinds[m] ? 'Run' : 'Set'} by ${escapeHtml(nameOf(owner))}: ${cards.map(name).join(', ')}${target ? '. Add the selected card here' : ''}"><span class="meld-cards">${faces}</span>${best ? marks(best.index, `Add ${name(best.a[1])}`) : ''}</button>`);
  });
  $('melds').innerHTML = zones.map((melds, offset) => {
    const seat = seatAt(offset), who = escapeHtml(nameOf(seat));
    return `<section class="meld-zone zone-${offset} ${!engine.done && engine.current === seat ? 'is-current' : ''} ${melds.length ? '' : 'is-empty'}" aria-label="${offset ? `${who}’s` : 'Your'} melds">
    <span class="zone-label">${who} · +${engine.points[seat]}</span>
    <div class="zone-melds">${melds.join('')}</div>
  </section>`;
  }).join('');
}

// Shrink a zone's meld cards step by step until its melds fit; each zone on its own.
// The last step trades the pictures for their corner index alone, which stays readable.
function fitMelds() {
  const zones = [...$('melds').querySelectorAll('.meld-zone')];
  // Probability badges may overhang a meld; they must not shrink it.
  for (const zone of zones) { zone.classList.remove('is-overflowing'); zone.classList.add('is-fitting'); }
  shareMeldRows(zones);
  for (const zone of zones) {
    const melds = zone.querySelector('.zone-melds');
    const fits = () => melds.scrollHeight <= melds.clientHeight + 1 && melds.scrollWidth <= melds.clientWidth + 1;
    for (const density of ['', 'compact', 'tight', 'chips']) {
      zone.dataset.density = density;
      if (fits()) break;
    }
    // Never hide a meld: if even the smallest cards do not fit, let the zone scroll.
    zone.classList.toggle('is-overflowing', !fits());
    zone.classList.remove('is-fitting');
  }
}

// On narrow screens the opponents' melds share one row and yours fill another.
// Each row gets at least the height its melds need as chips, so none is cut
// off, and the rest of the felt is split by what each row needs at full size.
// If even the chips do not fit, the felt grows and the panel scrolls.
function shareMeldRows(zones) {
  const felt = $('felt');
  felt.style.removeProperty('grid-template-rows');
  felt.style.removeProperty('min-height');
  if (!matchMedia('(max-width: 760px)').matches) return;
  const need = (zone, density) => {
    if (zone.classList.contains('is-empty')) return 0;
    zone.dataset.density = density;
    const melds = zone.querySelector('.zone-melds'), style = getComputedStyle(zone), label = zone.querySelector('.zone-label');
    return melds.scrollHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + (label.offsetHeight ? label.offsetHeight + parseFloat(style.rowGap) : 0);
  };
  const row = list => {
    const full = Math.max(0, ...list.map(zone => need(zone, ''))), least = Math.max(0, ...list.map(zone => need(zone, 'chips')));
    return full ? `minmax(${Math.ceil(least)}px, ${Math.round(full)}fr)` : 'auto';
  };
  const [own, ...theirs] = zones;
  felt.style.gridTemplateRows = `auto ${row(theirs)} auto ${row([own])}`;
  if (felt.scrollHeight > felt.clientHeight + 1) felt.style.minHeight = `${felt.scrollHeight}px`;
}

function renderHand(interactive) {
  const label = $('human-label');
  const penalty = engine.penalties()[me];
  const worth = interactive && currentWorth();
  label.innerHTML = `<span>You</span><span>${plural(engine.count(me), 'card')}</span><span>+${engine.points[me]} laid</span><span>${penalty ? `−${penalty}` : 0} in hand</span><span>Σ ${totals[me] || 0}</span>${worth ? `<span class="advantage-now" title="The agent’s estimate of your points at the end of the round, minus the other players’ average">Advantage ${points(worth.now, 1)}</span>` : ''}`;
  label.classList.toggle('is-current', !engine.done && engine.current === me);
  const cards = engine.hands[me].flatMap((n, c) => Array.from({ length: n }, (_, copy) => ({ card: c, id: `${c}:${copy}` })));
  if (sortBy === 'rank') cards.sort((a, b) => a.card % 13 - b.card % 13 || a.card - b.card);
  // Preserve focus when selecting a card with a keyboard and re-rendering the hand.
  const focused = document.activeElement?.dataset?.card;
  const canSelect = interactive && engine.phase !== DRAW;
  const obligated = engine.current === me ? engine.obligation : NO_CARD;
  const kept = engine.current === me && !engine.done ? engine.kept : NO_CARD;
  // On your play: the lay-offs you can make now. Otherwise: the cards that would extend a table meld.
  const layable = new Set(canSelect ? legalMoves().filter(isLayoff).map(a => a[1]) : engine.done ? [] : engine.hands[me].flatMap((n, c) => n && engine.layable[c] ? [c] : []));
  // The cards the agent would play next glow, so its pick shows where the card comes from too.
  const advised = canSelect ? advisedCards() : new Set(), verb = pickVerb();
  let named = false;
  $('hand').classList.toggle('is-waiting', !canSelect && !engine.done);
  $('hand').innerHTML = cards.map(({ card, id }) => {
    const chosen = selected.includes(id), must = card === obligated && id.endsWith(':0'), held = card === kept && id.endsWith(':0');
    const badge = must ? '<span class="must-badge">Use me</span>' : held ? '<span class="must-badge is-kept">Kept</span>' : '';
    // This card can go onto a meld already on the table.
    const fits = layable.has(card) && id.endsWith(':0') ? '<span class="layoff-mark" title="Can be added to a meld on the table">+</span>' : '';
    const glow = advised.has(card) && id.endsWith(':0');
    // The first card the agent would play says what it would do with it; every other card, its discard.
    const odds = !canSelect || !id.endsWith(':0') ? '' : glow && !named ? (named = true, marks(currentHint().argmax, verb))
      : marks(moveIndex(a => a[0] === DISCARD && a[1] === card), 'Discard');
    return `<button type="button" class="rummy-card ${chosen ? 'is-selected' : ''} ${must ? 'is-obligated' : ''} ${glow ? 'is-advised' : ''}" data-card="${id}" aria-label="${name(card)}${must ? ', must be used this turn' : held ? ', taken from the pile this turn: cannot be discarded' : ''}${fits ? ', can be added to a meld on the table' : ''}" aria-pressed="${chosen}" ${canSelect ? '' : 'disabled'}><img src="${cardAsset(card)}" alt="" draggable="false" />${badge}${fits}${odds}</button>`;
  }).join('');
  if (focused) $('hand').querySelector(`[data-card="${focused}"]`)?.focus({ preventScroll: true });
  fitHand();
  landDrawnCards();
}

// Fan the hand as wide as the room allows (up to the usual overlap), so each
// card shows enough of itself for its badges; tighten it when the hand is long.
function fitHand() {
  const hand = $('hand'), cards = hand.querySelectorAll('.rummy-card');
  hand.style.removeProperty('--peek');
  if (cards.length < 2) return;
  const width = cards[0].offsetWidth, widest = parseFloat(getComputedStyle(hand).getPropertyValue('--peek-max')) || 0.68;
  const peek = Math.max(0.3, Math.min(widest, (hand.clientWidth - 8 - width) / ((cards.length - 1) * width)));
  hand.style.setProperty('--peek', peek.toFixed(3));
  // Keep the word on a badge only if the card's showing strip can hold it. The
  // agent's pick sits above its card, clear of the others, so it keeps its word.
  hand.classList.remove('is-narrow');
  const badges = [...hand.querySelectorAll('.rummy-card .prob-badge:not(.is-pick)')];
  hand.classList.toggle('is-narrow', badges.some(badge => badge.offsetWidth + 3 > peek * width));
}

function renderActions(interactive) {
  const meld = interactive && selectedPlan(), discard = interactive && selectedDiscard();
  const obligated = engine.current === me && engine.obligation !== NO_CARD;
  $('sort').textContent = `Sort by ${sortBy === 'suit' ? 'rank' : 'suit'}`;
  $('clear').disabled = !selected.length || !interactive;
  $('lay').disabled = !meld;
  $('discard').disabled = !discard;
  $('lay').classList.toggle('is-default', Boolean(meld));
  $('discard').classList.toggle('is-default', Boolean(discard) && !meld);
  let help = 'Select cards for a meld, or one card to discard.';
  if (engine.done) help = 'Round complete.';
  else if (failure) help = role === 'guest' ? 'The host’s agent stopped. Waiting for the host to retry.' : 'The agent stopped. Retry to continue.';
  else if (pending) help = 'Sending your move to the host…';
  else if (!interactive) help = engine.current === me && autoplay() ? 'The agent is playing your hand.' : `${playerNames[engine.current]} is playing. Your cards stay private.`;
  else if (engine.phase === DRAW) help = 'Your turn: draw from the stock, or take a lit card from the discard pile.';
  else if (selected.length) {
    const layoff = selected.length === 1 && legalMoves().some(a => isLayoff(a) && a[1] === selectedCards()[0]);
    if (meld) help = `${RULES.kinds[planMeld(meld)] ? 'Run' : 'Set'} worth ${RULES.points[planMeld(meld)]} points. Ready to lay.`;
    else if (layoff) help = 'Tap a highlighted meld to add this card' + (obligated ? '.' : ', or discard it.');
    else if (discard) help = `Discard ${name(selectedCards()[0])} to end your turn.`;
    else if (selected.length === 1 && selectedCards()[0] === engine.kept) help = `You took the ${name(engine.kept)} from the pile this turn: meld it or keep it, but it can’t go straight back.`;
    else if (selected.length > 3 && !obligated && RULES.cards.some(cards => sameCards(cards, selectedCards()))) help = 'Laying all of these would leave you no card to discard. Keep one back.';
    else help = obligated ? `That doesn’t use the ${name(engine.obligation)}. Pick a meld or lay-off with it.` : 'That is not a meld yet: three of a rank, or three in a row of one suit.';
  } else if (obligated) help = `Use the ${name(engine.obligation)} you dug out in a meld or lay-off (or extend a run up to it) before you discard.`;
  $('selection-help').textContent = help;
  const melds = interactive && engine.phase !== DRAW ? legalMoves().filter(isMeld) : [];
  // When the agent would lay three and add to them straight away, its pick shows the whole meld.
  const advised = advisedPlan(), longer = advised && isMeld(advised[0]) && advised.length > 1 ? advised : null;
  $('available').innerHTML = engine.done && $('result-dialog').hidden
    ? '<button class="game-button is-default" type="button" data-results>Show scores &amp; next round</button>'
    : melds.length ? `<span>Melds in your hand:</span>${melds.map(m => {
      const shown = longer && sameMove(longer[0], m) ? planMeld(longer) : m[2], cards = RULES.cards[shown];
      return `<button class="game-button meld-suggestion" type="button" data-suggestion="${cards.join(',')}">${cards.map(c => `<span class="${Math.floor(c / 13) % 3 ? 'is-red' : ''}">${name(c)}</span>`).join(' ')}<small>+${RULES.points[shown]}</small>${marks(moveIndex(a => sameMove(a, m)), 'Lay')}</button>`;
    }).join('')}` : '';
}

function renderScores() {
  const head = `<thead><tr><th>Rnd</th>${playerNames.map((_, seat) => `<th>${escapeHtml(nameOf(seat))}</th>`).join('')}</tr></thead>`;
  const cell = v => `<td class="${v > 0 ? 'is-hit' : v < 0 ? 'is-miss' : ''}">${signed(v)}</td>`;
  const rows = history.map(h => `<tr><td>${h.round}</td>${h.scores.map(cell).join('')}</tr>`).join('');
  const live = engine && !scored ? `<tr class="is-active"><td>${round}</td>${engine.points.map(p => `<td>+${p} laid</td>`).join('')}</tr>` : '';
  const total = `<tr class="score-total-row"><td>Total</td>${totals.map(t => `<td>${t}</td>`).join('')}</tr>`;
  $('score-table').innerHTML = `${head}<tbody>${rows}${live}${total}</tbody>`;
  $('score-caption').textContent = `Round ${round}`;
}

function render() {
  if (!engine) return;
  const interactive = humanTurn();
  $('plaque').innerHTML = `<strong>Round ${round}</strong>Turn ${engine.turns + 1} · ${plural(decks, 'deck')}`;
  $('turn-count').textContent = `Turn ${engine.turns + 1}`;
  $('agent-label').textContent = agentInfo ? `Self-play agent · checkpoint ${agentInfo.run} / ${agentInfo.iteration.toLocaleString()}${role === 'guest' ? ', run by the host' : ''}.` : '';
  const latest = lastMessage();
  let status;
  if (engine.done) status = `${latest} Round complete.`;
  else if (failure) status = role === 'guest' ? 'The host’s agent stopped. Waiting for the host to retry.' : 'The agent stopped. Retry to continue this round.';
  else if (pending) status = 'Sending your move to the host…';
  else if (engine.current !== me || autoplay()) {
    const who = playerNames[engine.current];
    const doing = engine.current === me ? 'The agent is playing for you' : aiSeats.has(engine.current) ? `${who} is thinking` : `Waiting for ${who}`;
    status = `${doing}…${latest ? ` ${latest}` : ''}`;
  } else if (engine.phase === DRAW) status = `Your turn.${latest ? ` ${latest}` : ''}`;
  else if (engine.obligation !== NO_CARD) status = `Use the ${name(engine.obligation)} before you discard.`;
  else status = 'Lay what you can, then discard one card.';
  const advice = interactive && currentHint();
  if (advice) status = adviceText(advice);
  else if (interactive && wantsAdvice() && !currentAdvice()) status += ' The agent is considering…';
  $('status').textContent = status;
  $('status').classList.toggle('is-advice', Boolean(advice));
  renderSeats();
  renderPiles(interactive);
  renderMelds(interactive);
  renderHand(interactive);
  renderActions(interactive);
  // After everything else, so the melds fit the room the hand and controls leave.
  fitMelds();
  renderScores();
  $('activity').innerHTML = log.slice(-80).map((event, i) => {
    const n = logStart + log.length - Math.min(log.length, 80) + i;
    return `<li>${escapeHtml(describe(event) + (notes.get(n) ?? ''))}</li>`;
  }).reverse().join('');
  sync();
}

function finishRound() {
  if (scored) return;
  scored = true;
  const scores = engine.scores();
  totals = totals.map((total, i) => total + scores[i]);
  history.push({ round, scores });
  showResult();
}

function showResult() {
  resultShown = round;
  const scores = engine.scores(), penalties = engine.penalties();
  $('result-kicker').textContent = `Round ${round} complete`;
  $('result-title').textContent = engine.winner === null ? 'The round is closed.' : engine.winner === me ? 'You went out!' : `${playerNames[engine.winner]} went out.`;
  $('result-description').textContent = engine.winner === null
    ? (engine.truncated ? 'The 200-turn limit was reached.' : 'The stock ran out.') + ' Cards left in hand count against their owner.'
    : 'Everything laid on the table scores; cards left in hand count against their owner.';
  $('scores').innerHTML = `<table class="score-table"><thead><tr><th>Player</th><th>Laid</th><th>In hand</th><th>Round</th><th>Total</th></tr></thead><tbody>${scores.map((score, seat) => `<tr class="${seat === engine.winner ? 'is-winner' : ''}"><td>${escapeHtml(nameOf(seat))}</td><td>+${engine.points[seat]}</td><td>${penalties[seat] ? `−${penalties[seat]}` : 0}</td><td class="${score > 0 ? 'is-hit' : score < 0 ? 'is-miss' : ''}">${signed(score)}</td><td>${totals[seat]}</td></tr>`).join('')}</tbody></table>`;
  $('next-round').disabled = role === 'guest';
  $('next-round').textContent = role === 'guest' ? 'The host deals next' : 'Deal next round';
  $('result-dialog').hidden = false;
  render();
  $(role === 'guest' ? 'review' : 'next-round').focus({ preventScroll: true });
}

function setAutoplay(on) {
  $('autoplay').setAttribute('aria-pressed', String(on));
  $('autoplay').textContent = on ? 'Stop auto-play' : 'Auto-play my hand';
}

function updateSpeed() {
  const delay = moveDelay();
  $('speed-output').textContent = delay ? `${(delay / 1000).toFixed(2)} s` : 'instant';
}

// ---- Multiplayer -------------------------------------------------------
// The host owns the engine, every seat's token stream and the agent. Each guest
// gets the table as their seat sees it: their own hand, public cards, and the
// legal moves only when it is their turn. Guests send moves; the host checks
// them against the legal list before playing them.

const cleanName = (value, fallback = 'Player') => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 18) || fallback;
const playMode = () => $('setup-form').elements.playMode.value;
const lobbyRole = () => $('setup-form').elements.multiplayerRole.value;
const setSetupError = (message = '') => { $('setup-error').hidden = !message; $('setup-error').textContent = message; };

function setOpponentOptions(mode) {
  const previous = Number($('opponents').value);
  const max = mode === 'multiplayer' ? Math.max(0, 3 - guests.size) : 3, min = mode === 'multiplayer' ? 0 : 1;
  const chosen = Math.max(min, Math.min(max, Number.isFinite(previous) ? previous : 1));
  const noun = mode === 'multiplayer' ? 'AI opponent' : 'opponent';
  $('opponents').innerHTML = Array.from({ length: max - min + 1 }, (_, i) => min + i)
    .map(n => `<option value="${n}" ${n === chosen ? 'selected' : ''}>${n} ${noun}${n === 1 ? '' : 's'}</option>`).join('');
}

function configureSetup() {
  const multi = playMode() === 'multiplayer', joining = multi && lobbyRole() === 'guest';
  $('multiplayer-setup').hidden = !multi;
  $('join-code-row').hidden = !joining;
  $('join-code').required = joining;
  $('host-settings').hidden = joining;
  $('opponents-label').textContent = multi ? 'AI opponents' : 'Opponents';
  if (lobbyPhase === 'idle') {
    setOpponentOptions(multi ? 'multiplayer' : 'solo');
    $('start').textContent = !multi ? 'Load agent & start game' : joining ? 'Join multiplayer table' : 'Create multiplayer table';
  }
  setSetupError();
}

function renderLobby({ hostName, names = [], ai = 0, status = '' }) {
  const rows = [[hostName, 'Host'], ...names.map(n => [n, 'Friend']), ...AI_NAMES.slice(0, ai).map(n => [n, 'AI'])];
  $('lobby-roster').innerHTML = rows.map(([n, kind]) => `<li><span>${escapeHtml(n)}</span><span>${kind}</span></li>`).join('');
  $('lobby-status').textContent = status;
}

function updateHostLobby() {
  if (role !== 'host' || lobbyPhase !== 'lobby') return;
  setOpponentOptions('multiplayer');
  const ai = Number($('opponents').value), seated = 1 + guests.size + ai;
  $('start-multiplayer').hidden = false;
  $('start-multiplayer').disabled = !guests.size || seated > 4;
  renderLobby({
    hostName: cleanName($('player-name').value, 'Host'), names: [...guests.values()], ai,
    status: guests.size ? `${1 + guests.size} players connected · ${seated}/4 seats filled.` : 'Share the code with at least one friend. You can deal once they appear here.',
  });
  room.send({ type: 'lobby', code: room.code, hostName: cleanName($('player-name').value, 'Host'), names: [...guests.values()], ai, decks: Number($('decks').value) }).catch(() => {});
}

// The table as `seat` may see it: other hands and the stock stay hidden until the round ends.
function statePacket(seat) {
  const view = {
    ...engine, cached: null, stock: engine.stock.map(() => NO_CARD), counts: engine.hands.map((_, s) => engine.count(s)),
    hands: engine.hands.map((hand, s) => s === seat || engine.done ? hand : hand.map(() => 0)),
  };
  const recent = log.slice(-80);
  return {
    seat, code: room.code, names: playerNames, ai: [...aiSeats], round, players, decks, totals, history, scored,
    engine: view, decision: decision && { id: decision.id, seat: decision.seat, actions: decision.seat === seat ? decision.actions : null },
    meldOwners, laidBy, lastActions, freshMeld, freshDiscard, busy, failure, lastMove,
    logStart: log.length - recent.length,
    // Someone else's stock draw stays secret.
    log: recent.map(e => e.kind === EVENT_STOCK && e.actor !== seat ? { ...e, card: NO_CARD, cards: [] } : e),
    agent: agentInfo,
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
    void sendGuestHint();
  });
}

// A guest with either readout on gets the agent's policy and their advantages on their own turn.
async function sendGuestHint() {
  if (!decision || engine.done || busy || failure) return;
  const peer = seatPeer.get(decision.seat), asked = decision;
  if (!peer || !hintPeers.has(peer) || hinted.get(peer) === asked.id) return;
  hinted.set(peer, asked.id);
  try {
    const advice = await assess(asked.seat, asked);
    if (advice) room?.send({ type: 'hint', ...advice }, peer).catch(() => {});
  } catch (error) { console.error('The guest’s readout failed.', error); }
}

function remoteMove(message, peer) {
  const seat = peerSeat.get(peer);
  if (seat === undefined) return;
  // A plan (a meld and the cards added to it) arrives as `moves`; each is checked in turn.
  const moves = Array.isArray(message.moves) ? message.moves.slice(0, 13) : [message.move];
  let played = 0;
  for (const wanted of moves) {
    const legal = engine && !engine.done && !busy && !failure && decision?.seat === seat && (played || message.id === decision.id);
    const move = legal && Array.isArray(wanted) && decision.actions.find(a => sameMove(a, wanted));
    if (!move) break;
    play(move); played++;
  }
  if (!played) { sent.delete(peer); sync(); return; }  // Resend the table so the guest can try again.
  void advanceBots();
}

function applyState({ revision: number, state }) {
  if (number <= applied) return;
  applied = number;
  const newRound = state.round !== round, moved = newRound || state.lastMove?.n !== lastMove?.n;
  // Your draw just landed: note where its cards start before the table changes.
  const watched = !newRound && engine && moved && state.lastMove?.actor === state.seat && state.lastMove.move[0] <= TAKE && watchDraw(state.lastMove.move);
  me = state.seat; playerNames = state.names; aiSeats = new Set(state.ai);
  ({ round, players, decks, totals, history, scored, meldOwners, laidBy, lastActions, freshMeld, freshDiscard, busy, failure, lastMove, logStart, log } = state);
  agentInfo = state.agent;
  const counts = state.engine.counts;
  engine = Object.assign(Object.create(RummyEngine.prototype), state.engine, { count: seat => counts[seat] });
  decision = state.decision && { ...state.decision, actions: state.decision.actions ?? [] };
  if (watched) drawFx = { ...watched, start: performance.now(), items: null };
  if (newRound) { selected = []; notes = new Map(); hint = null; $('result-dialog').hidden = true; }
  if (moved) selected = [];
  pending = false;
  lobbyPhase = 'playing';
  $('model-state').textContent = agentInfo ? `Agent ${agentInfo.run} · ${agentInfo.iteration.toLocaleString()} · host` : 'Host agent';
  $('model-state').classList.toggle('is-ready', Boolean(agentInfo));
  showGame();
  render();
  if (engine.done && scored && resultShown !== round) showResult();
}

function onMessage(message, peer) {
  if (!message || typeof message !== 'object') return;
  if (role === 'host') {
    if (message.type === 'join') {
      if (lobbyPhase !== 'lobby') { room.send({ type: 'rejected', message: 'That table has already started.' }, peer).catch(() => {}); return; }
      if (!guests.has(peer) && guests.size >= 3) { room.send({ type: 'rejected', message: 'That table is full.' }, peer).catch(() => {}); return; }
      guests.set(peer, cleanName(message.name));
      updateHostLobby();
    } else if (message.type === 'move') remoteMove(message, peer);
    else if (message.type === 'hints') {
      if (message.on) hintPeers.add(peer); else hintPeers.delete(peer);
      hinted.delete(peer);
      void sendGuestHint();
    }
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
    renderLobby({ hostName: message.hostName, names: message.names, ai: message.ai, status: `Connected · ${plural(message.decks, 'deck')}. Waiting for the host to deal.` });
  } else if (message.type === 'starting') {
    $('lobby-status').textContent = 'The host is loading the agent and dealing…';
  } else if (message.type === 'state') {
    const first = lobbyPhase !== 'playing';
    applyState(message);
    if (first) sendHintPreference();
  } else if (message.type === 'hint') {
    const after = Array.isArray(message.after) && message.after.length === message.probabilities?.length && Number.isFinite(message.now) ? message.after : null;
    hint = { id: message.id, probabilities: message.probabilities, argmax: message.argmax, chain: Array.isArray(message.chain) ? message.chain : [], now: message.now, after, best: after && bestOf(after, message.probabilities) };
    render();
  } else if (message.type === 'rejected' || message.type === 'closed') {
    void leaveTable(message.message || 'The host closed this table.');
  }
}

const sendHintPreference = () => { if (role === 'guest' && hostPeer) room.send({ type: 'hints', on: wantsAdvice() }, hostPeer).catch(() => {}); };

function onPeerJoin(peer) {
  if (role === 'host') room.send({ type: 'host_hello' }, peer).catch(() => {});
}

function onPeerLeave(peer) {
  if (role === 'guest') { if (peer === hostPeer) void leaveTable('The host left, so the table has closed.'); return; }
  if (lobbyPhase !== 'playing') { guests.delete(peer); updateHostLobby(); return; }
  const seat = peerSeat.get(peer);
  if (seat === undefined) return;
  peerSeat.delete(peer); seatPeer.delete(seat); hintPeers.delete(peer); sent.delete(peer);
  // The agent takes over the seat, so the table plays on.
  aiSeats.add(seat);
  if (engine) {
    log.push({ left: true, actor: seat });
    render();
    void advanceBots();
  }
}

function onNetworkError(message) {
  if (lobbyPhase === 'playing') $('status').textContent = message; else setSetupError(message);
}

async function loadAgent() {
  $('loading').hidden = false;
  try {
    const manifest = await agent.load(({ percent, message }) => {
      $('load-bar').style.width = `${percent}%`; $('load-percent').textContent = `${Math.round(percent)}%`; $('load-message').textContent = message;
    });
    agentInfo = { run: manifest.run, iteration: manifest.iteration };
    $('checkpoint-note').textContent = `Loaded checkpoint ${manifest.run} / ${manifest.iteration.toLocaleString()}.`;
    $('model-state').textContent = `Agent ${manifest.run} · ${manifest.iteration.toLocaleString()}`;
    $('model-state').classList.add('is-ready');
    return true;
  } catch (error) {
    setSetupError(`Could not load the agent. ${error.message}`);
    return false;
  } finally { $('loading').hidden = true; }
}

function newTable(seatNames, ai) {
  players = seatNames.length; decks = Number($('decks').value); difficulty = Number($('difficulty').value);
  playerNames = seatNames; aiSeats = new Set(ai);
  totals = Array(players).fill(0); history = []; round = 0;
  startRound();
}

async function startSolo() {
  $('start').disabled = true; setSetupError();
  const opponents = Number($('opponents').value);
  if (await loadAgent()) {
    me = 0; role = null;
    newTable(['You', ...AI_NAMES.slice(0, opponents)], Array.from({ length: opponents }, (_, i) => i + 1));
  } else $('start').textContent = 'Retry & start game';
  $('start').disabled = false;
}

const lockModes = locked => document.querySelectorAll('input[name="playMode"], input[name="multiplayerRole"]').forEach(input => { input.disabled = locked; });

async function openLobby() {
  setSetupError();
  const hosting = lobbyRole() === 'host';
  const playerName = cleanName($('player-name').value, hosting ? 'Host' : 'Player');
  $('player-name').value = playerName;
  try { localStorage.setItem('rummy-player-name', playerName); } catch {}
  const code = hosting ? generateRoomCode() : normalizeRoomCode($('join-code').value);
  if (!validRoomCode(code)) { $('join-code').focus(); setSetupError('Enter the complete 8-character table code.'); return; }
  $('start').disabled = true;
  $('start').textContent = hosting ? 'Opening table…' : 'Finding table…';
  lockModes(true);
  role = hosting ? 'host' : 'guest'; lobbyPhase = 'connecting'; hostPeer = null;
  guests = new Map(); peerSeat = new Map(); seatPeer = new Map(); hintPeers = new Set(); hinted = new Map(); sent = new Map();
  revision = 0; applied = -1; round = 0; resultShown = 0;
  room = new PeerRoom({ game: 'rummy', role, code, onMessage, onPeerJoin, onPeerLeave, onError: onNetworkError });
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
  const ai = Number($('opponents').value);
  if (1 + guests.size + ai > 4) { setSetupError('Rummy seats four at most.'); updateHostLobby(); return; }
  lobbyPhase = 'starting';
  $('start-multiplayer').disabled = true;
  room.send({ type: 'starting' }).catch(() => {});
  if (!(await loadAgent()) || !guests.size) { lobbyPhase = 'lobby'; updateHostLobby(); return; }
  const friends = [...guests.entries()];
  const humans = [cleanName($('player-name').value, 'Host'), ...friends.map(([, n]) => n)];
  friends.forEach(([peer], i) => { peerSeat.set(peer, i + 1); seatPeer.set(i + 1, peer); });
  me = 0; lobbyPhase = 'playing';
  newTable([...humans, ...AI_NAMES.slice(0, ai)], Array.from({ length: ai }, (_, i) => humans.length + i));
}

// Leave the multiplayer table (or the solo game) and return to the setup screen.
async function leaveTable(error = '') {
  const active = room;
  if (role === 'host' && active) await active.send({ type: 'closed', message: 'The host closed this table.' }).catch(() => {});
  generation++; engine = null; decision = null; busy = false; failure = false; pending = false; selected = []; hint = null;
  room = null; role = null; lobbyPhase = 'idle'; hostPeer = null; me = 0;
  guests = new Map(); peerSeat = new Map(); seatPeer = new Map(); hintPeers = new Set(); sent = new Map();
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
$('opponents').addEventListener('change', updateHostLobby);
$('decks').addEventListener('change', updateHostLobby);
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
$('difficulty').addEventListener('input', () => {
  snapDifficulty($('difficulty'));
  $('difficulty-output').textContent = difficultyLabel(Number($('difficulty').value));
});
$('setup-hints').addEventListener('change', () => { $('hints').checked = $('setup-hints').checked; });
$('setup-values').addEventListener('change', () => { $('values').checked = $('setup-values').checked; });
window.addEventListener('beforeunload', () => { room?.leave(); });
$('hand').addEventListener('click', event => {
  const button = event.target.closest('[data-card]');
  if (!button || !humanTurn() || engine.phase === DRAW) return;
  const id = button.dataset.card;
  selected = selected.includes(id) ? selected.filter(c => c !== id) : [...selected, id]; render();
});
$('hand').addEventListener('dblclick', event => {
  // Double-clicking a card discards it straight away, when that is legal.
  const button = event.target.closest('[data-card]');
  if (!button || !humanTurn()) return;
  selected = [button.dataset.card];
  userPlay(selectedDiscard());
});
$('available').addEventListener('click', event => {
  if (event.target.closest('[data-results]')) { $('result-dialog').hidden = false; render(); $('next-round').focus(); return; }
  const button = event.target.closest('[data-suggestion]');
  if (!button || !humanTurn()) return;
  selected = button.dataset.suggestion.split(',').map(c => `${c}:0`);
  render();
});
$('melds').addEventListener('click', event => {
  const button = event.target.closest('[data-meld]');
  if (button) userPlay(selectedLayoff(Number(button.dataset.meld)));
});
$('discard-spread').addEventListener('click', event => {
  const button = event.target.closest('[data-above]');
  if (button) userPlay(legalMoves().find(a => a[0] === TAKE && a[2] === Number(button.dataset.above)));
});
$('draw-stock').addEventListener('click', () => userPlay(legalMoves().find(a => a[0] === STOCK)));
$('discard').addEventListener('click', () => userPlay(selectedDiscard()));
$('lay').addEventListener('click', () => userPlay(selectedPlan()));
$('clear').addEventListener('click', () => { selected = []; render(); });
$('sort').addEventListener('click', () => { sortBy = sortBy === 'suit' ? 'rank' : 'suit'; render(); });
$('autoplay').addEventListener('click', () => { setAutoplay(!autoplay()); selected = []; render(); void advanceBots(); });
$('speed').addEventListener('input', updateSpeed);
for (const [id, mirror] of [['hints', 'setup-hints'], ['values', 'setup-values']]) {
  $(id).addEventListener('change', () => { $(mirror).checked = $(id).checked; render(); sendHintPreference(); void requestHint(); });
}
window.addEventListener('resize', () => { if (engine) { fitPile(); fitMelds(); fitHand(); } });
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
$('next-round').addEventListener('click', () => { if (role !== 'guest') startRound(); });
$('new-table').addEventListener('click', () => {
  $('leave-copy').textContent = role === 'host' ? 'This closes the table for everyone. The score sheet will be cleared.'
    : role === 'guest' ? 'You will leave this multiplayer table; the agent takes over your seat.' : 'The current round and the score sheet will be cleared.';
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
try { $('player-name').value = cleanName(localStorage.getItem('rummy-player-name') || localStorage.getItem('plump-player-name')); } catch {}
configureSetup();
