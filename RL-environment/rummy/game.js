import { RummyEngine, ObservationWriter, candidateFeatures, name, RANKS, DRAW, STOCK, TAKE, MELD_GROUP, MELD_RUN, LAYOFF_GROUP, LAYOFF_RUN, DISCARD } from './engine.js';
import { RULES } from './rules-data.js';
import { RummyAgent } from './model-client.js';

const $ = id => document.getElementById(id);
const agent = new RummyAgent();
const names = ['You', 'Fern', 'Clover', 'Sage'];
let engine, writer, streams, decision, selected = [], sortBy = 'suit', busy = false, generation = 0;
let totals = [], history = [], round = 0, scored = false, activity = [], lastMessage = '', failure = false;
let meldOwners = [], lastActions = [], freshMeld = -1, freshDiscard = false;
let temperature = 0, players = 3;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const autoplay = () => $('autoplay').getAttribute('aria-pressed') === 'true';
// Slider 0..100 → a pause of 0.9 s down to nothing between agent moves.
const moveDelay = () => Math.round(900 * Math.pow(1 - Number($('speed').value) / 100, 1.5));
const humanTurn = () => engine && !engine.done && engine.current === 0 && !autoplay() && !busy && !failure;
const isMeld = move => move[0] === MELD_GROUP || move[0] === MELD_RUN;
const isLayoff = move => move[0] === LAYOFF_GROUP || move[0] === LAYOFF_RUN;
const sameCards = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
const selectedCards = () => selected.map(id => Number(id.split(':')[0]));
const legalMoves = () => decision?.actions ?? [];
const selectedMeld = () => legalMoves().find(a => isMeld(a) && sameCards(RULES.cards[a[2]], selectedCards()));
const selectedDiscard = () => selected.length === 1 && legalMoves().find(a => a[0] === DISCARD && a[1] === selectedCards()[0]);
const selectedLayoff = position => selected.length === 1 && legalMoves().find(a => isLayoff(a) && a[2] === position && a[1] === selectedCards()[0]);
const cardAsset = card => `/resources/cards/${['clubs', 'diamonds', 'hearts', 'spades'][Math.floor(card / 13)]}-${RANKS[card % 13].toLowerCase()}.svg`;
const plural = (n, word) => `${n} ${n === 1 ? word : word + 's'}`;
const signed = n => (n > 0 ? '+' : '') + n;

function prepareDecision() {
  if (engine.done) { decision = null; return; }
  const seat = engine.current;
  streams[seat].push(writer.observe(seat));
  decision = { seat, actions: engine.candidates() };
}

function startRound() {
  generation++; round++; scored = false; selected = []; activity = []; lastMessage = ''; failure = false; busy = false;
  engine = new RummyEngine({ players }); writer = new ObservationWriter(engine);
  streams = Array.from({ length: players }, () => []);
  meldOwners = []; lastActions = Array(players).fill(''); freshMeld = -1; freshDiscard = false;
  setAutoplay(false);
  $('game-error').hidden = true; $('result-dialog').hidden = true;
  $('setup').hidden = true; $('game').hidden = false;
  prepareDecision(); render();
  window.scrollTo({ top: 0 });
  void advanceBots();
}

function describe(event) {
  const who = names[event.actor];
  if (event.kind === 2) return `${who} drew from the stock${event.actor === 0 ? `: ${name(event.card)}` : ''}.`;
  if (event.kind === 3) return `${who} took ${name(event.card)} from the discard pile.`;
  if (event.kind === 4) return `${who} laid ${event.cards.map(name).join(' ')}.`;
  if (event.kind === 5) return `${who} added ${name(event.card)} to a meld.`;
  return `${who} discarded ${name(event.card)}.`;
}

// The few words under a seat that say what that player just did.
function shortAction(event) {
  if (event.kind === 2) return 'Drew from stock';
  if (event.kind === 3) return `Took ${name(event.card)}`;
  if (event.kind === 4) return `Laid ${event.cards.length} cards`;
  if (event.kind === 5) return `Added ${name(event.card)}`;
  return `Discarded ${name(event.card)}`;
}

function play(move) {
  const event = engine.apply(move); writer.record(event);
  if (event.kind === 4) { meldOwners.push(event.actor); freshMeld = engine.table.length - 1; }
  else if (event.kind === 5) freshMeld = move[2];
  else if (event.kind === 2 || event.kind === 3) freshMeld = -1;
  freshDiscard = event.kind === 6;
  lastActions[event.actor] = shortAction(event);
  lastMessage = describe(event); activity.unshift(lastMessage); selected = [];
  prepareDecision(); render();
  if (engine.done) finishRound();
}

function userPlay(move) {
  if (!humanTurn() || !move) return;
  play(move);
  void advanceBots();
}

async function advanceBots() {
  if (busy || failure || !engine || engine.done) return;
  const version = generation;
  busy = true;
  try {
    while (version === generation && !engine.done && (engine.current !== 0 || autoplay())) {
      render();
      const acting = engine.current;
      const [chosen] = await Promise.all([
        agent.choose(streams[acting], candidateFeatures(engine, decision.actions), temperature),
        pause(moveDelay()),
      ]);
      if (version !== generation) return;
      // Turning off auto-play during inference gives control back before the move.
      if (acting === 0 && !autoplay()) break;
      play(decision.actions[chosen]);
    }
  } catch (error) {
    if (version !== generation) return;
    failure = true;
    $('game-error-message').textContent = `The agent stopped: ${error.message}`;
    $('game-error').hidden = false;
  } finally {
    if (version === generation) { busy = false; render(); }
  }
}

function cardImage(card, extra = '') {
  return `<img class="table-card ${extra}" src="${cardAsset(card)}" alt="${name(card)}" draggable="false" />`;
}

function renderSeats() {
  $('felt').className = `table-felt rummy-felt players-${players}`;
  $('seats').innerHTML = Array.from({ length: players - 1 }, (_, i) => {
    const seat = i + 1, count = engine.count(seat), current = !engine.done && engine.current === seat;
    const hand = engine.done
      ? `<div class="seat-reveal" aria-label="${names[seat]}'s remaining cards">${engine.hands[seat].flatMap((n, c) => Array(n).fill(c)).map(c => cardImage(c)).join('')}</div>`
      : `<div class="opponent-hand" aria-hidden="true">${'<span class="opponent-card"></span>'.repeat(Math.min(count, 10))}</div>`;
    const state = engine.opened[seat] ? 'open' : engine.turnPoints && current ? `${engine.turnPoints}/30` : 'closed';
    return `<div class="seat seat-player-${seat} ${current ? 'is-current' : ''}" aria-label="${names[seat]}, ${plural(count, 'card')}">
      <div class="seat-name"><span>${names[seat]}</span><span>${current && busy ? 'thinking…' : 'AI'}</span></div>
      ${hand}
      <div class="seat-stats"><span>${plural(count, 'card')}</span><span>${state}</span><span>Σ ${totals[seat] || 0}</span></div>
      ${lastActions[seat] ? `<div class="seat-action">${lastActions[seat]}</div>` : ''}
    </div>`;
  }).join('');
}

function renderPiles(interactive) {
  const canDraw = interactive && engine.phase === DRAW;
  const stockLayers = Math.min(3, Math.ceil(engine.stock.length / 15));
  $('stock-stack').innerHTML = engine.stock.length
    ? Array.from({ length: stockLayers }, (_, i) => `<span class="pile-card card-back" style="--layer:${stockLayers - 1 - i}"></span>`).join('')
    : '<span class="pile-empty">Empty</span>';
  const under = Math.min(2, Math.max(0, engine.pile.length - 1));
  $('discard-stack').innerHTML = engine.pile.length
    ? Array.from({ length: under }, (_, i) => `<span class="pile-card pile-under" style="--layer:${under - i}"></span>`).join('') + cardImage(engine.top, `pile-card ${freshDiscard ? 'is-fresh' : ''}`)
    : '<span class="pile-empty">Empty</span>';
  $('stock-count').textContent = engine.stock.length;
  $('pile-count').textContent = engine.pile.length;
  $('draw-stock').disabled = !canDraw;
  $('draw-discard').disabled = !(canDraw && engine.pile.length);
  $('draw-stock').classList.toggle('is-ready', canDraw);
  $('draw-discard').classList.toggle('is-ready', canDraw && engine.pile.length > 0);
  $('draw-stock').setAttribute('aria-label', `Draw from the stock, ${plural(engine.stock.length, 'card')} left`);
  $('draw-discard').setAttribute('aria-label', engine.pile.length ? `Take ${name(engine.top)} from the discard pile` : 'The discard pile is empty');
}

function renderMelds(interactive) {
  const melds = $('melds');
  melds.innerHTML = engine.table.length ? engine.table.map((m, i) => {
    const target = interactive && selectedLayoff(i);
    const cards = RULES.cards[m];
    return `<button class="rummy-meld ${target ? 'is-target' : ''} ${i === freshMeld ? 'is-fresh' : ''}" type="button" data-meld="${i}" ${target ? '' : 'disabled'}
      aria-label="${RULES.kinds[m] ? 'Run' : 'Set'} by ${names[meldOwners[i]] ?? 'a player'}: ${cards.map(name).join(', ')}${target ? '. Add the selected card here' : ''}">
      <span class="meld-cards">${cards.map(c => cardImage(c)).join('')}</span>
      <span class="meld-tag">${names[meldOwners[i]] ?? ''} · ${RULES.kinds[m] ? 'run' : 'set'}${target ? ' · <b>add here</b>' : ''}</span>
    </button>`;
  }).join('') : `<p class="melds-empty">${engine.done ? 'No melds were laid.' : 'No melds yet. The first melds a player lays must total 30 points.'}</p>`;
  fitMelds();
}

// Shrink the meld cards step by step until every meld fits on the felt.
function fitMelds() {
  const melds = $('melds');
  for (const density of ['', 'compact', 'tight', 'tiny']) {
    melds.dataset.density = density;
    if (melds.scrollHeight <= melds.clientHeight + 1) break;
  }
}

function renderHand(interactive) {
  const opening = engine.turnPoints && engine.current === 0;
  const state = engine.opened[0] ? 'opened' : opening ? `opening ${engine.turnPoints}/30` : 'not opened';
  const label = $('human-label');
  label.innerHTML = `<span>You</span><span>${plural(engine.count(0), 'card')}</span><span>${state}</span><span>${engine.penalties()[0]} pts in hand</span><span>Σ ${totals[0] || 0}</span>`;
  label.classList.toggle('is-current', !engine.done && engine.current === 0);
  const cards = engine.hands[0].flatMap((n, c) => Array.from({ length: n }, (_, copy) => ({ card: c, id: `${c}:${copy}` })));
  if (sortBy === 'rank') cards.sort((a, b) => a.card % 13 - b.card % 13 || a.card - b.card);
  // Preserve focus when selecting a card with a keyboard and re-rendering the hand.
  const focused = document.activeElement?.dataset?.card;
  const canSelect = interactive && engine.phase !== DRAW;
  $('hand').classList.toggle('is-waiting', !canSelect && !engine.done);
  $('hand').innerHTML = cards.map(({ card, id }) => {
    const chosen = selected.includes(id);
    return `<button type="button" class="rummy-card ${chosen ? 'is-selected' : ''}" data-card="${id}" aria-label="${name(card)}" aria-pressed="${chosen}" ${canSelect ? '' : 'disabled'}><img src="${cardAsset(card)}" alt="" draggable="false" /></button>`;
  }).join('');
  if (focused) $('hand').querySelector(`[data-card="${focused}"]`)?.focus({ preventScroll: true });
}

function renderActions(interactive) {
  const meld = interactive && selectedMeld(), discard = interactive && selectedDiscard();
  $('sort').textContent = `Sort by ${sortBy === 'suit' ? 'rank' : 'suit'}`;
  $('clear').disabled = !selected.length || !interactive;
  $('lay').disabled = !meld;
  $('discard').disabled = !discard;
  $('lay').classList.toggle('is-default', Boolean(meld));
  $('discard').classList.toggle('is-default', Boolean(discard) && !meld);
  $('lay').textContent = engine.opened[0] ? 'Lay meld' : 'Lay opening meld';
  let help = 'Select cards for a meld, or one card to discard.';
  if (engine.done) help = 'Round complete.';
  else if (failure) help = 'The agent stopped. Retry to continue.';
  else if (!interactive) help = engine.current === 0 && autoplay() ? 'The agent is playing your hand.' : `${names[engine.current]} is playing. Your cards stay private.`;
  else if (engine.phase === DRAW) help = 'Your turn: draw from the stock or take the top discard.';
  else if (selected.length) {
    const layoff = selected.length === 1 && legalMoves().some(a => isLayoff(a) && a[1] === selectedCards()[0]);
    if (meld) help = `${RULES.kinds[meld[2]] ? 'Run' : 'Set'} worth ${RULES.points[meld[2]]} points. Ready to lay.`;
    else if (layoff) help = 'Tap a highlighted meld to add this card, or discard it.';
    else if (discard) help = `Discard ${name(selectedCards()[0])} to end your turn.`;
    else help = engine.turnPoints ? 'Pick a complete meld to finish your 30-point opening.' : 'That is not a meld yet. Sets are 3–4 of a rank, runs 3+ in a suit.';
  } else if (engine.turnPoints) help = `Opening: ${engine.turnPoints}/30 points. Lay another meld before you discard.`;
  $('selection-help').textContent = help;
  const melds = interactive && engine.phase !== DRAW ? legalMoves().filter(isMeld) : [];
  $('available').innerHTML = engine.done && $('result-dialog').hidden
    ? '<button class="game-button is-default" type="button" data-results>Show scores &amp; next round</button>'
    : melds.length ? `<span>${engine.opened[0] ? 'Melds in your hand' : 'Opening melds'}:</span>${melds.map(m => `<button class="game-button meld-suggestion" type="button" data-suggestion="${m[2]}">${RULES.cards[m[2]].map(c => `<span class="${Math.floor(c / 13) % 3 ? 'is-red' : ''}">${name(c)}</span>`).join(' ')}<small>${RULES.points[m[2]]}</small></button>`).join('')}` : '';
}

function renderScores() {
  const head = `<thead><tr><th>Rnd</th>${names.slice(0, players).map(n => `<th>${n}</th>`).join('')}</tr></thead>`;
  const cell = v => `<td class="${v > 0 ? 'is-hit' : v < 0 ? 'is-miss' : ''}">${signed(v)}</td>`;
  const rows = history.map(h => `<tr><td>${h.round}</td>${h.scores.map(cell).join('')}</tr>`).join('');
  const live = engine && !scored ? `<tr class="is-active"><td>${round}</td>${Array.from({ length: players }, (_, s) => `<td>${plural(engine.count(s), 'card')}</td>`).join('')}</tr>` : '';
  const total = `<tr class="score-total-row"><td>Total</td>${totals.map(t => `<td>${t}</td>`).join('')}</tr>`;
  $('score-table').innerHTML = `${head}<tbody>${rows}${live}${total}</tbody>`;
  $('score-caption').textContent = `Round ${round}`;
}

function render() {
  if (!engine) return;
  const interactive = humanTurn();
  $('plaque').innerHTML = `<strong>Round ${round}</strong>Turn ${engine.turns + 1} · ${plural(players, 'player')}`;
  $('turn-count').textContent = `Turn ${engine.turns + 1}`;
  $('agent-label').textContent = agent.manifest ? `Self-play agent · checkpoint ${agent.manifest.run} / ${agent.manifest.iteration.toLocaleString()}. An early checkpoint; newer ones will replace it.` : '';
  let status;
  if (engine.done) status = `${lastMessage} Round complete.`;
  else if (failure) status = 'The agent stopped. Retry to continue this round.';
  else if (engine.current !== 0 || autoplay()) status = `${engine.current === 0 ? 'The agent is playing for you' : `${names[engine.current]} is thinking`}…${lastMessage ? ` ${lastMessage}` : ''}`;
  else if (engine.phase === DRAW) status = `Your turn. ${lastMessage}`;
  else if (engine.turnPoints) status = `Opening in progress: ${engine.turnPoints}/30 points.`;
  else status = 'Lay what you can, then discard one card.';
  $('status').textContent = status;
  renderSeats();
  renderPiles(interactive);
  renderMelds(interactive);
  renderHand(interactive);
  renderActions(interactive);
  renderScores();
  $('activity').innerHTML = activity.slice(0, 80).map(entry => `<li>${entry}</li>`).join('');
}

function finishRound() {
  if (scored) return;
  scored = true;
  const scores = engine.scores();
  totals = totals.map((total, i) => total + scores[i]);
  history.push({ round, scores });
  $('result-kicker').textContent = engine.rummy ? 'Rummy! Double points' : `Round ${round} complete`;
  $('result-title').textContent = engine.winner === null ? 'The round is closed.' : engine.winner === 0 ? 'You went out!' : `${names[engine.winner]} went out.`;
  $('result-description').textContent = engine.winner === null
    ? (engine.truncated ? 'The 200-turn limit was reached. Everyone loses the value of their remaining hand.' : 'The stock ran out. Everyone loses the value of their remaining hand.')
    : engine.rummy ? 'Opened and went out in one turn, on an empty table. All scores are doubled.' : 'The last card is discarded. Here’s how the table stands.';
  $('scores').innerHTML = `<table class="score-table"><thead><tr><th>Player</th><th>Left</th><th>Round</th><th>Total</th></tr></thead><tbody>${scores.map((score, seat) => `<tr class="${seat === engine.winner ? 'is-winner' : ''}"><td>${names[seat]}</td><td>${plural(engine.count(seat), 'card')}</td><td class="${score > 0 ? 'is-hit' : score < 0 ? 'is-miss' : ''}">${signed(score)}</td><td>${totals[seat]}</td></tr>`).join('')}</tbody></table>`;
  $('result-dialog').hidden = false;
  render();
  $('next-round').focus({ preventScroll: true });
}

function setAutoplay(on) {
  $('autoplay').setAttribute('aria-pressed', String(on));
  $('autoplay').textContent = on ? 'Stop auto-play' : 'Auto-play my hand';
}

function updateSpeed() {
  const delay = moveDelay();
  $('speed-output').textContent = delay ? `${(delay / 1000).toFixed(2)} s` : 'instant';
}

$('setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('start').disabled = true; $('setup-error').hidden = true; $('loading').hidden = false;
  try {
    const manifest = await agent.load(({ percent, message }) => {
      $('load-bar').style.width = `${percent}%`; $('load-percent').textContent = `${Math.round(percent)}%`; $('load-message').textContent = message;
    });
    $('checkpoint-note').textContent = `Loaded checkpoint ${manifest.run} / ${manifest.iteration.toLocaleString()}.`;
    $('model-state').textContent = `Agent ${manifest.run} · ${manifest.iteration.toLocaleString()}`;
    $('model-state').classList.add('is-ready');
    players = Number($('opponents').value); temperature = Number($('style').value);
    totals = Array(players).fill(0); history = []; round = 0;
    startRound();
  } catch (error) {
    $('setup-error').textContent = `Could not load the agent. ${error.message}`; $('setup-error').hidden = false;
    $('start').textContent = 'Retry & start game';
  } finally { $('start').disabled = false; $('loading').hidden = true; }
});
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
  selected = RULES.cards[Number(button.dataset.suggestion)].map(c => `${c}:0`);
  render();
});
$('melds').addEventListener('click', event => {
  const button = event.target.closest('[data-meld]');
  if (button) userPlay(selectedLayoff(Number(button.dataset.meld)));
});
$('draw-stock').addEventListener('click', () => userPlay(legalMoves().find(a => a[0] === STOCK)));
$('draw-discard').addEventListener('click', () => userPlay(legalMoves().find(a => a[0] === TAKE)));
$('discard').addEventListener('click', () => userPlay(selectedDiscard()));
$('lay').addEventListener('click', () => userPlay(selectedMeld()));
$('clear').addEventListener('click', () => { selected = []; render(); });
$('sort').addEventListener('click', () => { sortBy = sortBy === 'suit' ? 'rank' : 'suit'; render(); });
$('autoplay').addEventListener('click', () => { setAutoplay(!autoplay()); selected = []; render(); void advanceBots(); });
$('speed').addEventListener('input', updateSpeed);
window.addEventListener('resize', () => { if (engine) fitMelds(); });
// On phones the score sheet is a drawer over the table.
const showScores = open => { $('game').dataset.drawer = open ? 'scores' : ''; $('scores-toggle').setAttribute('aria-expanded', String(open)); };
$('scores-toggle').addEventListener('click', () => showScores($('game').dataset.drawer !== 'scores'));
$('scores-close').addEventListener('click', () => showScores(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape') showScores(false); });
document.querySelectorAll('[data-rules]').forEach(button => button.addEventListener('click', () => $('rules-dialog').showModal()));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('review').addEventListener('click', () => { $('result-dialog').hidden = true; render(); });
$('next-round').addEventListener('click', startRound);
$('new-table').addEventListener('click', () => $('leave-dialog').showModal());
$('leave').addEventListener('click', () => {
  generation++; engine = null; busy = false; failure = false; selected = [];
  $('leave-dialog').close(); $('result-dialog').hidden = true; $('game').hidden = true; $('setup').hidden = false;
});
$('retry').addEventListener('click', async () => {
  $('retry').disabled = true;
  try { await agent.load(); failure = false; $('game-error').hidden = true; void advanceBots(); }
  catch (error) { $('game-error-message').textContent = error.message; }
  finally { $('retry').disabled = false; }
});
updateSpeed();
