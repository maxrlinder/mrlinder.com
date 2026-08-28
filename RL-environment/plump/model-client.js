import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.webgpu.bundle.min.mjs";
import {
  PLUMP_MODEL_CONFIG,
  configuredActorPrecision,
} from "./model-config.js?v=68500-ev1";
import {
  MODEL_LIMITS,
  SUITS,
  WIDTH,
  buildOracleTokens,
  buildTokens,
  modelCardId,
} from "./tokens.js";

const MODEL_ROOT = "/RL-environment/plump/model/";
const RUNTIME_ROOT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";

const flattenInt64 = (rows) => {
  const values = new BigInt64Array(rows.length * WIDTH);
  let offset = 0;
  for (const row of rows) {
    for (const value of row) values[offset++] = BigInt(value);
  }
  return values;
};

/**
 * Refuse a checkpoint whose token stream would differ from the one tokens.js
 * builds. A mismatch has no runtime symptom of its own -- the agent would just
 * play badly -- so it is worth failing loudly at load instead.
 */
const assertManifestMatchesBuilder = (manifest, label) => {
  const config = manifest.modelConfig || {};
  for (const [field, expected] of Object.entries(MODEL_LIMITS)) {
    if (config[field] !== expected) {
      throw new Error(
        `The ${label} was trained with ${field}=${config[field]}, but this ` +
          `build writes tokens for ${field}=${expected}. Update tokens.js.`,
      );
    }
  }
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
    assertManifestMatchesBuilder(manifest, "policy checkpoint");
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
      trickLogits: [...output.trick_logits.data],
      suitLogits: [...output.suit_logits.data],
      rankBoundaryLogits: [...output.rank_boundary_logits.data],
      nextWinnerLogits: [...output.next_winner_logits.data],
      playerValues: [...output.player_values.data],
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
      assertManifestMatchesBuilder(this.oracleManifest, "oracle critic");
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
      cardOrderLogits: [...output.card_order_logits.data],
      nextWinnerLogits: [...output.next_winner_logits.data],
    };
  }
}

// Re-exported so game.js keeps a single import site for everything model-side.
export { buildTokens, buildOracleTokens, modelCardId };
export const modelSuits = SUITS;
