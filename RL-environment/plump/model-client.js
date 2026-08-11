import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.webgpu.bundle.min.mjs";
import {
  PLUMP_MODEL_CONFIG,
  configuredActorPrecision,
} from "./model-config.js";

const MODEL_ROOT = "/RL-environment/plump/model/";
const RUNTIME_ROOT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";

const TOKEN = Object.freeze({
  GAME: 1,
  HAND: 2,
  BID: 3,
  PLAY: 4,
  TRICK_WIN: 5,
  TURN: 6,
});

const NEXT = Object.freeze({ NONE: 0, BID: 1, PLAY: 2 });
const SUITS = ["spades", "hearts", "diamonds", "clubs"];
const WIDTH = 22;

const relative = (player, observer, players) =>
  (player - observer + players) % players;

const cardId = (card) => SUITS.indexOf(card.suit) * 13 + (card.rank - 2);

const baseToken = (players, handSize) => [
  0, 5, 13, 4, 52, 11, 10, 5, handSize, players, 5, 0,
  52, 52, 52, 52, 52, 52, 52, 52, 52, 52,
];

const turnToken = (
  players,
  handSize,
  actor,
  phase,
  trick = null,
  position = null,
) => {
  const token = baseToken(players, handSize);
  token[0] = TOKEN.TURN;
  token[1] = actor;
  if (trick !== null) token[6] = trick;
  if (position !== null) token[7] = position;
  token[10] = actor;
  token[11] = phase;
  return token;
};

const eventToken = (event, observer, players, handSize, remainingHand) => {
  const token = baseToken(players, handSize);
  token[1] = relative(event.player, observer, players);

  if (event.type === "bid") {
    token[0] = TOKEN.BID;
    token[5] = event.bid;
  } else if (event.type === "play") {
    token[0] = TOKEN.PLAY;
    token[2] = event.card.rank - 2;
    token[3] = SUITS.indexOf(event.card.suit);
    token[4] = cardId(event.card);
    token[6] = event.trickIndex;
    token[7] = event.position;
  } else if (event.type === "trick_win") {
    token[0] = TOKEN.TRICK_WIN;
    token[6] = event.trickIndex;
    const values = remainingHand.map(cardId).sort((a, b) => a - b);
    token.splice(12, 10, ...values, ...Array(10 - values.length).fill(52));
  }
  return token;
};

/** Build the exact schema-v6 actor stream used by the training project. */
export function buildTokens(game, observer) {
  const round = game.round;
  const players = game.numPlayers;
  const handSize = round.handSize;
  const biddingPosition = relative(observer, round.biddingStart, players);
  const initialHand = [...round.initialHands[observer]].sort(
    (a, b) => cardId(a) - cardId(b),
  );

  const gameRow = baseToken(players, handSize);
  gameRow[0] = TOKEN.GAME;
  gameRow[7] = biddingPosition;
  const tokens = [gameRow];

  for (const card of initialHand) {
    const token = baseToken(players, handSize);
    token[0] = TOKEN.HAND;
    token[1] = 0;
    token[2] = card.rank - 2;
    token[3] = SUITS.indexOf(card.suit);
    token[4] = cardId(card);
    tokens.push(token);
  }

  const firstActor = relative(round.biddingStart, observer, players);
  // This model was trained with turn_token="bid".
  tokens.push(turnToken(players, handSize, firstActor, NEXT.BID));

  const remaining = new Map(initialHand.map((card) => [cardId(card), card]));
  const remainingAtWin = new Map();
  round.events.forEach((event, index) => {
    if (event.type === "play" && event.player === observer) {
      remaining.delete(cardId(event.card));
    } else if (event.type === "trick_win") {
      remainingAtWin.set(index, [...remaining.values()]);
    }
  });

  round.events.forEach((event, index) => {
    if (index > 0 && event.type === "bid") {
      tokens.push(
        turnToken(
          players,
          handSize,
          relative(event.player, observer, players),
          NEXT.BID,
        ),
      );
    }
    tokens.push(
      eventToken(
        event,
        observer,
        players,
        handSize,
        remainingAtWin.get(index) || [],
      ),
    );
  });

  // Each row announces an immediately following public action.
  for (let position = Math.max(0, 1 + handSize); position < tokens.length - 1; position += 1) {
    const upcoming = tokens[position + 1];
    if (upcoming[0] === TOKEN.BID || upcoming[0] === TOKEN.PLAY) {
      tokens[position][10] = upcoming[1];
      tokens[position][11] = upcoming[0] === TOKEN.BID ? NEXT.BID : NEXT.PLAY;
    } else if (upcoming[0] !== TOKEN.TURN) {
      tokens[position][10] = 5;
      tokens[position][11] = NEXT.NONE;
    }
  }

  if (round.currentPlayer !== null && ["bidding", "playing"].includes(round.phase)) {
    const actor = relative(round.currentPlayer, observer, players);
    if (round.phase === "bidding") {
      // Kept byte-for-byte compatible with the training policy builder,
      // including its explicit pending-decision register.
      tokens.push(turnToken(players, handSize, actor, NEXT.BID));
    } else {
      const trick = round.tricks.filter((item) => item.winner !== null).length;
      const current = round.tricks.at(-1);
      const position = current && current.winner === null ? current.plays.length : 0;
      tokens.at(-1)[10] = actor;
      tokens.at(-1)[11] = NEXT.PLAY;
      // PLAY has no separate TURN token in this checkpoint.
      void trick;
      void position;
    }
  }

  return tokens;
}

/** Build the perfect-information, absolute-seat stream used by the PPO oracle. */
export function buildOracleTokens(game) {
  const round = game.round;
  const handSize = round.handSize;
  const actorTokens = buildTokens(game, 0);
  const oracleHands = round.initialHands.flatMap((hand, owner) =>
    [...hand]
      .sort((a, b) => cardId(a) - cardId(b))
      .map((card) => {
        const token = baseToken(game.numPlayers, handSize);
        token[0] = TOKEN.HAND;
        token[1] = owner;
        token[2] = card.rank - 2;
        token[3] = SUITS.indexOf(card.suit);
        token[4] = cardId(card);
        return token;
      }),
  );
  const tokens = [
    actorTokens[0],
    ...oracleHands,
    ...actorTokens.slice(1 + handSize),
  ];
  // Remaining-hand snapshots belong only to an observer stream. The oracle
  // derives every current hand from its full-deal prefix and public plays.
  tokens.forEach((token) => token.fill(52, 12));
  return tokens;
}

const flattenInt64 = (rows) => {
  const values = new BigInt64Array(rows.length * WIDTH);
  let offset = 0;
  for (const row of rows) {
    for (const value of row) values[offset++] = BigInt(value);
  }
  return values;
};

export class BrowserPpoAgent {
  constructor() {
    this.session = null;
    this.manifest = null;
    this.backend = "not loaded";
    this.precision = "not loaded";
    this.oracleSession = null;
    this.oracleModel = null;
    this.oracleManifest = null;
    this.oracleBackend = "not loaded";
    this.oracleLoadPromise = null;
    this.inferenceQueue = Promise.resolve();
  }

  enqueueInference(callback) {
    const pending = this.inferenceQueue.then(callback, callback);
    this.inferenceQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async downloadModel(manifestFile, onProgress = () => {}) {
    const manifest = await fetch(`${MODEL_ROOT}${manifestFile}`).then((response) => {
      if (!response.ok) throw new Error("Could not read the model manifest.");
      return response.json();
    });
    const response = await fetch(`${MODEL_ROOT}${manifest.file}`);
    if (!response.ok || !response.body) {
      throw new Error("Could not download the model weights.");
    }
    const total = Number(response.headers.get("content-length")) || manifest.bytes;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(received, total);
    }
    const model = new Uint8Array(received);
    let cursor = 0;
    for (const chunk of chunks) {
      model.set(chunk, cursor);
      cursor += chunk.length;
    }
    return { manifest, model };
  }

  async load(onProgress = () => {}) {
    if (this.session) return this;
    onProgress(2, "Reading model manifest…");
    ort.env.wasm.wasmPaths = RUNTIME_ROOT;
    ort.env.wasm.numThreads = 1;
    const prefersGpu = "gpu" in navigator;
    const requestedPrecision = configuredActorPrecision();
    const selectedPrecision = requestedPrecision === "fp16" && prefersGpu
      ? "fp16"
      : "fp32";
    let bundle = await this.downloadModel(
      PLUMP_MODEL_CONFIG.actorManifests[selectedPrecision],
      (received, total) => {
        const percentage = Math.round((received / total) * 100);
        onProgress(
          5 + Math.round((received / total) * 70),
          `Downloading checkpoint… ${percentage}%`,
        );
      },
    );
    this.manifest = bundle.manifest;
    onProgress(82, `Compiling the ${selectedPrecision.toUpperCase()} policy…`);

    if (selectedPrecision === "fp16") {
      try {
        this.session = await ort.InferenceSession.create(bundle.model, {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "all",
        });
        this.backend = "WebGPU";
        this.precision = "FP16 mixed precision";
        onProgress(100, `Agent ready · ${this.backend} · ${this.precision}`);
        return this;
      } catch {
        onProgress(8, "FP16 unavailable; downloading the full-precision policy…");
        bundle = await this.downloadModel(
          PLUMP_MODEL_CONFIG.actorManifests.fp32,
          (received, total) => {
            const percentage = Math.round((received / total) * 100);
            onProgress(
              10 + Math.round((received / total) * 65),
              `Downloading checkpoint… ${percentage}%`,
            );
          },
        );
        this.manifest = bundle.manifest;
      }
    }

    try {
      this.session = await ort.InferenceSession.create(bundle.model, {
        executionProviders: prefersGpu ? ["webgpu", "wasm"] : ["wasm"],
        graphOptimizationLevel: "all",
      });
      this.backend = prefersGpu ? "WebGPU" : "WebAssembly";
    } catch (gpuError) {
      if (!prefersGpu) throw gpuError;
      onProgress(88, "GPU unavailable; preparing the CPU policy…");
      this.session = await ort.InferenceSession.create(bundle.model, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      this.backend = "WebAssembly";
    }
    this.precision = "FP32";
    onProgress(100, `Agent ready · ${this.backend} · ${this.precision}`);
    return this;
  }

  async predict(game, observer) {
    if (!this.session) throw new Error("The PPO agent is not loaded.");
    const rows = buildTokens(game, observer);
    const tensor = new ort.Tensor("int64", flattenInt64(rows), [1, rows.length, WIDTH]);
    const output = await this.enqueueInference(() => this.session.run({ tokens: tensor }));
    return {
      bidLogits: [...output.bid_logits.data],
      cardLogits: [...output.card_logits.data],
      value: Number(output.value.data[0]),
      trickLogits: [...output.trick_logits.data],
      suitLogits: [...output.suit_logits.data],
      bidHitLogits: [...output.bid_hit_logits.data],
    };
  }

  async loadOracle() {
    if (this.oracleSession) return this;
    if (this.oracleLoadPromise) return this.oracleLoadPromise;
    this.oracleLoadPromise = (async () => {
      this.oracleManifest = await fetch(
        `${MODEL_ROOT}${PLUMP_MODEL_CONFIG.oracleManifest}`,
      ).then((response) => {
        if (!response.ok) throw new Error("Could not read the oracle manifest.");
        return response.json();
      });
      const response = await fetch(`${MODEL_ROOT}${this.oracleManifest.file}`);
      if (!response.ok) throw new Error("Could not download the oracle weights.");
      this.oracleModel = new Uint8Array(await response.arrayBuffer());
      ort.env.wasm.wasmPaths = RUNTIME_ROOT;
      ort.env.wasm.numThreads = 1;
      await this.enqueueInference(async () => {
        this.oracleSession = await ort.InferenceSession.create(this.oracleModel, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });
        this.oracleBackend = "WebAssembly";
      });
      return this;
    })();
    try {
      return await this.oracleLoadPromise;
    } catch (error) {
      this.oracleLoadPromise = null;
      throw error;
    }
  }

  async predictOracle(game) {
    if (!this.oracleSession) throw new Error("The oracle critic is not loaded.");
    const rows = buildOracleTokens(game);
    const tensor = new ort.Tensor("int64", flattenInt64(rows), [1, rows.length, WIDTH]);
    const output = await this.enqueueInference(async () => {
      try {
        return await this.oracleSession.run({ tokens: tensor });
      } catch (initialError) {
        const failedSession = this.oracleSession;
        this.oracleSession = null;
        try {
          await failedSession?.release();
        } catch {
          // A failed backend may already have released its resources.
        }
        if (!this.oracleModel) throw initialError;
        this.oracleSession = await ort.InferenceSession.create(this.oracleModel, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });
        this.oracleBackend = "WebAssembly";
        return this.oracleSession.run({ tokens: tensor });
      }
    });
    return {
      values: [...output.values.data],
      trickLogits: [...output.trick_logits.data],
    };
  }
}

export const modelCardId = cardId;
export const modelSuits = SUITS;
