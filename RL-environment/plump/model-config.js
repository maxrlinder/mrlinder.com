/** Deployment defaults for the Plump browser models. */
export const PLUMP_MODEL_CONFIG = Object.freeze({
  defaultModel: "deeper",
  models: Object.freeze({
    deeper: Object.freeze({
      label: "Deeper · RL6",
      actorManifests: Object.freeze({
        fp32: "plump-rl6-14100-ev-fp32.json",
        fp16: "plump-rl6-14100-ev-fp16.json",
      }),
      oracleManifest: "plump-rl6-oracle-14100-ev-fp32.json",
    }),
    wider: Object.freeze({
      label: "Wider · v4.5",
      actorManifests: Object.freeze({
        fp32: "plump-ppo-100500-ev-fp32.json",
        fp16: "plump-ppo-100500-ev-fp16.json",
      }),
      oracleManifest: "plump-oracle-100500-ev-fp32.json",
    }),
  }),
  actorPrecision: "fp32",
  adminPrecisionQuery: "plump-model",
});

/**
 * The public default stays FP32. An unadvertised query override lets the site
 * owner benchmark FP16 without adding a player-facing control:
 *   /RL-environment/plump/?plump-model=fp16
 */
export function configuredActorPrecision(search = globalThis.location?.search || "") {
  const requested = new URLSearchParams(search).get(
    PLUMP_MODEL_CONFIG.adminPrecisionQuery,
  );
  return requested in PLUMP_MODEL_CONFIG.models[PLUMP_MODEL_CONFIG.defaultModel].actorManifests
    ? requested
    : PLUMP_MODEL_CONFIG.actorPrecision;
}
