import {
  BrowserPpoAgent,
  modelCardId,
  modelSuits,
} from "./model-client.js?v=68500";
import {
  generateRoomCode,
  normalizeRoomCode,
  PlumpPeerRoom,
  validRoomCode,
} from "./multiplayer.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const wait = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const BOT_THINK_MS = 440;
const CARD_SETTLE_MS = 900;
const TRICK_RESULT_HOLD_MS = 1200;

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
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
})[character]);

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

export class PlumpGame {
  constructor({ opponents, numPlayers, minimum, maximum }) {
    this.numPlayers = numPlayers ?? opponents + 1;
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

function hydrateGame(snapshot) {
  return Object.assign(Object.create(PlumpGame.prototype), snapshot);
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

// The action-probability readout always reports the policy at temperature 1,
// i.e. the distribution the model itself produces. Difficulty warps how the
// opponents *sample* that policy, but the readout is meant to answer "what does
// the model think here", and that question has the same answer whether the
// table is set to random or to argmax.
const INSIGHT_TEMPERATURE = 1;

function legalDistribution(logits, legalIndices, temperature) {
  const argmax = legalIndices.reduce((best, index) =>
    logits[index] > logits[best] ? index : best,
  );
  if (!Number.isFinite(temperature)) {
    return {
      argmax,
      probabilities: new Map(legalIndices.map((index) => [index, 1 / legalIndices.length])),
    };
  }
  if (temperature <= 0) {
    return {
      argmax,
      probabilities: new Map(legalIndices.map((index) => [index, index === argmax ? 1 : 0])),
    };
  }
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
  multiplayerSetup: $("[data-multiplayer-setup]"),
  multiplayerLobby: $("[data-multiplayer-lobby]"),
  hostSettings: $("[data-host-settings]"),
  opponents: $("#opponents"),
  opponentsLabel: $("[data-opponents-label]"),
  playerName: $("#player-name"),
  joinCode: $("#join-code"),
  joinCodeRow: $("[data-join-code-row]"),
  startGame: $("[data-start-game]"),
  startMultiplayer: $("[data-start-multiplayer]"),
  lobbyCodeWrap: $("[data-lobby-code-wrap]"),
  lobbyCode: $("[data-lobby-code]"),
  lobbyStatus: $("[data-lobby-status]"),
  lobbyRoster: $("[data-lobby-roster]"),
  setupError: $("[data-setup-error]"),
  liveTableBadge: $("[data-live-table-badge]"),
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
  beliefToggle: $("[data-belief-toggle]"),
  setupProbabilityToggle: $("[data-setup-probability-toggle]"),
  setupBeliefToggle: $("[data-setup-belief-toggle]"),
  intelStrip: $("[data-intel-strip]"),
  intelTitle: $(".intel-title"),
  intelItems: $("[data-intel-items]"),
  roundDialog: $("[data-round-dialog]"),
  roundResult: $("[data-round-result]"),
  roundSummary: $("[data-round-summary]"),
  gameOver: $("[data-game-over]"),
  gameOverTitle: $("[data-game-over-title]"),
  gameOverSummary: $("[data-game-over-summary]"),
  rulesDialog: $("[data-rules-dialog]"),
  nextRound: $("[data-next-round]"),
  mobileDrawerTabs: $$('[data-mobile-drawer-target]'),
  mobileDrawerClose: $$('[data-mobile-drawer-close]'),
  mobileDrawerBackdrop: $(".mobile-drawer-backdrop"),
  mobileToolsDrawer: $("[data-mobile-tools-drawer]"),
  mobileScoreDrawer: $("[data-mobile-score-drawer]"),
};

const agent = new BrowserPpoAgent();
let game = null;
let difficulty = 33;
let interactionLocked = false;
let dealing = false;
let predictionRequest = 0;
let humanPrediction = null;
let humanPolicy = null;
let beliefLoading = false;
let beliefError = "";
let lastStatus = "";
let displayedCompletedTrick = null;
let gameSequence = 0;
let localPlayer = 0;
let playerNames = [];
let aiPlayers = new Set();
let multiplayer = null;
let multiplayerRole = null;
let multiplayerPhase = "idle";
let hostPeerId = null;
let networkRevision = 0;
let appliedNetworkRevision = -1;
let peerToSeat = new Map();
let seatToPeer = new Map();
let guestNames = new Map();
let insightPreferences = new Map();
const mobileTableQuery = window.matchMedia("(max-width: 600px) and (orientation: portrait)");

function setMobileDrawer(drawer = "", { focus = false } = {}) {
  const activeDrawer = ["tools", "scores"].includes(drawer) ? drawer : "";
  if (activeDrawer) dom.game.dataset.mobileDrawer = activeDrawer;
  else delete dom.game.dataset.mobileDrawer;
  dom.mobileDrawerBackdrop.hidden = !activeDrawer;
  dom.mobileDrawerTabs.forEach((button) => {
    const active = button.dataset.mobileDrawerTarget === activeDrawer;
    button.setAttribute("aria-expanded", String(active));
  });

  const mobile = mobileTableQuery.matches;
  dom.mobileToolsDrawer.inert = mobile && activeDrawer !== "tools";
  dom.mobileScoreDrawer.inert = mobile && activeDrawer !== "scores";
  if (focus && activeDrawer) {
    const drawerElement = activeDrawer === "tools" ? dom.mobileToolsDrawer : dom.mobileScoreDrawer;
    drawerElement.querySelector("[data-mobile-drawer-close]")?.focus();
  }
}

function syncMobileDrawers() {
  if (!mobileTableQuery.matches) {
    delete dom.game.dataset.mobileDrawer;
    dom.mobileDrawerBackdrop.hidden = true;
    dom.mobileDrawerTabs.forEach((button) => button.setAttribute("aria-expanded", "false"));
    dom.mobileToolsDrawer.inert = false;
    dom.mobileScoreDrawer.inert = false;
    return;
  }
  setMobileDrawer(dom.game.dataset.mobileDrawer || "");
}

function cleanPlayerName(value, fallback = "Player") {
  const name = String(value || "").replace(/\s+/g, " ").trim().slice(0, 18);
  return name || fallback;
}

function setSetupError(message = "") {
  dom.setupError.hidden = !message;
  dom.setupError.textContent = message;
}

function selectedPlayMode() {
  return dom.setupForm.elements.playMode.value;
}

function selectedMultiplayerRole() {
  return dom.setupForm.elements.multiplayerRole.value;
}

function setOpponentOptions(mode, preferredValue = null) {
  const previous = preferredValue ?? Number(dom.opponents.value);
  const maximum = mode === "multiplayer" ? Math.max(0, 5 - (1 + guestNames.size)) : 4;
  const minimum = mode === "multiplayer" ? 0 : 2;
  const selected = Math.max(minimum, Math.min(maximum, Number.isFinite(previous) ? previous : 3));
  dom.opponents.innerHTML = Array.from(
    { length: maximum - minimum + 1 },
    (_, index) => {
      const count = minimum + index;
      const noun = mode === "multiplayer" ? "AI opponent" : "opponent";
      return `<option value="${count}"${count === selected ? " selected" : ""}>${count} ${noun}${count === 1 ? "" : "s"}</option>`;
    },
  ).join("");
}

function configureSetupMode() {
  const mode = selectedPlayMode();
  const role = selectedMultiplayerRole();
  const multiplayerMode = mode === "multiplayer";
  const joiningTable = multiplayerMode && role === "guest";
  dom.multiplayerSetup.hidden = !multiplayerMode;
  dom.joinCodeRow.hidden = !joiningTable;
  dom.joinCode.disabled = !joiningTable;
  dom.joinCode.required = joiningTable;
  if (!joiningTable) dom.joinCode.value = "";
  dom.hostSettings.hidden = multiplayerMode && role === "guest";
  dom.opponentsLabel.textContent = multiplayerMode ? "AI opponents" : "Opponents";
  if (multiplayerPhase === "idle") {
    setOpponentOptions(mode);
    dom.startGame.textContent = !multiplayerMode
      ? "Load agent & start game"
      : role === "host"
        ? "Create multiplayer table"
        : "Join multiplayer table";
  }
  setSetupError();
}

function currentLobbyRoster() {
  const hostName = cleanPlayerName(dom.playerName.value, "Host");
  return [hostName, ...guestNames.values()];
}

function renderLobby({ hostName, guests = [], aiCount = 0, status = "" } = {}) {
  const humans = [hostName, ...guests].filter(Boolean);
  const rows = [
    ...humans.map((name, index) => ({
      name,
      kind: index === 0 ? "Host" : "Friend",
    })),
    ...Array.from({ length: aiCount }, (_, index) => ({
      name: `Agent ${humans.length + index + 1}`,
      kind: "AI",
    })),
  ];
  dom.lobbyRoster.innerHTML = rows
    .map((item) => `<li><span>${escapeHtml(item.name)}</span><span>${item.kind}</span></li>`)
    .join("");
  dom.lobbyStatus.textContent = status;
}

function updateHostLobby() {
  if (!isHost() || multiplayerPhase !== "lobby") return;
  setOpponentOptions("multiplayer", Number(dom.opponents.value));
  const roster = currentLobbyRoster();
  const aiCount = Number(dom.opponents.value);
  const hasFriend = guestNames.size > 0;
  const totalPlayers = roster.length + aiCount;
  dom.startMultiplayer.hidden = false;
  dom.startMultiplayer.disabled = !hasFriend || totalPlayers > 5;
  renderLobby({
    hostName: roster[0],
    guests: roster.slice(1),
    aiCount,
    status: hasFriend
      ? `${roster.length} human player${roster.length === 1 ? "" : "s"} connected · ${totalPlayers}/5 seats filled.`
      : "Share the code with at least one friend. The game can start when they appear here.",
  });
  broadcastLobby();
}

async function broadcastLobby(target = null) {
  if (!isHost() || !multiplayer || multiplayerPhase !== "lobby") return;
  const roster = currentLobbyRoster();
  await multiplayer.send({
    type: "lobby",
    code: multiplayer.code,
    hostName: roster[0],
    guests: roster.slice(1),
    aiCount: Number(dom.opponents.value),
  }, target).catch(() => {});
}

function redactedGameFor(player) {
  const snapshot = JSON.parse(JSON.stringify(game));
  snapshot.round.hands = snapshot.round.hands.map((hand, index) =>
    index === player ? hand : hand.map(() => null),
  );
  snapshot.round.initialHands = snapshot.round.initialHands.map((hand, index) =>
    index === player ? hand : hand.map(() => null),
  );
  return snapshot;
}

function statePacketFor(player) {
  return {
    type: "state",
    revision: networkRevision,
    localPlayer: player,
    game: redactedGameFor(player),
    playerNames,
    aiPlayers: [...aiPlayers],
    status: lastStatus,
    dealing,
    displayedCompletedTrick,
    difficulty,
    code: multiplayer?.code || "",
  };
}

async function sendGameState(peerId, player) {
  if (!isHost() || !multiplayer || !game) return;
  await multiplayer.send(statePacketFor(player), peerId).catch(() => {});
}

async function broadcastGameState() {
  if (!isHost() || !multiplayer || !game) return;
  networkRevision += 1;
  await Promise.all(
    [...seatToPeer.entries()].map(([seat, peerId]) => sendGameState(peerId, seat)),
  );
  for (const peerId of insightPreferences.keys()) sendHostInsights(peerId);
}

function serializePolicy(policy) {
  if (!policy) return null;
  return {
    argmax: policy.argmax,
    probabilities: [...policy.probabilities.entries()],
  };
}

function deserializePolicy(policy) {
  if (!policy) return null;
  return {
    argmax: policy.argmax,
    probabilities: new Map(policy.probabilities),
  };
}

function serializeActorBeliefs(prediction) {
  if (!prediction) return null;
  return {
    value: Number(prediction.value),
    trickLogits: Array.from(prediction.trickLogits),
    suitLogits: Array.from(prediction.suitLogits),
    rankBoundaryLogits: Array.from(prediction.rankBoundaryLogits),
    nextWinnerLogits: Array.from(prediction.nextWinnerLogits),
    playerValues: Array.from(prediction.playerValues),
  };
}

async function sendHostInsights(peerId) {
  if (!isHost() || !game || !agent.session || !peerToSeat.has(peerId)) return;
  const preferences = insightPreferences.get(peerId);
  if (!preferences || (!preferences.action && !preferences.beliefs)) return;
  const seat = peerToSeat.get(peerId);
  if (seat === undefined || !["bidding", "playing"].includes(game.round.phase)) return;
  const revision = networkRevision;
  try {
    const prediction = await agent.predict(game, seat);
    let policy = null;
    if (preferences.action && game.round.currentPlayer === seat) {
      policy = game.round.phase === "bidding"
        ? legalDistribution(prediction.bidLogits, game.legalBids(), INSIGHT_TEMPERATURE)
        : legalDistribution(
          prediction.cardLogits,
          game.legalCards(seat).map(modelCardId),
          INSIGHT_TEMPERATURE,
        );
    }
    if (revision !== networkRevision) return;
    await multiplayer.send({
      type: "insights",
      revision,
      policy: serializePolicy(policy),
      prediction: preferences.beliefs ? serializeActorBeliefs(prediction) : null,
    }, peerId);
  } catch (error) {
    if (revision !== networkRevision) return;
    await multiplayer.send({
      type: "insight_error",
      revision,
      message: preferences.beliefs
        ? "The host could not produce the actor belief readout for this turn."
        : "The host could not produce action probabilities for this turn.",
    }, peerId).catch(() => {});
    console.error("Host insight inference failed.", error);
  }
}

function requestRemoteInsights() {
  if (multiplayerRole !== "guest" || !multiplayer || !hostPeerId || !game) return;
  predictionRequest += 1;
  humanPrediction = null;
  humanPolicy = null;
  beliefError = "";
  beliefLoading = dom.beliefToggle.checked;
  render();
  multiplayer.send({
    type: "insight_preferences",
    action: dom.probabilityToggle.checked,
    beliefs: dom.beliefToggle.checked,
    revision: appliedNetworkRevision,
  }, hostPeerId).catch(() => {
    beliefLoading = false;
    beliefError = "The host connection was interrupted.";
    render();
  });
}

function applyNetworkState(message) {
  if (message.revision < appliedNetworkRevision) return;
  const firstState = multiplayerPhase !== "playing";
  appliedNetworkRevision = message.revision;
  networkRevision = message.revision;
  localPlayer = message.localPlayer;
  playerNames = message.playerNames;
  aiPlayers = new Set(message.aiPlayers);
  game = hydrateGame(message.game);
  difficulty = message.difficulty;
  lastStatus = message.status;
  dealing = message.dealing;
  displayedCompletedTrick = message.displayedCompletedTrick;
  interactionLocked = false;
  multiplayerPhase = "playing";
  if (firstState) gameSequence += 1;
  invalidatePredictionReadouts();
  dom.setup.hidden = true;
  dom.gameLoading.hidden = true;
  dom.game.hidden = false;
  dom.liveTableBadge.hidden = false;
  dom.liveTableBadge.textContent = `Live table · ${message.code}`;
  dom.modelState.textContent = "Host inference connected";
  dom.modelState.className = "model-state is-ready";
  dom.roundDialog.hidden = true;
  dom.gameOver.hidden = true;
  render();
  if (game.round.phase === "round_over") showRoundResult();
  if (game.round.phase === "game_over") showGameOver();
  if (dom.probabilityToggle.checked || dom.beliefToggle.checked) requestRemoteInsights();
}

function applyRemoteInsights(message) {
  if (message.revision !== appliedNetworkRevision) return;
  humanPolicy = deserializePolicy(message.policy);
  humanPrediction = message.prediction;
  beliefLoading = false;
  beliefError = "";
  render();
}

async function handleRemotePlayerAction(message, peerId) {
  if (!isHost() || multiplayerPhase !== "playing" || interactionLocked) return;
  const player = peerToSeat.get(peerId);
  if (player === undefined || game.round.currentPlayer !== player) {
    if (player !== undefined) sendGameState(peerId, player);
    return;
  }
  interactionLocked = true;
  invalidatePredictionReadouts();
  try {
    if (message.action === "bid" && game.round.phase === "bidding") {
      const value = Number(message.value);
      game.bid(value);
      setStatus(`${statusPlayerName(player)} bids ${value}.`);
      render();
      await broadcastGameState();
      await wait(reducedMotion ? 0 : 180);
    } else if (message.action === "play" && game.round.phase === "playing") {
      const card = { suit: message.card?.suit, rank: Number(message.card?.rank) };
      const result = game.play(card);
      displayedCompletedTrick = result.completedTrick || null;
      setStatus(`${statusPlayerName(player)} plays ${cardLabel(card)}.`);
      render();
      await broadcastGameState();
      await settlePlayedCard(result);
    } else {
      throw new Error("The remote action does not match the current phase.");
    }
  } catch (error) {
    console.warn("Rejected an invalid remote move.", error);
    await sendGameState(peerId, player);
  }
  interactionLocked = false;
  if (game.round.phase === "round_over") {
    setStatus("Round complete. Entered on the score sheet.");
    showRoundResult();
    render();
    await broadcastGameState();
  } else if (game.round.phase === "game_over") {
    setStatus("The score sheet is complete.");
    showGameOver();
    render();
    await broadcastGameState();
  } else {
    await continueBots();
  }
}

function handleNetworkMessage(message, peerId) {
  if (!message || typeof message !== "object") return;
  if (isHost()) {
    if (message.type === "join_request") {
      if (multiplayerPhase !== "lobby") {
        multiplayer.send({ type: "rejected", message: "That table has already started." }, peerId).catch(() => {});
        return;
      }
      if (!guestNames.has(peerId) && guestNames.size >= 4) {
        multiplayer.send({ type: "rejected", message: "That table is full." }, peerId).catch(() => {});
        return;
      }
      guestNames.set(peerId, cleanPlayerName(message.name));
      updateHostLobby();
      return;
    }
    if (message.type === "player_action") {
      handleRemotePlayerAction(message, peerId);
      return;
    }
    if (message.type === "insight_preferences") {
      insightPreferences.set(peerId, {
        action: Boolean(message.action),
        beliefs: Boolean(message.beliefs),
      });
      sendHostInsights(peerId);
    }
    return;
  }

  if (message.type === "host_hello") {
    if (hostPeerId && hostPeerId !== peerId) return;
    hostPeerId = peerId;
    multiplayer.send({
      type: "join_request",
      name: cleanPlayerName(dom.playerName.value),
    }, hostPeerId).catch(() => {});
    return;
  }
  if (peerId !== hostPeerId) return;
  if (message.type === "lobby") {
    multiplayerPhase = "lobby";
    dom.lobbyCode.textContent = message.code;
    renderLobby({
      hostName: message.hostName,
      guests: message.guests,
      aiCount: message.aiCount,
      status: "Connected. Waiting for the host to deal.",
    });
    return;
  }
  if (message.type === "starting") {
    multiplayerPhase = "starting";
    dom.lobbyStatus.textContent = "The host is loading the agent and preparing the deal…";
    return;
  }
  if (message.type === "state") {
    applyNetworkState(message);
    return;
  }
  if (message.type === "insights") {
    applyRemoteInsights(message);
    return;
  }
  if (message.type === "insight_error" && message.revision === appliedNetworkRevision) {
    beliefLoading = false;
    beliefError = message.message;
    render();
    return;
  }
  if (message.type === "rejected" || message.type === "table_closed") {
    setSetupError(message.message || "The host closed this table.");
    leaveMultiplayer({ preserveError: true });
  }
}

function handlePeerJoin(peerId) {
  if (isHost()) {
    multiplayer.send({ type: "host_hello" }, peerId).catch(() => {});
  }
}

function handlePeerLeave(peerId) {
  if (isHost()) {
    if (["lobby", "starting"].includes(multiplayerPhase)) {
      guestNames.delete(peerId);
      if (multiplayerPhase === "lobby") updateHostLobby();
      return;
    }
    const seat = peerToSeat.get(peerId);
    if (seat !== undefined) {
      const disconnectedName = publicPlayerName(seat);
      peerToSeat.delete(peerId);
      seatToPeer.delete(seat);
      insightPreferences.delete(peerId);
      aiPlayers.add(seat);
      playerNames[seat] = `Agent ${seat + 1}`;
      setStatus(`${disconnectedName} disconnected; AI has taken over that seat.`);
      render();
      broadcastGameState().then(() => continueBots());
    }
    return;
  }
  if (peerId === hostPeerId) {
    setSetupError("The host left, so the multiplayer table has closed.");
    leaveMultiplayer({ preserveError: true });
  }
}

function handleNetworkError(message) {
  if (multiplayerPhase === "playing") {
    setStatus(message);
    render();
  } else {
    setSetupError(message);
  }
}

function invalidatePredictionReadouts() {
  predictionRequest += 1;
  humanPrediction = null;
  humanPolicy = null;
  beliefLoading = false;
  beliefError = "";
}

function setStatus(message) {
  lastStatus = message;
  dom.status.textContent = message;
}

function isMultiplayer() {
  return multiplayerRole === "host" || multiplayerRole === "guest";
}

function isHost() {
  return multiplayerRole === "host";
}

function isAiPlayer(player) {
  return aiPlayers.has(player);
}

function viewOffset(player) {
  if (!game) return player;
  return (player - localPlayer + game.numPlayers) % game.numPlayers;
}

function publicPlayerName(player) {
  if (playerNames[player]) return playerNames[player];
  return isAiPlayer(player) ? `Agent ${player + 1}` : `Player ${player + 1}`;
}

function playerName(player) {
  return player === localPlayer ? "You" : publicPlayerName(player);
}

function statusPlayerName(player) {
  return isHost() ? publicPlayerName(player) : playerName(player);
}

function playerBid(player) {
  return game.round.bids.find((item) => item.player === player)?.value;
}

function renderSeats() {
  dom.table.className = `table-felt players-${game.numPlayers}`;
  dom.seats.innerHTML = Array.from({ length: game.numPlayers - 1 }, (_, offset) => {
    const seatOffset = offset + 1;
    const player = (localPlayer + seatOffset) % game.numPlayers;
    const hand = game.round.hands[player];
    const bid = playerBid(player);
    const isCurrent = game.round.currentPlayer === player;
    const seatState = isCurrent ? (isAiPlayer(player) ? "thinking" : "turn") : (isAiPlayer(player) ? "AI" : "PLAYER");
    const backs = hand
      .map(
        (_, index) =>
          `<span class="opponent-card${dealing ? " is-dealing" : ""}" style="animation-delay:${index * 42}ms"></span>`,
      )
      .join("");
    return `
      <div class="seat seat-player-${seatOffset}${isCurrent ? " is-current" : ""}">
        <div class="seat-name"><span>${escapeHtml(playerName(player))}</span><span>${seatState}</span></div>
        <div class="opponent-hand" aria-label="${hand.length} hidden cards">${backs}</div>
        <div class="seat-stats"><span>bid ${bid ?? "—"}</span><span>tricks ${game.round.tricksWon[player]}</span><span>Σ ${game.scores[player]}</span></div>
      </div>
    `;
  }).join("");
}

function playOrigin(player) {
  const position = viewOffset(player);
  if (position === 0) return { x: "0px", y: "230px" };
  const origins = {
    2: {
      1: { x: "0px", y: "-210px" },
    },
    3: {
      1: { x: "-250px", y: "-30px" },
      2: { x: "250px", y: "-30px" },
    },
    4: {
      1: { x: "-250px", y: "-30px" },
      2: { x: "0px", y: "-210px" },
      3: { x: "250px", y: "-30px" },
    },
    5: {
      1: { x: "-250px", y: "20px" },
      2: { x: "-105px", y: "-210px" },
      3: { x: "105px", y: "-210px" },
      4: { x: "250px", y: "20px" },
    },
  };
  return origins[game.numPlayers]?.[position] || { x: "0px", y: "-210px" };
}

function renderTrick() {
  const trick = displayedCompletedTrick || game.round.tricks.at(-1);
  if (!trick) {
    dom.trickZone.replaceChildren();
    delete dom.trickZone.dataset.trickKey;
    return;
  }

  const trickKey = `${gameSequence}:${game.roundIndex}:${trick.trickIndex}`;
  if (dom.trickZone.dataset.trickKey !== trickKey) {
    dom.trickZone.replaceChildren();
    dom.trickZone.dataset.trickKey = trickKey;
  }

  const activePositions = new Set();
  trick.plays.forEach((play) => {
    const position = String(play.position);
    activePositions.add(position);
    let card = dom.trickZone.querySelector(`[data-play-position="${position}"]`);
    if (!card) {
      const origin = playOrigin(play.player);
      card = document.createElement("div");
      card.className = `trick-card trick-card-player-${viewOffset(play.player)}`;
      card.dataset.playPosition = position;
      card.setAttribute("role", "img");
      card.setAttribute(
        "aria-label",
        `${playerName(play.player)} played ${cardLabel(play.card)}${play.position === 0 ? ", leading card" : ""}`,
      );
      card.style.setProperty("--from-x", origin.x);
      card.style.setProperty("--from-y", origin.y);
      const image = document.createElement("img");
      image.src = cardAsset(play.card);
      image.alt = "";
      card.append(image);
      dom.trickZone.append(card);
    }
    card.classList.toggle("is-lead", play.position === 0);
    card.classList.toggle("is-winner", trick.winner === play.player);
  });

  $$(".trick-card", dom.trickZone).forEach((card) => {
    if (!activePositions.has(card.dataset.playPosition)) card.remove();
  });
}

function policyBadge(index) {
  if (!dom.probabilityToggle.checked || !humanPolicy) return "";
  const probability = humanPolicy.probabilities.get(index);
  if (probability === undefined) return "";
  const best = humanPolicy.argmax === index ? '<span class="argmax-mark" title="Model argmax">★</span>' : "";
  return `${best}<span class="prob-badge">${Math.round(probability * 100)}%</span>`;
}

function renderHumanHand() {
  const hand = sortHand(game.round.hands[localPlayer]);
  const humanTurn = game.round.currentPlayer === localPlayer && game.round.phase === "playing";
  const legal = new Set((humanTurn ? game.legalCards(localPlayer) : []).map(cardKey));
  const bid = playerBid(localPlayer);
  dom.humanLabel.classList.toggle("is-current", game.round.currentPlayer === localPlayer);
  dom.humanLabel.textContent = `You · bid ${bid ?? "—"} · tricks ${game.round.tricksWon[localPlayer]} · total ${game.scores[localPlayer]}`;
  const activeCards = new Set(hand.map(cardKey));

  $$('[data-play-card]', dom.humanHand).forEach((button) => {
    if (!activeCards.has(button.dataset.playCard)) button.remove();
  });

  hand.forEach((card, index) => {
    const key = cardKey(card);
    const allowed = legal.has(key);
    const unavailable = humanTurn && !allowed;
    const disabled = !humanTurn || unavailable || interactionLocked;
    let button = dom.humanHand.querySelector(`[data-play-card="${key}"]`);

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.dataset.playCard = key;
      const image = document.createElement("img");
      image.src = cardAsset(card);
      image.alt = "";
      button.append(image);
    }

    button.className = `hand-card-button${unavailable ? " is-illegal" : ""}${dealing ? " is-dealing" : ""}`;
    button.disabled = disabled;
    button.style.animationDelay = `${index * 48}ms`;
    button.setAttribute(
      "aria-label",
      `Play ${cardLabel(card)}${unavailable ? ", unavailable" : ""}`,
    );
    $$(".prob-badge, .argmax-mark", button).forEach((marker) => marker.remove());
    button.insertAdjacentHTML("beforeend", policyBadge(modelCardId(card)));

    const cardAtPosition = dom.humanHand.children[index];
    if (cardAtPosition !== button) {
      dom.humanHand.insertBefore(button, cardAtPosition || null);
    }
  });
}

function renderBidPanel() {
  const humanTurn = game.round.currentPlayer === localPlayer && game.round.phase === "bidding";
  dom.bidPanel.hidden = !humanTurn;
  if (!humanTurn) return;
  const legal = new Set(game.legalBids());
  const values = Array.from({ length: game.round.handSize + 1 }, (_, value) => value);
  const existing = game.round.bids.reduce((sum, item) => sum + item.value, 0);
  dom.bidPrompt.textContent = game.round.bids.length === game.numPlayers - 1
    ? `Last bid: the table has ${existing}. One value is forbidden.`
    : `How many of the ${game.round.handSize} tricks will you win?`;
  dom.bidOptions.innerHTML = values
    .map(
      (value) => {
        const forbidden = !legal.has(value);
        const disabled = forbidden || interactionLocked;
        const description = forbidden
          ? `Bid ${value} is unavailable because the total bids would equal the number of tricks.`
          : `Bid ${value}`;
        return `
        <button
          class="bid-button${forbidden ? " is-forbidden" : ""}"
          type="button"
          data-bid="${value}"
          ${disabled ? "disabled" : ""}
          aria-label="${description}"
          title="${description}"
        >
          ${value}${policyBadge(value)}
        </button>
      `;
      },
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
    `<th scope="col">${escapeHtml(playerName(player))}</th>`,
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
  const trick = displayedCompletedTrick || game.round.tricks.at(-1);
  const trickNumber = game.round.phase === "bidding" ? "Bidding" : `Trick ${Math.min((trick?.trickIndex || 0) + 1, game.round.handSize)} / ${game.round.handSize}`;
  dom.roundPlaque.innerHTML = `<strong>Round ${game.roundIndex + 1} / ${game.schedule.length}</strong>${game.round.handSize} cards · ${trickNumber}`;
}

function relativePlayerIndex(player) {
  return (player - localPlayer + game.numPlayers) % game.numPlayers;
}

function normalizedProbabilities(logits) {
  const maximum = Math.max(...logits);
  const weights = logits.map((logit) => Math.exp(logit - maximum));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

function signedValue(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function topFinalTrickProbabilities(player) {
  const completedTricks = game.round.tricks.filter((trick) => trick.winner !== null).length;
  const unresolved = game.round.handSize - completedTricks;
  const won = game.round.tricksWon[player];
  const relativePlayer = relativePlayerIndex(player);
  const logits = humanPrediction.trickLogits.slice(
    relativePlayer * 11,
    relativePlayer * 11 + 11,
  );
  const counts = Array.from(
    { length: Math.min(won + unresolved, 10) - won + 1 },
    (_, index) => won + index,
  );
  const maximum = Math.max(...counts.map((count) => logits[count]));
  const weighted = counts.map((count) => ({
    count,
    weight: Math.exp(logits[count] - maximum),
  }));
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  return weighted
    .map((item) => ({ count: item.count, probability: item.weight / total }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 3);
}

function suitPresenceProbabilities(player) {
  if (player === localPlayer) {
    return modelSuits.map((suit) => ({
      suit,
      probability: game.round.hands[localPlayer].some((card) => card.suit === suit) ? 1 : 0,
    }));
  }
  if (!humanPrediction) return null;
  const relativePlayer = relativePlayerIndex(player);
  if (relativePlayer === 0) return null;
  return modelSuits.map((suit, suitIndex) => ({
    suit,
    probability: sigmoid(humanPrediction.suitLogits[(relativePlayer - 1) * 4 + suitIndex]),
  }));
}

function rankBoundaryProbabilities(player = null) {
  if (!humanPrediction) return null;
  const boundaryRows = humanPrediction.rankBoundaryLogits.length / (4 * 2);
  const row = player === null ? boundaryRows - 1 : relativePlayerIndex(player) - 1;
  if (row < 0) return null;
  const heldSuits = new Set(game.round.hands[localPlayer].map((card) => card.suit));
  return modelSuits
    .map((suit, suitIndex) => ({
      suit,
      lower: sigmoid(humanPrediction.rankBoundaryLogits[(row * 4 + suitIndex) * 2]),
      higher: sigmoid(humanPrediction.rankBoundaryLogits[(row * 4 + suitIndex) * 2 + 1]),
    }))
    .filter((item) => heldSuits.has(item.suit));
}

function renderProbabilityBadges(items) {
  return items
    .map((item) => `<span class="belief-prob"><strong>${item.label}</strong> ${Math.round(item.probability * 100)}%</span>`)
    .join("");
}

function renderSuitBadges(items) {
  return items
    .map((item) => {
      const red = ["hearts", "diamonds"].includes(item.suit) ? " is-red" : "";
      return `<span class="belief-suit${red}">${SUIT_SYMBOL[item.suit]} ${Math.round(item.probability * 100)}%</span>`;
    })
    .join("");
}

function renderRankBounds(items) {
  if (!items?.length) return '<span class="belief-pending">No held suit has a rank boundary.</span>';
  return items
    .map((item) => {
      const red = ["hearts", "diamonds"].includes(item.suit) ? " is-red" : "";
      return `<span class="belief-bound${red}">${SUIT_SYMBOL[item.suit]} <em>↓</em>${Math.round(item.lower * 100)}% <em>↑</em>${Math.round(item.higher * 100)}%</span>`;
    })
    .join("");
}

function renderIntel() {
  const visible = dom.beliefToggle.checked;
  dom.intelStrip.hidden = !visible;
  if (!visible) return;
  dom.intelTitle.textContent = "Actor belief heads";

  if (beliefLoading) {
    dom.intelItems.innerHTML = '<span class="belief-message">Reading the actor belief heads…</span>';
    return;
  }
  if (beliefError) {
    dom.intelItems.innerHTML = `<span class="belief-message is-error">${escapeHtml(beliefError)}</span>`;
    return;
  }
  if (!humanPrediction) {
    dom.intelItems.innerHTML = '<span class="belief-message">Actor beliefs are available during bidding and play.</span>';
    return;
  }

  const nextWinnerProbabilities = game.round.phase === "playing"
    ? normalizedProbabilities(humanPrediction.nextWinnerLogits.slice(0, game.numPlayers))
    : null;
  const summary = `
    <section class="belief-summary" aria-label="Actor table-level readout">
      <header><strong>Your actor · table view</strong><span>Policy value ${signedValue(humanPrediction.value)}</span></header>
      <div class="belief-line"><b>Any opponent beyond your ranks</b><span class="belief-values">${renderRankBounds(rankBoundaryProbabilities())}</span></div>
      <div class="belief-line"><b>Rank key</b><span class="belief-note">↓ holds a card below your lowest; ↑ holds one above your highest in that suit.</span></div>
      <div class="belief-line"><b>Policy heads</b><span class="belief-note">Bid and card probabilities appear on legal actions when Action probabilities is enabled.</span></div>
    </section>
  `;
  const players = Array.from({ length: game.numPlayers }, (_, player) => {
    const relativePlayer = relativePlayerIndex(player);
    const topTricks = topFinalTrickProbabilities(player)
      .map((item) => ({ label: item.count, probability: item.probability }));
    const nextWinner = nextWinnerProbabilities
      ? `${Math.round(nextWinnerProbabilities[relativePlayer] * 100)}%`
      : "After bidding";
    const rankBounds = player === localPlayer
      ? '<span class="belief-pending">Visible hand; no opponent-bound row.</span>'
      : renderRankBounds(rankBoundaryProbabilities(player));
    return `
      <section class="belief-player" aria-label="${escapeHtml(playerName(player))} actor belief readout">
        <header><strong>${escapeHtml(playerName(player))}</strong><span>Actor EV ${signedValue(humanPrediction.playerValues[relativePlayer])}</span></header>
        <div class="belief-line"><b>Final tricks · top 3</b><span class="belief-values">${renderProbabilityBadges(topTricks)}</span></div>
        <div class="belief-line"><b>Next trick winner</b><span class="belief-values"><span class="belief-prob"><strong>${nextWinner}</strong></span></span></div>
        <div class="belief-line"><b>${player === localPlayer ? "Known suits" : "Suit presence"}</b><span class="belief-values">${renderSuitBadges(suitPresenceProbabilities(player))}</span></div>
        <div class="belief-line"><b>Outside your ranks</b><span class="belief-values">${rankBounds}</span></div>
      </section>
    `;
  }).join("");
  dom.intelItems.innerHTML = summary + players;
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
  if (multiplayerRole === "guest") {
    requestRemoteInsights();
    return;
  }
  if (!game || !agent.session || !["bidding", "playing"].includes(game.round.phase)) {
    predictionRequest += 1;
    humanPrediction = null;
    humanPolicy = null;
    beliefLoading = false;
    beliefError = "";
    render();
    return;
  }
  if (!dom.probabilityToggle.checked && !dom.beliefToggle.checked) {
    predictionRequest += 1;
    humanPrediction = null;
    humanPolicy = null;
    beliefLoading = false;
    beliefError = "";
    render();
    return;
  }
  const request = ++predictionRequest;
  beliefLoading = dom.beliefToggle.checked;
  beliefError = "";
  render();
  try {
    const prediction = await agent.predict(game, localPlayer);
    if (request !== predictionRequest) return;
    humanPrediction = prediction;
    beliefLoading = false;
    if (game.round.currentPlayer === localPlayer) {
      if (game.round.phase === "bidding") {
        humanPolicy = legalDistribution(
          prediction.bidLogits,
          game.legalBids(),
          INSIGHT_TEMPERATURE,
        );
      } else {
        humanPolicy = legalDistribution(
          prediction.cardLogits,
          game.legalCards(localPlayer).map(modelCardId),
          INSIGHT_TEMPERATURE,
        );
      }
    } else {
      humanPolicy = null;
    }
    render();
  } catch (error) {
    if (request !== predictionRequest) return;
    console.error("Actor belief inference failed.", error);
    humanPrediction = null;
    humanPolicy = null;
    beliefLoading = false;
    beliefError = dom.beliefToggle.checked
      ? "The actor belief readout hit a temporary inference error. Toggle it off and on to retry."
      : "";
    render();
  }
}

async function refreshPredictions() {
  await refreshHumanPrediction();
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
      const distribution = legalDistribution(
        prediction.bidLogits,
        game.legalBids(),
        temperatureFor(difficulty),
      );
      return { type: "bid", value: sampleDistribution(distribution) };
    }
    const legal = game.legalCards(player);
    const distribution = legalDistribution(
      prediction.cardLogits,
      legal.map(modelCardId),
      temperatureFor(difficulty),
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
  const humanHit = completed.bids[localPlayer] === completed.tricksWon[localPlayer];
  dom.roundResult.textContent = humanHit
    ? `Exact! You score ${scoreValue(completed, localPlayer)}.`
    : `Plump — you score 00.`;
  dom.roundSummary.textContent = `You bid ${completed.bids[localPlayer]} and won ${completed.tricksWon[localPlayer]}. Your running total is ${game.scores[localPlayer]}.`;
  dom.nextRound.disabled = isMultiplayer() && !isHost();
  dom.nextRound.textContent = dom.nextRound.disabled ? "Waiting for host…" : "Deal next round";
  dom.roundDialog.hidden = false;
}

function showGameOver() {
  const high = Math.max(...game.scores);
  const winners = game.scores
    .map((score, player) => ({ score, player }))
    .filter((item) => item.score === high)
    .map((item) => playerName(item.player));
  const humanWon = winners.some((winner) => winner === "You");
  dom.gameOverTitle.textContent = humanWon ? "You beat the table!" : `${winners.join(" & ")} won.`;
  dom.gameOverSummary.textContent = `Final score: ${game.scores.map((score, player) => `${playerName(player)} ${score}`).join(" · ")}`;
  dom.gameOver.hidden = false;
}

async function continueBots() {
  if (multiplayerRole === "guest") return;
  interactionLocked = true;
  render();
  while (
    isAiPlayer(game.round.currentPlayer) &&
    ["bidding", "playing"].includes(game.round.phase)
  ) {
    const player = game.round.currentPlayer;
    const phase = game.round.phase;
    setStatus(`${statusPlayerName(player)} is ${phase === "bidding" ? "considering a bid" : "choosing a card"}…`);
    render();
    const action = await chooseBotAction(player);
    await wait(reducedMotion ? 0 : BOT_THINK_MS);
    invalidatePredictionReadouts();
    if (action.type === "bid") {
      game.bid(action.value);
      setStatus(`${statusPlayerName(player)} bids ${action.value}.`);
      render();
      await broadcastGameState();
      await wait(reducedMotion ? 0 : 180);
    } else {
      const result = game.play(action.card);
      displayedCompletedTrick = result.completedTrick || null;
      setStatus(`${statusPlayerName(player)} plays ${cardLabel(action.card)}.`);
      render();
      await broadcastGameState();
      await settlePlayedCard(result);
    }
  }
  interactionLocked = false;
  if (game.round.phase === "round_over") {
    setStatus("Round complete. Entered on the score sheet.");
    showRoundResult();
  } else if (game.round.phase === "game_over") {
    setStatus("The score sheet is complete.");
    showGameOver();
  } else if (game.round.currentPlayer === localPlayer) {
    setStatus(isHost()
      ? `${publicPlayerName(localPlayer)}'s turn to ${game.round.phase === "bidding" ? "bid" : "play"}.`
      : game.round.phase === "bidding" ? "Your turn to bid." : "Your turn to play a card.");
  } else {
    setStatus(`${statusPlayerName(game.round.currentPlayer)}'s turn to ${game.round.phase === "bidding" ? "bid" : "play"}.`);
  }
  render();
  await broadcastGameState();
  refreshPredictions();
}

async function beginDeal() {
  dealing = true;
  invalidatePredictionReadouts();
  setStatus(`Dealing ${game.round.handSize} cards…`);
  render();
  await broadcastGameState();
  await wait(reducedMotion ? 0 : 720);
  dealing = false;
  setStatus(`Round ${game.roundIndex + 1}. Bidding begins with ${statusPlayerName(game.round.biddingStart)}.`);
  render();
  await broadcastGameState();
  await continueBots();
}

async function playHumanCard(card) {
  if (interactionLocked || game.round.currentPlayer !== localPlayer) return;
  if (multiplayerRole === "guest") {
    interactionLocked = true;
    render();
    try {
      await multiplayer.send({ type: "player_action", action: "play", card }, hostPeerId);
    } catch {
      interactionLocked = false;
      setStatus("The play did not reach the host. Try again.");
      render();
    }
    return;
  }
  interactionLocked = true;
  invalidatePredictionReadouts();
  const result = game.play(card);
  displayedCompletedTrick = result.completedTrick || null;
  setStatus(`${statusPlayerName(localPlayer)} plays ${cardLabel(card)}.`);
  render();
  await broadcastGameState();
  await settlePlayedCard(result);
  interactionLocked = false;
  render();
  if (game.round.phase === "round_over") {
    showRoundResult();
    await broadcastGameState();
  } else if (game.round.phase === "game_over") {
    showGameOver();
    await broadcastGameState();
  } else {
    await continueBots();
  }
}

async function settlePlayedCard(result) {
  await wait(reducedMotion ? 0 : CARD_SETTLE_MS);
  if (!result.trickComplete) return;
  setStatus(`${statusPlayerName(result.winner)} takes the trick.`);
  render();
  await broadcastGameState();
  await wait(reducedMotion ? 0 : TRICK_RESULT_HOLD_MS);
  displayedCompletedTrick = null;
  render();
  await broadcastGameState();
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

function validateHandRange(data) {
  const maximum = Number(data.get("maxCards"));
  const minimum = Number(data.get("minCards"));
  if (minimum >= maximum) {
    dom.minCards.focus();
    dom.minCards.setCustomValidity("The lower hand must be below the starting hand.");
    dom.minCards.reportValidity();
    return null;
  }
  dom.minCards.setCustomValidity("");
  return { data, maximum, minimum };
}

async function loadHostAgent() {
  dom.gameLoading.hidden = false;
  updateLoadProgress(1, "Waking the agent…");
  let fallback = false;
  try {
    await agent.load(updateLoadProgress);
    updateLoadProgress(100, `Agent ready · ${agent.backend}`);
    dom.modelState.textContent = `Agent ready · ${agent.backend}`;
    dom.modelState.className = "model-state is-ready";
  } catch (error) {
    fallback = true;
    dom.modelState.textContent = "Strategic fallback active";
    dom.modelState.className = "model-state is-fallback";
    dom.loadingCopy.textContent = "The checkpoint could not initialize, so legal strategic bots will stand in.";
    updateLoadProgress(100, "Fallback table ready");
  }
  await wait(reducedMotion ? 0 : 360);
  return fallback;
}

async function startSoloGame(form) {
  const settings = validateHandRange(new FormData(form));
  if (!settings) return;
  const { data, maximum, minimum } = settings;
  difficulty = Number(data.get("difficulty"));
  localPlayer = 0;
  multiplayerRole = null;
  multiplayerPhase = "idle";
  const opponents = Number(data.get("opponents"));
  playerNames = ["You", ...Array.from({ length: opponents }, (_, index) => `Agent ${index + 2}`)];
  aiPlayers = new Set(Array.from({ length: opponents }, (_, index) => index + 1));
  dom.liveTableBadge.hidden = true;
  const fallback = await loadHostAgent();
  gameSequence += 1;
  game = new PlumpGame({
    opponents,
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

async function openMultiplayerLobby(form) {
  setSetupError();
  const role = selectedMultiplayerRole();
  const playerName = cleanPlayerName(dom.playerName.value, role === "host" ? "Host" : "Player");
  dom.playerName.value = playerName;
  try {
    localStorage.setItem("plump-player-name", playerName);
  } catch {}
  const code = role === "host" ? generateRoomCode() : normalizeRoomCode(dom.joinCode.value);
  if (!validRoomCode(code)) {
    dom.joinCode.focus();
    setSetupError("Enter the complete 8-character table code.");
    return;
  }
  dom.startGame.disabled = true;
  dom.startGame.textContent = role === "host" ? "Opening table…" : "Finding table…";
  $$('input[name="playMode"], input[name="multiplayerRole"]').forEach((input) => {
    input.disabled = true;
  });
  multiplayerRole = role;
  multiplayerPhase = "connecting";
  hostPeerId = null;
  guestNames = new Map();
  peerToSeat = new Map();
  seatToPeer = new Map();
  insightPreferences = new Map();
  multiplayer = new PlumpPeerRoom({
    role,
    code,
    onMessage: handleNetworkMessage,
    onPeerJoin: handlePeerJoin,
    onPeerLeave: handlePeerLeave,
    onError: handleNetworkError,
  });
  try {
    await multiplayer.connect();
  } catch (error) {
    multiplayer = null;
    multiplayerRole = null;
    multiplayerPhase = "idle";
    dom.startGame.disabled = false;
    $$('input[name="playMode"], input[name="multiplayerRole"]').forEach((input) => {
      input.disabled = false;
    });
    configureSetupMode();
    setSetupError(error.message || "The multiplayer network could not be loaded.");
    return;
  }
  multiplayerPhase = "lobby";
  dom.startGame.hidden = true;
  dom.startGame.disabled = false;
  dom.multiplayerLobby.hidden = false;
  dom.lobbyCode.textContent = code;
  dom.lobbyCodeWrap.hidden = false;
  dom.startMultiplayer.hidden = role !== "host";
  if (role === "host") {
    updateHostLobby();
  } else {
    dom.hostSettings.hidden = true;
    dom.modelState.textContent = "Waiting for host";
    renderLobby({
      hostName: "Finding host…",
      status: "Looking for the host. Keep this tab open while the table connects.",
    });
  }
}

async function startHostedGame() {
  if (!isHost() || multiplayerPhase !== "lobby" || guestNames.size < 1) return;
  const settings = validateHandRange(new FormData(dom.setupForm));
  if (!settings) return;
  const { data, maximum, minimum } = settings;
  const aiCount = Number(data.get("opponents"));
  if (1 + guestNames.size + aiCount > 5) {
    setSetupError("Human and AI players may not exceed five seats.");
    updateHostLobby();
    return;
  }
  multiplayerPhase = "starting";
  dom.startMultiplayer.disabled = true;
  multiplayer.send({ type: "starting" }).catch(() => {});
  difficulty = Number(data.get("difficulty"));
  const fallback = await loadHostAgent();
  if (guestNames.size < 1) {
    dom.gameLoading.hidden = true;
    multiplayerPhase = "lobby";
    updateHostLobby();
    return;
  }
  const humanPeers = [...guestNames.entries()];
  const humanNames = [cleanPlayerName(dom.playerName.value, "Host"), ...humanPeers.map(([, name]) => name)];
  const totalPlayers = humanNames.length + aiCount;
  playerNames = [
    ...humanNames,
    ...Array.from({ length: aiCount }, (_, index) => `Agent ${humanNames.length + index + 1}`),
  ];
  aiPlayers = new Set(Array.from({ length: aiCount }, (_, index) => humanNames.length + index));
  peerToSeat.clear();
  seatToPeer.clear();
  humanPeers.forEach(([peerId], index) => {
    const seat = index + 1;
    peerToSeat.set(peerId, seat);
    seatToPeer.set(seat, peerId);
  });
  localPlayer = 0;
  multiplayerPhase = "playing";
  networkRevision = 0;
  appliedNetworkRevision = -1;
  gameSequence += 1;
  game = new PlumpGame({ numPlayers: totalPlayers, minimum, maximum });
  dom.setup.hidden = true;
  displayedCompletedTrick = null;
  dom.game.hidden = false;
  dom.gameLoading.hidden = true;
  dom.liveTableBadge.hidden = false;
  dom.liveTableBadge.textContent = `Hosting · ${multiplayer.code}`;
  if (fallback) setStatus("Checkpoint unavailable; strategic fallback controls the AI seats.");
  await beginDeal();
}

async function leaveMultiplayer({ preserveError = false } = {}) {
  const error = preserveError ? dom.setupError.textContent : "";
  const activeRoom = multiplayer;
  const wasHost = isHost();
  if (wasHost && activeRoom) {
    await activeRoom.send({
      type: "table_closed",
      message: "The host closed this multiplayer table.",
    }).catch(() => {});
  }
  multiplayer = null;
  multiplayerRole = null;
  multiplayerPhase = "idle";
  hostPeerId = null;
  peerToSeat = new Map();
  seatToPeer = new Map();
  guestNames = new Map();
  insightPreferences = new Map();
  game = null;
  localPlayer = 0;
  aiPlayers = new Set();
  playerNames = [];
  appliedNetworkRevision = -1;
  interactionLocked = false;
  dom.game.hidden = true;
  dom.setup.hidden = false;
  dom.gameLoading.hidden = true;
  dom.multiplayerLobby.hidden = true;
  dom.startGame.hidden = false;
  dom.startGame.disabled = false;
  dom.startMultiplayer.hidden = true;
  dom.liveTableBadge.hidden = true;
  $$('input[name="playMode"], input[name="multiplayerRole"]').forEach((input) => {
    input.disabled = false;
  });
  dom.roundDialog.hidden = true;
  dom.gameOver.hidden = true;
  dom.modelState.textContent = agent.session ? `Agent ready · ${agent.backend}` : "Agent not loaded";
  dom.modelState.className = agent.session ? "model-state is-ready" : "model-state";
  configureSetupMode();
  if (error) setSetupError(error);
  await activeRoom?.leave().catch(() => {});
}

dom.setupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (selectedPlayMode() === "solo") {
    startSoloGame(event.currentTarget);
  } else {
    openMultiplayerLobby(event.currentTarget);
  }
});

dom.startMultiplayer.addEventListener("click", startHostedGame);

$$('input[name="playMode"], input[name="multiplayerRole"]').forEach((input) =>
  input.addEventListener("change", configureSetupMode),
);

dom.joinCode.addEventListener("input", () => {
  dom.joinCode.value = normalizeRoomCode(dom.joinCode.value);
});

dom.opponents.addEventListener("change", () => {
  if (isHost() && multiplayerPhase === "lobby") updateHostLobby();
});

$("[data-copy-code]").addEventListener("click", async () => {
  const code = dom.lobbyCode.textContent.trim();
  try {
    await navigator.clipboard.writeText(code);
    dom.lobbyStatus.textContent = "Code copied. Send it to your friends.";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(dom.lobbyCode);
    selection.removeAllRanges();
    selection.addRange(range);
    dom.lobbyStatus.textContent = "Code selected — copy it and send it to your friends.";
  }
});

$("[data-leave-lobby]").addEventListener("click", () => leaveMultiplayer());

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

dom.game.addEventListener("click", async (event) => {
  const bidButton = event.target.closest("[data-bid]");
  if (bidButton && !bidButton.disabled && !interactionLocked) {
    const value = Number(bidButton.dataset.bid);
    if (game.round.currentPlayer !== localPlayer) return;
    if (multiplayerRole === "guest") {
      interactionLocked = true;
      render();
      try {
        await multiplayer.send({ type: "player_action", action: "bid", value }, hostPeerId);
      } catch {
        interactionLocked = false;
        setStatus("The bid did not reach the host. Try again.");
        render();
      }
      return;
    }
    invalidatePredictionReadouts();
    game.bid(value);
    setStatus(`${statusPlayerName(localPlayer)} bids ${value}.`);
    render();
    await broadcastGameState();
    await continueBots();
    return;
  }
  const cardButton = event.target.closest("[data-play-card]");
  if (cardButton && !cardButton.disabled) {
    const [suit, rank] = cardButton.dataset.playCard.split(":");
    playHumanCard({ suit, rank: Number(rank) });
  }
});

dom.mobileDrawerTabs.forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.dataset.mobileDrawerTarget;
    setMobileDrawer(dom.game.dataset.mobileDrawer === target ? "" : target, { focus: true });
  });
});

dom.mobileDrawerClose.forEach((button) => {
  button.addEventListener("click", () => setMobileDrawer(""));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && dom.game.dataset.mobileDrawer) setMobileDrawer("");
});

mobileTableQuery.addEventListener("change", syncMobileDrawers);
syncMobileDrawers();

dom.setupProbabilityToggle.addEventListener("change", () => {
  dom.probabilityToggle.checked = dom.setupProbabilityToggle.checked;
});

dom.setupBeliefToggle.addEventListener("change", () => {
  dom.beliefToggle.checked = dom.setupBeliefToggle.checked;
});

dom.probabilityToggle.addEventListener("change", () => {
  dom.setupProbabilityToggle.checked = dom.probabilityToggle.checked;
  refreshHumanPrediction();
});

dom.beliefToggle.addEventListener("change", () => {
  dom.setupBeliefToggle.checked = dom.beliefToggle.checked;
  refreshHumanPrediction();
});

dom.nextRound.addEventListener("click", async () => {
  if (isMultiplayer() && !isHost()) return;
  dom.roundDialog.hidden = true;
  game.startNextRound();
  await beginDeal();
});

$("[data-new-game]").addEventListener("click", async () => {
  setMobileDrawer("");
  invalidatePredictionReadouts();
  if (isMultiplayer()) {
    await leaveMultiplayer();
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
    return;
  }
  dom.game.hidden = true;
  dom.setup.hidden = false;
  dom.roundDialog.hidden = true;
  dom.gameOver.hidden = true;
  game = null;
  window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
});

$("[data-play-again]").addEventListener("click", async () => {
  setMobileDrawer("");
  invalidatePredictionReadouts();
  if (isMultiplayer()) {
    await leaveMultiplayer();
    return;
  }
  dom.gameOver.hidden = true;
  dom.game.hidden = true;
  dom.setup.hidden = false;
  game = null;
});

$("[data-rules-button]").addEventListener("click", () => {
  setMobileDrawer("");
  dom.rulesDialog.showModal();
});
$$('[data-close-rules]').forEach((button) =>
  button.addEventListener("click", () => dom.rulesDialog.close()),
);

dom.difficultyOutput.textContent = difficultyLabel(Number(dom.difficulty.value));

try {
  dom.playerName.value = cleanPlayerName(localStorage.getItem("plump-player-name"), "Player");
} catch {}

configureSetupMode();

window.addEventListener("beforeunload", () => {
  multiplayer?.leave();
});
