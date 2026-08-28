/** Deployment defaults for the Plump browser models. */
export const PLUMP_MODEL_CONFIG = Object.freeze({
  actorPrecision: "fp32",
  actorManifests: Object.freeze({
    fp32: "plump-ppo-68500-ev-fp32.json",
    fp16: "plump-ppo-68500-ev-fp16.json",
  }),
  oracleManifest: "plump-oracle-68500-ev-fp32.json",
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
  return requested in PLUMP_MODEL_CONFIG.actorManifests
    ? requested
    : PLUMP_MODEL_CONFIG.actorPrecision;
}
