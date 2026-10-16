// The agent-difficulty slider shared by the games. 0 plays uniformly at
// random (T = ∞), the centre samples the policy exactly as trained (T = 1),
// and 100 always plays the agent's best move (argmax, T = 0).
export const AS_TRAINED = 50;

export function temperatureFor(value) {
  if (value <= 0) return Number.POSITIVE_INFINITY;
  if (value >= 100) return 0;
  if (value <= AS_TRAINED) return AS_TRAINED / value;
  return Math.pow(0.02, (value - AS_TRAINED) / (100 - AS_TRAINED));
}

export function difficultyLabel(value) {
  if (value <= 0) return "Random plays · T = ∞";
  if (value >= 100) return "Argmax · hardest";
  if (value === AS_TRAINED) return "Temperature 1 · as trained";
  const temperature = temperatureFor(value);
  return `Temperature ${temperature >= 10 ? temperature.toFixed(0) : temperature.toFixed(2)}`;
}

// A small detent at the centre makes T = 1 easy to find again.
export function snapDifficulty(input) {
  if (Math.abs(Number(input.value) - AS_TRAINED) <= 3) input.value = String(AS_TRAINED);
}
