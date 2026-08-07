import {
  BrowserPpoAgent,
  modelCardId,
  modelSuits,
} from "./model-client.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const wait = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SUIT_SYMBOL = {
  spades: "♠",
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
};
const RANK_FILE = { 11: "j", 12: "q", 13: "k", 14: "a" };
const DISPLAY_SUIT_ORDER = { hearts: 0, spades: 1, diamonds: 2, clubs: 3 };

const rankLabel = (rank) => RANK_FILE[rank]?.toUpperCase() || String(rank);
const cardLabel = (card) => `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]}`;
const cardKey = (card) => `${card.suit}:${card.rank}`;
const cardAsset = (card) =>
  `/resources/cards/${card.suit}-${RANK_FILE[card.rank] || card.rank}.svg`;
const sigmoid = (value) => 1 / (1 + Math.exp(-value));

function shuffle(items) {
  const array = [...items];
  for (let index = array.length - 1; index > 0; index -= 1) {
    const next = Math.floor(Math.random() * (index + 1));
    [array[index], array[next]] = [array[next], array[index]];
  }
  return array;
}

function deck() {
  return modelSuits.flatMap((suit) =>
    Array.from({ length: 13 }, (_, index) => ({ suit, rank: index + 2 })),
  );
}

function schedule(minimum, maximum) {
  const down = Array.from({ length: maximum - minimum + 1 }, (_, index) => maximum - index);
  const up = Array.from({ length: maximum - minimum }, (_, index) => minimum + index + 1);
  return [...down, ...up];
}

function sortHand(cards) {
  return [...cards].sort(
    (a, b) =>
      DISPLAY_SUIT_ORDER[a.suit] - DISPLAY_SUIT_ORDER[b.suit] || a.rank - b.rank,
  );
}

class PlumpGame {
  constructor({ opponents, minimum, maximum }) {
    this.numPlayers = opponents + 1;
    this.schedule = schedule(minimum, maximum);
    this.scores = Array(this.numPlayers).fill(0);
    this.completedRounds = [];
    this.roundIndex = -1;
    this.round = null;
    this.startNextRound();
  }

  startNextRound() {
    this.roundIndex += 1;
    const handSize = this.schedule[this.roundIndex];
    const cards = shuffle(deck());
    const hands = Array.from({ length: this.numPlayers }, () => []);
    for (let deal = 0; deal < handSize; deal += 1) {
      for (let player = 0; player < this.numPlayers; player += 1) {
        hands[player].push(cards.shift());
      }
    }
    hands.forEach((hand) => hand.sort((a, b) => modelCardId(a) - modelCardId(b)));
    const biddingStart = this.roundIndex % this.numPlayers;
    this.round = {
      roundIndex: this.roundIndex,
      handSize,
      phase: "bidding",
      currentPlayer: biddingStart,
      biddingStart,
      biddingOrder: Array.from(
        { length: this.numPlayers },
        (_, offset) => (biddingStart + offset) % this.numPlayers,
      ),
      initialHands: hands.map((hand) => [...hand]),
      hands: hands.map((hand) => [...hand]),
      bids: [],
      tricks: [],
      tricksWon: Array(this.numPlayers).fill(0),
      roundScores: null,
      events: [],
    };
  }

  legalBids() {
    const values = Array.from({ length: this.round.handSize + 1 }, (_, value) => value);
    if (this.round.bids.length !== this.numPlayers - 1) return values;
    const forbidden =
      this.round.handSize - this.round.bids.reduce((total, item) => total + item.value, 0);
    return values.filter((value) => value !== forbidden);
  }

  bid(value) {
    const player = this.round.currentPlayer;
    if (!this.legalBids().includes(value)) throw new Error("That bid is not legal.");
    this.round.bids.push({ player, value, position: this.round.bids.length });
    this.round.events.push({ type: "bid", player, bid: value });
    if (this.round.bids.length < this.numPlayers) {
      this.round.currentPlayer = this.round.biddingOrder[this.round.bids.length];
      return;
    }

    const highBid = Math.max(...this.round.bids.map((item) => item.value));
    const leader = this.round.biddingOrder.find(
      (candidate) => this.bidFor(candidate) === highBid,
    );
    this.round.phase = "playing";
    this.round.currentPlayer = leader;
    this.round.tricks.push({
      trickIndex: 0,
      leader,
      ledSuit: null,
      plays: [],
      winner: null,
    });
  }

  bidFor(player) {
    return this.round.bids.find((item) => item.player === player)?.value ?? null;
  }

  legalCards(player = this.round.currentPlayer) {
    const hand = this.round.hands[player];
    const trick = this.round.tricks.at(-1);
    if (!trick?.plays.length) return [...hand];
    const suited = hand.filter((card) => card.suit === trick.ledSuit);
    return suited.length ? suited : [...hand];
  }

  play(card) {
    const player = this.round.currentPlayer;
    const legal = this.legalCards(player);
    if (!legal.some((item) => cardKey(item) === cardKey(card))) {
      throw new Error("You must follow suit when you can.");
    }
    const hand = this.round.hands[player];
    const cardIndex = hand.findIndex((item) => cardKey(item) === cardKey(card));
    if (cardIndex < 0) throw new Error("That card is not in the player's hand.");
    const [played] = hand.splice(cardIndex, 1);
    const trick = this.round.tricks.at(-1);
    if (!trick.plays.length) trick.ledSuit = played.suit;
    const position = trick.plays.length;
    trick.plays.push({ player, card: played, position });
    this.round.events.push({
      type: "play",
      player,
      card: played,
      trickIndex: trick.trickIndex,
      position,
    });

    if (trick.plays.length < this.numPlayers) {
      this.round.currentPlayer = (trick.leader + trick.plays.length) % this.numPlayers;
      return { trickComplete: false, roundComplete: false };
    }

    const candidates = trick.plays.filter((item) => item.card.suit === trick.ledSuit);
    const winner = candidates.reduce((best, item) =>
      item.card.rank > best.card.rank ? item : best,
    ).player;
    trick.winner = winner;
    this.round.tricksWon[winner] += 1;
    this.round.events.push({
      type: "trick_win",
      player: winner,
      trickIndex: trick.trickIndex,
    });

    if (trick.trickIndex + 1 === this.round.handSize) {
      this.finishRound();
      return { trickComplete: true, roundComplete: true, winner, completedTrick: trick };
    }

    this.round.tricks.push({
      trickIndex: trick.trickIndex + 1,
      leader: winner,
      ledSuit: null,
      plays: [],
      winner: null,
    });
    this.round.currentPlayer = winner;
    return { trickComplete: true, roundComplete: false, winner, completedTrick: trick };
  }

  finishRound() {
    const points = Array.from({ length: this.numPlayers }, (_, player) => {
      const bid = this.bidFor(player);
      const won = this.round.tricksWon[player];
      return bid === won ? (bid === 0 ? 5 : 10 + bid) : 0;
    });
    points.forEach((pointsWon, player) => {
      this.scores[player] += pointsWon;
    });
    this.round.roundScores = points;
    this.completedRounds.push({
      handSize: this.round.handSize,
      bids: Array.from({ length: this.numPlayers }, (_, player) => this.bidFor(player)),
      tricksWon: [...this.round.tricksWon],
      points,
      cumulative: [...this.scores],
    });
    this.round.currentPlayer = null;
    this.round.phase =
      this.roundIndex + 1 === this.schedule.length ? "game_over" : "round_over";
  }
}

function temperatureFor(value) {
  if (value <= 0) return Number.POSITIVE_INFINITY;
  if (value >= 100) return 0;
  if (value <= 33) return 33 / value;
  return Math.pow(0.02, (value - 33) / 67);
}

function difficultyLabel(value) {
  if (value <= 0) return "Random plays · T = ∞";
  if (value >= 100) return "Argmax · hardest";
  const temperature = temperatureFor(value);
  return `Temperature ${temperature >= 10 ? temperature.toFixed(0) : temperature.toFixed(2)}`;
}

function legalDistribution(logits, legalIndices, difficulty) {
  const argmax = legalIndices.reduce((best, index) =>
    logits[index] > logits[best] ? index : best,
  );
  if (difficulty <= 0) {
    return {
      argmax,
      probabilities: new Map(legalIndices.map((index) => [index, 1 / legalIndices.length])),
    };
  }
  if (difficulty >= 100) {
    return {
      argmax,
      probabilities: new Map(legalIndices.map((index) => [index, index === argmax ? 1 : 0])),
    };
  }
  const temperature = temperatureFor(difficulty);
  const maximum = Math.max(...legalIndices.map((index) => logits[index] / temperature));
  const weights = legalIndices.map((index) => Math.exp(logits[index] / temperature - maximum));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return {
    argmax,
    probabilities: new Map(
      legalIndices.map((index, position) => [index, weights[position] / total]),
    ),
  };
}

function sampleDistribution(distribution) {
  let cursor = Math.random();
  let last = null;
  for (const [index, probability] of distribution.probabilities) {
    last = index;
    cursor -= probability;
    if (cursor <= 0) return index;
  }
  return last;
}

function fallbackBid(game, player) {
  const legal = game.legalBids();
  const hand = game.round.hands[player];
  const estimate = hand.reduce((total, card) => total + (card.rank >= 12 ? 0.55 : 0), 0);
  return legal.reduce((best, value) =>
    Math.abs(value - estimate) < Math.abs(best - estimate) ? value : best,
  );
}

function fallbackCard(game, player) {
  const legal = game.legalCards(player);
  const bid = game.bidFor(player);
  const won = game.round.tricksWon[player];
  return [...legal].sort((a, b) => (won < bid ? b.rank - a.rank : a.rank - b.rank))[0];
}

const dom = {
  setup: $("[data-setup]"),
  setupForm: $("[data-setup-form]"),
  game: $("[data-game]"),
  gameLoading: $("[data-game-loading]"),
  loadingTitle: $("[data-loading-title]"),
  loadingCopy: $("[data-loading-copy]"),
  loadingProgress: $("[data-loading-progress]"),
  modelState: $("[data-model-state]"),
  modelDownload: $("[data-model-download]"),
  loadLabel: $("[data-load-label]"),
  loadPercent: $("[data-load-percent]"),
  loadProgress: $("[data-load-progress]"),
  difficulty: $("#difficulty"),
  difficultyOutput: $("[data-difficulty-output]"),
  maxCards: $("#max-cards"),
  minCards: $("#min-cards"),
  status: $("[data-status]"),
  table: $("[data-table]"),
  roundPlaque: $("[data-round-plaque]"),
  seats: $("[data-seats]"),
  trickZone: $("[data-trick-zone]"),
  humanLabel: $("[data-human-label]"),
  humanHand: $("[data-human-hand]"),
  bidPanel: $("[data-bid-panel]"),
  bidPrompt: $("[data-bid-prompt]"),
  bidOptions: $("[data-bid-options]"),
  scoreSheet: $("[data-score-sheet]"),
  probabilityToggle: $("[data-probability-toggle]"),
  oracleToggle: $("[data-oracle-toggle]"),
  intelStrip: $("[data-intel-strip]"),
  intelItems: $("[data-intel-items]"),
  roundDialog: $("[data-round-dialog]"),
  roundResult: $("[data-round-result]"),
  roundSummary: $("[data-round-summary]"),
  gameOver: $("[data-game-over]"),
  gameOverTitle: $("[data-game-over-title]"),
  gameOverSummary: $("[data-game-over-summary]"),
  rulesDialog: $("[data-rules-dialog]"),
};

const agent = new BrowserPpoAgent();
let game = null;
let difficulty = 33;
let interactionLocked = false;
let dealing = false;
let predictionRequest = 0;
let humanPrediction = null;
let humanPolicy = null;
let lastStatus = "";
let displayedCompletedTrick = null;

function setStatus(message) {
  lastStatus = message;
  dom.status.textContent = message;
}

function playerName(player) {
  return player === 0 ? "You" : `Agent ${player}`;
}

function playerBid(player) {
  return game.round.bids.find((item) => item.player === player)?.value;
}

function renderSeats() {
  dom.table.className = `table-felt players-${game.numPlayers}`;
  dom.seats.innerHTML = Array.from({ length: game.numPlayers - 1 }, (_, offset) => {
    const player = offset + 1;
    const hand = game.round.hands[player];
    const bid = playerBid(player);
    const isCurrent = game.round.currentPlayer === player;
    const backs = hand
      .map(
        (_, index) =>
          `<span class="opponent-card${dealing ? " is-dealing" : ""}" style="animation-delay:${index * 42}ms"></span>`,
      )
      .join("");
    return `
      <div class="seat seat-player-${player}${isCurrent ? " is-current" : ""}">
        <div class="seat-name"><span>${playerName(player)}</span><span>${isCurrent ? "thinking" : "PPO"}</span></div>
        <div class="opponent-hand" aria-label="${hand.length} hidden cards">${backs}</div>
        <div class="seat-stats"><span>bid ${bid ?? "—"}</span><span>tricks ${game.round.tricksWon[player]}</span><span>Σ ${game.scores[player]}</span></div>
      </div>
    `;
  }).join("");
}

function playOrigin(player) {
  if (player === 0) return { x: "0px", y: "210px" };
  if (player === 1) return { x: "0px", y: "-190px" };
  if (player === 2) return { x: "230px", y: "-70px" };
  if (player === 3) return { x: "-230px", y: "-70px" };
  return { x: "-170px", y: "-170px" };
}

function renderTrick() {
  const trick = displayedCompletedTrick || game.round.tricks.at(-1);
  if (!trick) {
    dom.trickZone.innerHTML = "";
    return;
  }
  dom.trickZone.innerHTML = trick.plays
    .map((play) => {
      const origin = playOrigin(play.player);
      return `
        <img
          class="trick-card${trick.winner === play.player ? " is-winner" : ""}"
          src="${cardAsset(play.card)}"
          alt="${playerName(play.player)} played ${cardLabel(play.card)}"
          style="--from-x:${origin.x};--from-y:${origin.y}"
        />
      `;
    })
    .join("");
}

function policyBadge(index) {
  if (!dom.probabilityToggle.checked || !humanPolicy) return "";
  const probability = humanPolicy.probabilities.get(index);
  if (probability === undefined) return "";
  const best = humanPolicy.argmax === index ? '<span class="argmax-mark" title="Model argmax">★</span>' : "";
  return `${best}<span class="prob-badge">${Math.round(probability * 100)}%</span>`;
}

function renderHumanHand() {
  const hand = sortHand(game.round.hands[0]);
  const humanTurn = game.round.currentPlayer === 0 && game.round.phase === "playing";
  const legal = new Set((humanTurn ? game.legalCards(0) : []).map(cardKey));
  const bid = playerBid(0);
  dom.humanLabel.classList.toggle("is-current", game.round.currentPlayer === 0);
  dom.humanLabel.textContent = `You · bid ${bid ?? "—"} · tricks ${game.round.tricksWon[0]} · total ${game.scores[0]}`;
  dom.humanHand.innerHTML = hand
    .map((card, index) => {
      const allowed = legal.has(cardKey(card));
      const unavailable = humanTurn && !allowed;
      const disabled = !humanTurn || unavailable || interactionLocked;
      return `
        <button
          class="hand-card-button${unavailable ? " is-illegal" : ""}${dealing ? " is-dealing" : ""}"
          type="button"
          data-play-card="${cardKey(card)}"
          ${disabled ? "disabled" : ""}
          style="animation-delay:${index * 48}ms"
          aria-label="Play ${cardLabel(card)}${unavailable ? ", unavailable" : ""}"
        >
          <img src="${cardAsset(card)}" alt="" />
          ${policyBadge(modelCardId(card))}
        </button>
      `;
    })
    .join("");
}

function renderBidPanel() {
  const humanTurn = game.round.currentPlayer === 0 && game.round.phase === "bidding";
  dom.bidPanel.hidden = !humanTurn;
  if (!humanTurn) return;
  const legal = game.legalBids();
  const existing = game.round.bids.reduce((sum, item) => sum + item.value, 0);
  dom.bidPrompt.textContent = game.round.bids.length === game.numPlayers - 1
    ? `Last bid: the table has ${existing}. One value is forbidden.`
    : `How many of the ${game.round.handSize} tricks will you win?`;
  dom.bidOptions.innerHTML = legal
    .map(
      (value) => `
        <button class="bid-button" type="button" data-bid="${value}" ${interactionLocked ? "disabled" : ""}>
          ${value}${policyBadge(value)}
        </button>
      `,
    )
    .join("");
}

function scoreValue(completed, player) {
  if (!completed) return "";
  const bid = completed.bids[player];
  return completed.tricksWon[player] === bid
    ? String(bid === 0 ? 5 : 10 + bid).padStart(2, "0")
    : "00";
}

function renderScoreSheet() {
  const activeBids = game.round?.bids || [];
  const header = Array.from({ length: game.numPlayers }, (_, player) =>
    `<th scope="col">${player === 0 ? "You" : `P${player}`}</th>`,
  ).join("");
  const rows = game.schedule.map((handSize, roundIndex) => {
    const completed = game.completedRounds[roundIndex];
    const active = roundIndex === game.roundIndex;
    const cells = Array.from({ length: game.numPlayers }, (_, player) => {
      if (completed) {
        const hit = completed.bids[player] === completed.tricksWon[player];
        return `<td class="${hit ? "is-hit" : "is-miss"}" title="Bid ${completed.bids[player]}, won ${completed.tricksWon[player]}">${scoreValue(completed, player)}</td>`;
      }
      if (active) {
        const bid = activeBids.find((item) => item.player === player)?.value;
        return `<td>${bid === undefined ? "" : `<span class="score-bid" title="Current bid">${bid}</span>`}</td>`;
      }
      return "<td></td>";
    }).join("");
    const direction = roundIndex === 0 ? "↓" : handSize > game.schedule[roundIndex - 1] ? "↑" : "↓";
    return `<tr class="${active ? "is-active" : ""}"><td>${handSize}${direction}</td>${cells}</tr>`;
  }).join("");
  const totals = game.scores.map((total) => `<td>${total}</td>`).join("");
  dom.scoreSheet.innerHTML = `
    <table class="score-table">
      <thead><tr><th scope="col">Cards</th>${header}</tr></thead>
      <tbody>${rows}<tr class="score-total-row"><th scope="row">Total</th>${totals}</tr></tbody>
    </table>
  `;
}

function renderRoundPlaque() {
  const trick = game.round.tricks.at(-1);
  const trickNumber = game.round.phase === "bidding" ? "Bidding" : `Trick ${Math.min((trick?.trickIndex || 0) + 1, game.round.handSize)} / ${game.round.handSize}`;
  dom.roundPlaque.innerHTML = `<strong>Round ${game.roundIndex + 1} / ${game.schedule.length}</strong>${game.round.handSize} cards · ${trickNumber}`;
}

function renderIntel() {
  const visible = dom.oracleToggle.checked && humanPrediction;
  dom.intelStrip.hidden = !visible;
  if (!visible) return;
  const completedTricks = game.round.tricks.filter((trick) => trick.winner !== null).length;
  const unresolved = game.round.handSize - completedTricks;
  const chips = [`<span class="intel-chip"><strong>EV</strong> ${humanPrediction.value >= 0 ? "+" : ""}${humanPrediction.value.toFixed(2)}</span>`];
  for (let relativePlayer = 0; relativePlayer < game.numPlayers; relativePlayer += 1) {
    const player = relativePlayer;
    const won = game.round.tricksWon[player];
    const logits = humanPrediction.trickLogits.slice(relativePlayer * 11, relativePlayer * 11 + 11);
    const possible = Array.from({ length: Math.min(won + unresolved, 10) - won + 1 }, (_, index) => won + index);
    const maximum = Math.max(...possible.map((count) => logits[count]));
    const weights = possible.map((count) => Math.exp(logits[count] - maximum));
    const total = weights.reduce((sum, value) => sum + value, 0);
    const expected = possible.reduce((sum, count, index) => sum + count * weights[index] / total, 0);
    const hit = sigmoid(humanPrediction.bidHitLogits[relativePlayer]);
    chips.push(`<span class="intel-chip"><strong>${playerName(player)}</strong> ${expected.toFixed(1)} tricks · bid hit ${Math.round(hit * 100)}%</span>`);
  }
  for (let relativePlayer = 1; relativePlayer < game.numPlayers; relativePlayer += 1) {
    const suitValues = modelSuits.map((suit, suitIndex) => ({
      suit,
      probability: sigmoid(humanPrediction.suitLogits[(relativePlayer - 1) * 4 + suitIndex]),
    }));
    const strongest = suitValues.reduce((best, item) => item.probability > best.probability ? item : best);
    chips.push(`<span class="intel-chip"><strong>P${relativePlayer} holds</strong> ${SUIT_SYMBOL[strongest.suit]} ${Math.round(strongest.probability * 100)}%</span>`);
  }
  dom.intelItems.innerHTML = chips.join("");
}

function render() {
  if (!game) return;
  renderSeats();
  renderTrick();
  renderHumanHand();
  renderBidPanel();
  renderScoreSheet();
  renderRoundPlaque();
  renderIntel();
  if (lastStatus) dom.status.textContent = lastStatus;
}

async function refreshHumanPrediction() {
  if (!game || !agent.session || !["bidding", "playing"].includes(game.round.phase)) {
    humanPrediction = null;
    humanPolicy = null;
    render();
    return;
  }
  if (!dom.probabilityToggle.checked && !dom.oracleToggle.checked) {
    humanPrediction = null;
    humanPolicy = null;
    render();
    return;
  }
  const request = ++predictionRequest;
  try {
    const prediction = await agent.predict(game, 0);
    if (request !== predictionRequest) return;
    humanPrediction = prediction;
    if (game.round.currentPlayer === 0) {
      if (game.round.phase === "bidding") {
        humanPolicy = legalDistribution(prediction.bidLogits, game.legalBids(), difficulty);
      } else {
        humanPolicy = legalDistribution(
          prediction.cardLogits,
          game.legalCards(0).map(modelCardId),
          difficulty,
        );
      }
    } else {
      humanPolicy = null;
    }
    render();
  } catch {
    humanPrediction = null;
    humanPolicy = null;
    dom.intelStrip.hidden = true;
  }
}

async function chooseBotAction(player) {
  if (!agent.session) {
    return game.round.phase === "bidding"
      ? { type: "bid", value: fallbackBid(game, player) }
      : { type: "play", card: fallbackCard(game, player) };
  }
  try {
    const prediction = await agent.predict(game, player);
    if (game.round.phase === "bidding") {
      const distribution = legalDistribution(prediction.bidLogits, game.legalBids(), difficulty);
      return { type: "bid", value: sampleDistribution(distribution) };
    }
    const legal = game.legalCards(player);
    const distribution = legalDistribution(
      prediction.cardLogits,
      legal.map(modelCardId),
      difficulty,
    );
    const choice = sampleDistribution(distribution);
    return { type: "play", card: legal.find((card) => modelCardId(card) === choice) };
  } catch {
    return game.round.phase === "bidding"
      ? { type: "bid", value: fallbackBid(game, player) }
      : { type: "play", card: fallbackCard(game, player) };
  }
}

function showRoundResult() {
  const completed = game.completedRounds.at(-1);
  const humanHit = completed.bids[0] === completed.tricksWon[0];
  dom.roundResult.textContent = humanHit
    ? `Exact! You score ${scoreValue(completed, 0)}.`
    : `Plump — you score 00.`;
  dom.roundSummary.textContent = `You bid ${completed.bids[0]} and won ${completed.tricksWon[0]}. Your running total is ${game.scores[0]}.`;
  dom.roundDialog.hidden = false;
}

function showGameOver() {
  const high = Math.max(...game.scores);
  const winners = game.scores
    .map((score, player) => ({ score, player }))
    .filter((item) => item.score === high)
    .map((item) => playerName(item.player));
  const humanWon = winners.includes("You");
  dom.gameOverTitle.textContent = humanWon ? "You beat the table!" : `${winners.join(" & ")} won.`;
  dom.gameOverSummary.textContent = `Final score: ${game.scores.map((score, player) => `${playerName(player)} ${score}`).join(" · ")}`;
  dom.gameOver.hidden = false;
}

async function continueBots() {
  interactionLocked = true;
  render();
  while (
    game.round.currentPlayer !== 0 &&
    ["bidding", "playing"].includes(game.round.phase)
  ) {
    const player = game.round.currentPlayer;
    const phase = game.round.phase;
    setStatus(`${playerName(player)} is ${phase === "bidding" ? "considering a bid" : "choosing a card"}…`);
    render();
    const action = await chooseBotAction(player);
    await wait(reducedMotion ? 0 : 260);
    if (action.type === "bid") {
      game.bid(action.value);
      setStatus(`${playerName(player)} bids ${action.value}.`);
      render();
      await wait(reducedMotion ? 0 : 180);
    } else {
      const result = game.play(action.card);
      displayedCompletedTrick = result.completedTrick || null;
      setStatus(`${playerName(player)} plays ${cardLabel(action.card)}.`);
      render();
      await wait(reducedMotion ? 0 : result.trickComplete ? 850 : 420);
      if (result.trickComplete) {
        setStatus(`${playerName(result.winner)} takes the trick.`);
        displayedCompletedTrick = null;
        render();
      }
    }
  }
  interactionLocked = false;
  if (game.round.phase === "round_over") {
    setStatus("Round complete. Entered on the score sheet.");
    showRoundResult();
  } else if (game.round.phase === "game_over") {
    setStatus("The score sheet is complete.");
    showGameOver();
  } else if (game.round.currentPlayer === 0) {
    setStatus(game.round.phase === "bidding" ? "Your turn to bid." : "Your turn to play a card.");
  }
  render();
  refreshHumanPrediction();
}

async function beginDeal() {
  dealing = true;
  humanPrediction = null;
  humanPolicy = null;
  setStatus(`Dealing ${game.round.handSize} cards…`);
  render();
  await wait(reducedMotion ? 0 : 720);
  dealing = false;
  setStatus(`Round ${game.roundIndex + 1}. Bidding begins with ${playerName(game.round.biddingStart)}.`);
  render();
  await continueBots();
}

async function playHumanCard(card) {
  if (interactionLocked || game.round.currentPlayer !== 0) return;
  interactionLocked = true;
  humanPrediction = null;
  humanPolicy = null;
  const result = game.play(card);
  displayedCompletedTrick = result.completedTrick || null;
  setStatus(`You play ${cardLabel(card)}.`);
  render();
  await wait(reducedMotion ? 0 : result.trickComplete ? 850 : 340);
  interactionLocked = false;
  if (result.trickComplete) {
    setStatus(`${playerName(result.winner)} takes the trick.`);
    displayedCompletedTrick = null;
  }
  render();
  if (game.round.phase === "round_over") {
    showRoundResult();
  } else if (game.round.phase === "game_over") {
    showGameOver();
  } else {
    await continueBots();
  }
}

function updateLoadProgress(percent, label) {
  const bounded = Math.max(0, Math.min(100, percent));
  dom.modelDownload.hidden = false;
  dom.loadLabel.textContent = label;
  dom.loadPercent.textContent = `${bounded}%`;
  dom.loadProgress.style.width = `${bounded}%`;
  dom.loadingTitle.textContent = label;
  dom.loadingProgress.style.width = `${bounded}%`;
}

async function startGame(form) {
  const data = new FormData(form);
  const maximum = Number(data.get("maxCards"));
  const minimum = Number(data.get("minCards"));
  if (minimum >= maximum) {
    dom.minCards.focus();
    dom.minCards.setCustomValidity("The lower hand must be below the starting hand.");
    dom.minCards.reportValidity();
    return;
  }
  dom.minCards.setCustomValidity("");
  difficulty = Number(data.get("difficulty"));
  dom.gameLoading.hidden = false;
  updateLoadProgress(1, "Waking the agent…");
  let fallback = false;
  try {
    await agent.load(updateLoadProgress);
    dom.modelState.textContent = `Checkpoint 4,000 · ${agent.backend}`;
    dom.modelState.className = "model-state is-ready";
  } catch (error) {
    fallback = true;
    dom.modelState.textContent = "Strategic fallback active";
    dom.modelState.className = "model-state is-fallback";
    dom.loadingCopy.textContent = "The checkpoint could not initialize, so legal strategic bots will stand in.";
    updateLoadProgress(100, "Fallback table ready");
  }
  await wait(reducedMotion ? 0 : 360);
  game = new PlumpGame({
    opponents: Number(data.get("opponents")),
    minimum,
    maximum,
  });
  dom.setup.hidden = true;
  displayedCompletedTrick = null;
  dom.game.hidden = false;
  dom.gameLoading.hidden = true;
  if (fallback) setStatus("Checkpoint unavailable; playing against strategic fallback bots.");
  await beginDeal();
}

dom.setupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  startGame(event.currentTarget);
});

dom.difficulty.addEventListener("input", () => {
  difficulty = Number(dom.difficulty.value);
  dom.difficultyOutput.textContent = difficultyLabel(difficulty);
  refreshHumanPrediction();
});

dom.maxCards.addEventListener("change", () => {
  const maximum = Number(dom.maxCards.value);
  $$('option', dom.minCards).forEach((option) => {
    option.disabled = Number(option.value) >= maximum;
  });
  if (Number(dom.minCards.value) >= maximum) dom.minCards.value = String(Math.max(3, maximum - 1));
});

dom.game.addEventListener("click", (event) => {
  const bidButton = event.target.closest("[data-bid]");
  if (bidButton && !interactionLocked) {
    const value = Number(bidButton.dataset.bid);
    humanPrediction = null;
    humanPolicy = null;
    game.bid(value);
    setStatus(`You bid ${value}.`);
    render();
    continueBots();
    return;
  }
  const cardButton = event.target.closest("[data-play-card]");
  if (cardButton && !cardButton.disabled) {
    const [suit, rank] = cardButton.dataset.playCard.split(":");
    playHumanCard({ suit, rank: Number(rank) });
  }
});

dom.probabilityToggle.addEventListener("change", refreshHumanPrediction);
dom.oracleToggle.addEventListener("change", refreshHumanPrediction);

$("[data-next-round]").addEventListener("click", () => {
  dom.roundDialog.hidden = true;
  game.startNextRound();
  beginDeal();
});

$("[data-new-game]").addEventListener("click", () => {
  predictionRequest += 1;
  dom.game.hidden = true;
  dom.setup.hidden = false;
  dom.roundDialog.hidden = true;
  dom.gameOver.hidden = true;
  game = null;
  window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
});

$("[data-play-again]").addEventListener("click", () => {
  dom.gameOver.hidden = true;
  dom.game.hidden = true;
  dom.setup.hidden = false;
  game = null;
});

$("[data-rules-button]").addEventListener("click", () => dom.rulesDialog.showModal());
$$('[data-close-rules]').forEach((button) =>
  button.addEventListener("click", () => dom.rulesDialog.close()),
);

dom.difficultyOutput.textContent = difficultyLabel(Number(dom.difficulty.value));
