import { RummyEngine, ObservationWriter, candidateFeatures, name, RANKS, DRAW, STOCK, TAKE, MELD_GROUP, MELD_RUN, LAYOFF_GROUP, LAYOFF_RUN, DISCARD } from './engine.js';
import { RULES } from './rules-data.js';
import { RummyAgent } from './model-client.js';

const $ = id => document.getElementById(id);
const agent = new RummyAgent();
const names = ['You', 'Fern', 'Clover', 'Sage'];
const avatars = ['♠', '♣', '♦', '♠'];
let engine, writer, streams, decision, selected = [], sortBy = 'suit', busy = false, generation = 0;
let totals = [], round = 0, scored = false, activity = [], lastMessage = '', failure = false;
let temperature = 0, players = 3;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const humanTurn = () => engine && !engine.done && engine.current === 0 && !$('autoplay').checked && !busy && !failure;
const isMeld = move => move[0] === MELD_GROUP || move[0] === MELD_RUN;
const isLayoff = move => move[0] === LAYOFF_GROUP || move[0] === LAYOFF_RUN;
const sameCards = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
const selectedCards = () => selected.map(id => Number(id.split(':')[0]));
const legalMoves = () => decision?.actions ?? [];
const selectedMeld = () => legalMoves().find(a => isMeld(a) && sameCards(RULES.cards[a[2]], selectedCards()));
const selectedDiscard = () => selected.length === 1 && legalMoves().find(a => a[0] === DISCARD && a[1] === selectedCards()[0]);
const selectedLayoff = position => selected.length === 1 && legalMoves().find(a => isLayoff(a) && a[2] === position && a[1] === selectedCards()[0]);
const cardAsset = card => `/resources/cards/${['clubs', 'diamonds', 'hearts', 'spades'][Math.floor(card / 13)]}-${RANKS[card % 13].toLowerCase()}.svg`;

function cardMarkup(card, small = false) {
  return `<span class="playing-card ${small ? 'small' : ''}" aria-label="${name(card)}"><img src="${cardAsset(card)}" alt="" /></span>`;
}

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
  $('autoplay').checked = false;
  $('game-error').hidden = true;
  $('result-dialog').close(); $('setup').hidden = true; $('game').hidden = false;
  prepareDecision(); render();
  $('main').scrollIntoView({ block: 'start' });
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

function play(move) {
  const event = engine.apply(move); writer.record(event);
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
    while (version === generation && !engine.done && (engine.current !== 0 || $('autoplay').checked)) {
      render();
      const acting = engine.current;
      const [chosen] = await Promise.all([
        agent.choose(streams[acting], candidateFeatures(engine, decision.actions), temperature),
        pause(Number($('speed').value)),
      ]);
      if (version !== generation) return;
      // Turning off auto-play during inference gives control back before the move.
      if (acting === 0 && !$('autoplay').checked) break;
      play(decision.actions[chosen]);
    }
  } catch (error) {
    if (version !== generation) return;
    failure = true;
    $('game-error-message').textContent = `The agent paused: ${error.message}`;
    $('game-error').hidden = false;
  } finally {
    if (version === generation) { busy = false; render(); }
  }
}

function render() {
  if (!engine) return;
  const interactive = humanTurn();
  $('round-label').textContent = `Round ${round}`;
  $('turn-count').textContent = `Turn ${engine.turns + 1}`;
  $('agent-label').textContent = agent.manifest ? `Self-play agent · ${agent.manifest.run} / ${agent.manifest.iteration.toLocaleString()} · early checkpoint` : 'Self-play agent';
  $('seats').innerHTML = Array.from({ length: players - 1 }, (_, i) => {
    const seat = i + 1, count = engine.count(seat);
    const cards = engine.done ? engine.hands[seat].flatMap((n, c) => Array(n).fill(c)).map(name).join(' ') : '';
    return `<div class="opponent ${!engine.done && engine.current === seat ? 'active' : ''}"><div class="opponent-hand" aria-hidden="true">${Array(Math.min(4, count)).fill('<span class="card-back mini"></span>').join('')}</div><div><div class="opponent-name"><span class="opponent-avatar" aria-hidden="true">${avatars[seat]}</span>${names[seat]} <span>· ${count}</span></div><div class="opponent-status">${engine.opened[seat] ? 'Opened' : 'Not opened'} · ${totals[seat] || 0} pts</div>${cards ? `<div class="revealed">${cards}</div>` : ''}</div></div>`;
  }).join('');
  let status;
  if (engine.done) status = lastMessage + ' Round complete.';
  else if (failure) status = 'Agent paused. Retry to continue this round.';
  else if (engine.current !== 0 || $('autoplay').checked) status = `${names[engine.current]} ${engine.current === 0 ? 'are' : 'is'} thinking…${lastMessage ? ' ' + lastMessage : ''}`;
  else if (engine.phase === DRAW) status = 'Your turn. Draw from the stock or take the discard.';
  else if (engine.turnPoints) status = `Opening in progress: ${engine.turnPoints}/30 points. Lay another meld to finish opening.`;
  else status = 'Your turn. Lay cards if you can, then discard one.';
  $('status').textContent = status;
  $('stock-count').textContent = `${engine.stock.length} ${engine.stock.length === 1 ? 'card' : 'cards'} left`;
  $('pile-count').textContent = `${engine.pile.length} ${engine.pile.length === 1 ? 'card' : 'cards'}`;
  $('discard-face').innerHTML = engine.top === 52 ? '<span class="empty-pile"></span>' : cardMarkup(engine.top);
  $('draw-stock').disabled = !(interactive && engine.phase === DRAW);
  $('draw-discard').disabled = !(interactive && engine.phase === DRAW && engine.pile.length);
  $('draw-discard').setAttribute('aria-label', engine.top === 52 ? 'Discard pile is empty' : `Take ${name(engine.top)} from the discard pile`);
  $('draw-stock').setAttribute('aria-label', `Draw from stock, ${engine.stock.length} cards left`);
  $('meld-count').textContent = `${engine.table.length} ${engine.table.length === 1 ? 'meld' : 'melds'}`;
  $('melds').innerHTML = engine.table.length ? engine.table.map((m, i) => `<button class="table-meld" type="button" data-meld="${i}" aria-label="Meld ${i + 1}: ${RULES.cards[m].map(name).join(', ')}${selectedLayoff(i) ? '. Add selected card' : ''}" ${interactive && selectedLayoff(i) ? '' : 'disabled'}>${RULES.cards[m].map(c => cardMarkup(c, true)).join('')}<small>${RULES.kinds[m] ? 'Run' : 'Set'}</small></button>`).join('') : '<div class="empty-table"><b aria-hidden="true">♧</b><p>The table is yours to open.</p><small>Lay sets and runs worth at least 30 points.</small></div>';
  $('hand-count').textContent = engine.count(0);
  $('opening-status').textContent = engine.opened[0] ? 'Opened · you can add to any meld on the table' : engine.turnPoints && engine.current === 0 ? `Opening: ${engine.turnPoints}/30 · complete it this turn` : 'Not opened · 30 points in sets and runs to begin';
  $('penalty').textContent = `${engine.penalties()[0]} in hand`;
  $('sort').textContent = `Sort by ${sortBy === 'suit' ? 'rank' : 'suit'}`;
  const cards = engine.hands[0].flatMap((n, c) => Array.from({ length: n }, (_, copy) => ({ card: c, id: `${c}:${copy}` })));
  if (sortBy === 'rank') cards.sort((a, b) => a.card % 13 - b.card % 13 || a.card - b.card);
  // Preserve focus when selecting a card with a keyboard and re-rendering the hand.
  const focused = document.activeElement?.dataset?.card;
  $('hand').innerHTML = cards.map(({ card, id }) => {
    const chosen = selected.includes(id);
    return `<button type="button" class="playing-card ${chosen ? 'selected' : ''}" data-card="${id}" aria-label="${name(card)}, copy ${Number(id.split(':')[1]) + 1}" aria-pressed="${chosen}" ${interactive && engine.phase !== DRAW ? '' : 'disabled'}><img src="${cardAsset(card)}" alt="" /></button>`;
  }).join('');
  if (focused) $('hand').querySelector(`[data-card="${focused}"]`)?.focus({ preventScroll: true });
  $('clear').disabled = !selected.length || !interactive;
  $('lay').disabled = !interactive || !selectedMeld();
  $('discard').disabled = !interactive || !selectedDiscard();
  $('lay').textContent = engine.opened[0] ? 'Lay meld' : 'Lay opening meld';
  let help = 'Select cards to make a meld, or one card to discard.';
  if (engine.done) help = 'Round complete. Review the table or deal again.';
  else if (!interactive) help = engine.current === 0 && engine.phase === DRAW && !busy ? 'Draw a card to begin your turn.' : 'Your cards stay private while the agent takes its turn.';
  else if (engine.phase === DRAW) help = 'Draw a card to begin your turn.';
  else if (selected.length) {
    const m = selectedMeld();
    if (m) help = `${RULES.kinds[m[2]] ? 'Run' : 'Set'} · ${RULES.points[m[2]]} points. Ready to lay.`;
    else if (selected.length === 1 && legalMoves().some(a => isLayoff(a) && a[1] === selectedCards()[0])) help = 'Tap a highlighted table meld to add this card, or discard it.';
    else if (selectedDiscard()) help = `${name(selectedCards()[0])} selected. Discard it to end your turn.`;
    else help = engine.turnPoints ? 'Choose a complete meld to finish your 30-point opening.' : 'This selection cannot be laid. Try a set or a run, or select one card to discard.';
  } else if (engine.turnPoints) help = 'Choose another opening meld below. You must reach 30 before discarding.';
  $('selection-help').textContent = help;
  const melds = interactive && engine.phase !== DRAW ? legalMoves().filter(isMeld) : [];
  $('available').innerHTML = engine.done ? '<button type="button" data-results>View scores / next round →</button>' : melds.length ? `<span>${engine.opened[0] ? 'Available melds' : 'Opening melds'} · tap to select</span>${melds.map(m => `<button type="button" data-suggestion="${m[2]}">${RULES.cards[m[2]].map(name).join(' ')}<small>${RULES.points[m[2]]} pts</small></button>`).join('')}` : '';
  $('activity').innerHTML = activity.slice(0, 100).map(entry => `<li>${entry}</li>`).join('');
}

function finishRound() {
  if (scored) return;
  scored = true;
  const scores = engine.scores();
  totals = totals.map((total, i) => total + scores[i]);
  $('result-kicker').textContent = engine.rummy ? 'RUMMY · DOUBLE POINTS' : `ROUND ${round} COMPLETE`;
  $('result-title').textContent = engine.winner === null ? 'The round is closed.' : engine.winner === 0 ? 'You went out.' : `${names[engine.winner]} went out.`;
  $('result-description').textContent = engine.winner === null ? (engine.truncated ? 'The 200-turn limit was reached. Everyone loses the value of their remaining hand.' : 'The stock ran out. Everyone loses the value of their remaining hand.') : engine.rummy ? 'Opening and going out in one turn, with an empty table. All scores are doubled.' : 'The last card is discarded. Here’s how the table stands.';
  $('scores').innerHTML = '<div class="score-row score-header"><span>PLAYER</span><span>ROUND</span><span>TABLE</span></div>' + scores.map((score, seat) => `<div class="score-row ${seat === engine.winner ? 'winner' : ''}"><span>${names[seat]}<small>${engine.count(seat)} ${engine.count(seat) === 1 ? 'card' : 'cards'} left · ${engine.penalties()[seat]} in hand</small></span><span>${score > 0 ? '+' : ''}${score}</span><span>${totals[seat]}</span></div>`).join('');
  render(); $('result-dialog').showModal();
}

$('setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('start').disabled = true; $('setup-error').hidden = true; $('loading').hidden = false;
  try {
    const manifest = await agent.load(({ percent, message }) => { $('load-progress').value = percent; $('load-message').textContent = message; });
    $('checkpoint-note').textContent = `${manifest.run} · iteration ${manifest.iteration.toLocaleString()} · ${Math.round(manifest.bytes / 1024 / 1024)} MB`;
    players = Number($('opponents').value); temperature = Number($('style').value); totals = Array(players).fill(0); round = 0;
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
$('available').addEventListener('click', event => {
  if (event.target.closest('[data-results]')) { $('result-dialog').showModal(); return; }
  const button = event.target.closest('[data-suggestion]');
  if (!button || !humanTurn()) return;
  selected = RULES.cards[Number(button.dataset.suggestion)].map(c => `${c}:0`); render();
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
$('autoplay').addEventListener('change', () => { selected = []; render(); void advanceBots(); });
$('rules-button').addEventListener('click', () => $('rules-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('review').addEventListener('click', () => $('result-dialog').close());
$('next-round').addEventListener('click', startRound);
$('new-table').addEventListener('click', () => $('leave-dialog').showModal());
$('leave').addEventListener('click', () => {
  generation++; engine = null; busy = false; failure = false; selected = [];
  $('leave-dialog').close(); $('result-dialog').close(); $('game').hidden = true; $('setup').hidden = false;
});
$('retry').addEventListener('click', async () => {
  $('retry').disabled = true;
  try { await agent.load(); failure = false; $('game-error').hidden = true; void advanceBots(); }
  catch (error) { $('game-error-message').textContent = error.message; }
  finally { $('retry').disabled = false; }
});
