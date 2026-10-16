import { RummyEngine, ObservationWriter, candidateFeatures, name, RANKS, DRAW, STOCK, TAKE, MELD_GROUP, MELD_RUN, LAYOFF_GROUP, LAYOFF_RUN, DISCARD, NO_CARD, EVENT_STOCK, EVENT_TAKE, EVENT_MELD, EVENT_LAYOFF } from './engine.js?v=r7-7800';
import { RULES } from './rules-data.js';
import { RummyAgent } from './model-client.js';

const $ = id => document.getElementById(id);
const agent = new RummyAgent();
const names = ['You', 'Fern', 'Clover', 'Sage'];
let engine, writer, streams, decision, selected = [], sortBy = 'suit', busy = false, generation = 0;
let totals = [], history = [], round = 0, scored = false, activity = [], lastMessage = '', failure = false;
let meldOwners = [], laidBy = [], lastActions = [], freshMeld = -1, freshDiscard = false;
let temperature = 0, players = 3, decks = 1;
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
const cardList = counts => counts.flatMap((n, c) => Array(n).fill(c));

function prepareDecision() {
  if (engine.done) { decision = null; return; }
  const seat = engine.current;
  streams[seat].push(writer.observe(seat));
  decision = { seat, actions: engine.candidates() };
}

function startRound() {
  generation++; round++; scored = false; selected = []; activity = []; lastMessage = ''; failure = false; busy = false;
  engine = new RummyEngine({ players, decks }); writer = new ObservationWriter(engine);
  streams = Array.from({ length: players }, () => []);
  meldOwners = []; laidBy = []; lastActions = Array(players).fill(''); freshMeld = -1; freshDiscard = false;
  setAutoplay(false);
  $('game-error').hidden = true; $('result-dialog').hidden = true;
  $('setup').hidden = true; $('game').hidden = false;
  prepareDecision(); render();
  window.scrollTo({ top: 0 });
  void advanceBots();
}

function describe(event) {
  const who = names[event.actor];
  if (event.kind === EVENT_STOCK) return `${who} drew from the stock${event.actor === 0 ? `: ${name(event.card)}` : ''}.`;
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

function play(move) {
  const event = engine.apply(move);
  // A finished turn becomes a turn token in every other seat's stream.
  const turn = writer.record(event);
  if (turn) streams.forEach((stream, seat) => { if (seat !== event.actor) stream.push(turn[seat]); });
  if (event.kind === EVENT_MELD) { meldOwners.push(event.actor); laidBy.push({}); freshMeld = engine.table.length - 1; }
  else if (event.kind === EVENT_LAYOFF) { laidBy[move[2]][event.card] = event.actor; freshMeld = move[2]; }
  else if (event.kind === EVENT_STOCK || event.kind === EVENT_TAKE) freshMeld = -1;
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
  return `<img class="table-card ${extra}" src="${cardAsset(card)}" alt="${name(card)}" width="90" height="126" draggable="false" />`;
}

function renderSeats() {
  $('felt').className = `table-felt rummy-felt players-${players}`;
  $('seats').innerHTML = Array.from({ length: players - 1 }, (_, i) => {
    const seat = i + 1, count = engine.count(seat), current = !engine.done && engine.current === seat;
    const hand = engine.done
      ? `<div class="seat-reveal" aria-label="${names[seat]}'s remaining cards">${cardList(engine.hands[seat]).map(c => cardImage(c)).join('')}</div>`
      : `<div class="opponent-hand" aria-hidden="true">${'<span class="opponent-card"></span>'.repeat(Math.min(count, 10))}</div>`;
    // Cards an opponent took from the discard pile and still holds are public.
    const known = engine.done ? [] : cardList(engine.known[seat]);
    return `<div class="seat seat-player-${seat} ${current ? 'is-current' : ''}" aria-label="${names[seat]}, ${plural(count, 'card')}">
      <div class="seat-name"><span>${names[seat]}</span><span>${current && busy ? 'thinking…' : 'AI'}</span></div>
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
    return `<button class="spread-card ${open ? 'is-takeable' : ''} ${above === 0 && freshDiscard ? 'is-fresh' : ''}" type="button" data-above="${above}" ${open ? '' : 'disabled'} aria-label="${open ? label : name(card)}"><img src="${cardAsset(card)}" alt="" draggable="false" /></button>`;
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
  engine.table.forEach((m, i) => {
    const owner = meldOwners[i], target = interactive && selectedLayoff(i), cards = RULES.cards[m];
    // A card laid off by someone else carries their initial: its points are theirs.
    const faces = cards.map(c => {
      const by = laidBy[i][c];
      return `<span class="meld-card">${cardImage(c)}${by !== undefined && by !== owner ? `<i class="laid-by" title="Laid off by ${names[by]}">${names[by][0]}</i>` : ''}</span>`;
    }).join('');
    zones[owner].push(`<button class="rummy-meld ${target ? 'is-target' : ''} ${i === freshMeld ? 'is-fresh' : ''}" type="button" data-meld="${i}" ${target ? '' : 'disabled'}
      aria-label="${RULES.kinds[m] ? 'Run' : 'Set'} by ${names[owner]}: ${cards.map(name).join(', ')}${target ? '. Add the selected card here' : ''}"><span class="meld-cards">${faces}</span></button>`);
  });
  $('melds').innerHTML = zones.map((melds, seat) => `<section class="meld-zone zone-${seat} ${!engine.done && engine.current === seat ? 'is-current' : ''} ${melds.length ? '' : 'is-empty'}" aria-label="${seat ? `${names[seat]}’s` : 'Your'} melds">
    <span class="zone-label">${seat ? names[seat] : 'You'} · +${engine.points[seat]}</span>
    <div class="zone-melds">${melds.join('')}</div>
  </section>`).join('');
  fitMelds();
}

// Shrink a zone's meld cards step by step until its melds fit; each zone on its own.
function fitMelds() {
  for (const zone of $('melds').querySelectorAll('.meld-zone')) {
    const melds = zone.querySelector('.zone-melds');
    const fits = () => melds.scrollHeight <= melds.clientHeight + 1 && melds.scrollWidth <= melds.clientWidth + 1;
    zone.classList.remove('is-overflowing');
    for (const density of ['', 'compact', 'tight', 'tiny', 'micro']) {
      zone.dataset.density = density;
      if (fits()) break;
    }
    // Never hide a meld: if even the smallest cards do not fit, let the zone scroll.
    zone.classList.toggle('is-overflowing', !fits());
  }
}

function renderHand(interactive) {
  const label = $('human-label');
  label.innerHTML = `<span>You</span><span>${plural(engine.count(0), 'card')}</span><span>+${engine.points[0]} laid</span><span>${engine.penalties()[0] ? `−${engine.penalties()[0]}` : 0} in hand</span><span>Σ ${totals[0] || 0}</span>`;
  label.classList.toggle('is-current', !engine.done && engine.current === 0);
  const cards = engine.hands[0].flatMap((n, c) => Array.from({ length: n }, (_, copy) => ({ card: c, id: `${c}:${copy}` })));
  if (sortBy === 'rank') cards.sort((a, b) => a.card % 13 - b.card % 13 || a.card - b.card);
  // Preserve focus when selecting a card with a keyboard and re-rendering the hand.
  const focused = document.activeElement?.dataset?.card;
  const canSelect = interactive && engine.phase !== DRAW;
  const obligated = engine.current === 0 ? engine.obligation : NO_CARD;
  const kept = engine.current === 0 && !engine.done ? engine.kept : NO_CARD;
  $('hand').classList.toggle('is-waiting', !canSelect && !engine.done);
  $('hand').innerHTML = cards.map(({ card, id }) => {
    const chosen = selected.includes(id), must = card === obligated && id.endsWith(':0'), held = card === kept && id.endsWith(':0');
    const badge = must ? '<span class="must-badge">Use me</span>' : held ? '<span class="must-badge is-kept">Kept</span>' : '';
    return `<button type="button" class="rummy-card ${chosen ? 'is-selected' : ''} ${must ? 'is-obligated' : ''}" data-card="${id}" aria-label="${name(card)}${must ? ', must be used this turn' : held ? ', taken from the pile this turn: cannot be discarded' : ''}" aria-pressed="${chosen}" ${canSelect ? '' : 'disabled'}><img src="${cardAsset(card)}" alt="" draggable="false" />${badge}</button>`;
  }).join('');
  if (focused) $('hand').querySelector(`[data-card="${focused}"]`)?.focus({ preventScroll: true });
}

function renderActions(interactive) {
  const meld = interactive && selectedMeld(), discard = interactive && selectedDiscard();
  const obligated = engine.current === 0 && engine.obligation !== NO_CARD;
  $('sort').textContent = `Sort by ${sortBy === 'suit' ? 'rank' : 'suit'}`;
  $('clear').disabled = !selected.length || !interactive;
  $('lay').disabled = !meld;
  $('discard').disabled = !discard;
  $('lay').classList.toggle('is-default', Boolean(meld));
  $('discard').classList.toggle('is-default', Boolean(discard) && !meld);
  let help = 'Select cards for a meld, or one card to discard.';
  if (engine.done) help = 'Round complete.';
  else if (failure) help = 'The agent stopped. Retry to continue.';
  else if (!interactive) help = engine.current === 0 && autoplay() ? 'The agent is playing your hand.' : `${names[engine.current]} is playing. Your cards stay private.`;
  else if (engine.phase === DRAW) help = 'Your turn: draw from the stock, or take a lit card from the discard pile.';
  else if (selected.length) {
    const layoff = selected.length === 1 && legalMoves().some(a => isLayoff(a) && a[1] === selectedCards()[0]);
    if (meld) help = `${RULES.kinds[meld[2]] ? 'Run' : 'Set'} worth ${RULES.points[meld[2]]} points. Ready to lay.`;
    else if (layoff) help = 'Tap a highlighted meld to add this card' + (obligated ? '.' : ', or discard it.');
    else if (discard) help = `Discard ${name(selectedCards()[0])} to end your turn.`;
    else if (selected.length === 1 && selectedCards()[0] === engine.kept) help = `You took the ${name(engine.kept)} from the pile this turn: meld it or keep it, but it can’t go straight back.`;
    else help = obligated ? `That doesn’t use the ${name(engine.obligation)}. Pick a meld or lay-off with it.` : 'That is not a meld yet. Sets are 3–4 of a rank, runs 3+ in a suit.';
  } else if (obligated) help = `Use the ${name(engine.obligation)} you dug out in a meld or lay-off before you discard.`;
  $('selection-help').textContent = help;
  const melds = interactive && engine.phase !== DRAW ? legalMoves().filter(isMeld) : [];
  $('available').innerHTML = engine.done && $('result-dialog').hidden
    ? '<button class="game-button is-default" type="button" data-results>Show scores &amp; next round</button>'
    : melds.length ? `<span>Melds in your hand:</span>${melds.map(m => `<button class="game-button meld-suggestion" type="button" data-suggestion="${m[2]}">${RULES.cards[m[2]].map(c => `<span class="${Math.floor(c / 13) % 3 ? 'is-red' : ''}">${name(c)}</span>`).join(' ')}<small>+${RULES.points[m[2]]}</small></button>`).join('')}` : '';
}

function renderScores() {
  const head = `<thead><tr><th>Rnd</th>${names.slice(0, players).map(n => `<th>${n}</th>`).join('')}</tr></thead>`;
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
  $('agent-label').textContent = agent.manifest ? `Self-play agent · checkpoint ${agent.manifest.run} / ${agent.manifest.iteration.toLocaleString()}. An early checkpoint; newer ones will replace it.` : '';
  let status;
  if (engine.done) status = `${lastMessage} Round complete.`;
  else if (failure) status = 'The agent stopped. Retry to continue this round.';
  else if (engine.current !== 0 || autoplay()) status = `${engine.current === 0 ? 'The agent is playing for you' : `${names[engine.current]} is thinking`}…${lastMessage ? ` ${lastMessage}` : ''}`;
  else if (engine.phase === DRAW) status = `Your turn.${lastMessage ? ` ${lastMessage}` : ''}`;
  else if (engine.obligation !== NO_CARD) status = `Use the ${name(engine.obligation)} before you discard.`;
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
  const scores = engine.scores(), penalties = engine.penalties();
  totals = totals.map((total, i) => total + scores[i]);
  history.push({ round, scores });
  $('result-kicker').textContent = `Round ${round} complete`;
  $('result-title').textContent = engine.winner === null ? 'The round is closed.' : engine.winner === 0 ? 'You went out!' : `${names[engine.winner]} went out.`;
  $('result-description').textContent = engine.winner === null
    ? (engine.truncated ? 'The 200-turn limit was reached.' : 'The stock ran out.') + ' Cards left in hand count against their owner.'
    : 'Everything laid on the table scores; cards left in hand count against their owner.';
  $('scores').innerHTML = `<table class="score-table"><thead><tr><th>Player</th><th>Laid</th><th>In hand</th><th>Round</th><th>Total</th></tr></thead><tbody>${scores.map((score, seat) => `<tr class="${seat === engine.winner ? 'is-winner' : ''}"><td>${names[seat]}</td><td>+${engine.points[seat]}</td><td>${penalties[seat] ? `−${penalties[seat]}` : 0}</td><td class="${score > 0 ? 'is-hit' : score < 0 ? 'is-miss' : ''}">${signed(score)}</td><td>${totals[seat]}</td></tr>`).join('')}</tbody></table>`;
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
    players = Number($('opponents').value); decks = Number($('decks').value); temperature = Number($('style').value);
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
$('discard-spread').addEventListener('click', event => {
  const button = event.target.closest('[data-above]');
  if (button) userPlay(legalMoves().find(a => a[0] === TAKE && a[2] === Number(button.dataset.above)));
});
$('draw-stock').addEventListener('click', () => userPlay(legalMoves().find(a => a[0] === STOCK)));
$('discard').addEventListener('click', () => userPlay(selectedDiscard()));
$('lay').addEventListener('click', () => userPlay(selectedMeld()));
$('clear').addEventListener('click', () => { selected = []; render(); });
$('sort').addEventListener('click', () => { sortBy = sortBy === 'suit' ? 'rank' : 'suit'; render(); });
$('autoplay').addEventListener('click', () => { setAutoplay(!autoplay()); selected = []; render(); void advanceBots(); });
$('speed').addEventListener('input', updateSpeed);
window.addEventListener('resize', () => { if (engine) { fitPile(); fitMelds(); } });
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
