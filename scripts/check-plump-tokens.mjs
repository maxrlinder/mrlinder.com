/**
 * Assert the browser token builder reproduces the training project's stream.
 *
 * Fixtures come from scripts/plump-token-fixtures.py, which builds the expected
 * rows with plump-bot's own `build_seat_tokens`. Regenerate them whenever the
 * checkpoint's schema changes; a stale fixture passing is the one failure mode
 * this cannot catch on its own, so the fixture records the model config it was
 * generated for and that is checked against tokens.js here.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  MODEL_LIMITS,
  WIDTH,
  buildOracleTokens,
  buildTokens,
} from "../RL-environment/plump/tokens.js";

const root = resolve(import.meta.dirname, "..");
const fixtures = JSON.parse(
  await readFile(resolve(root, "scripts/fixtures/plump-tokens.json"), "utf8"),
);

for (const [field, expected] of Object.entries(fixtures.modelConfig)) {
  if (MODEL_LIMITS[field] !== expected) {
    throw new Error(
      `Fixtures were generated for ${field}=${expected}, but tokens.js writes ` +
        `${field}=${MODEL_LIMITS[field]}.`,
    );
  }
}

const describe = (rows, index) =>
  index < rows.length ? `[${rows[index].join(", ")}]` : "(missing)";

const compare = (label, actual, expected) => {
  if (actual.length !== expected.length) {
    throw new Error(
      `${label}: built ${actual.length} tokens, expected ${expected.length}.`,
    );
  }
  for (let row = 0; row < expected.length; row += 1) {
    if (actual[row].length !== WIDTH) {
      throw new Error(
        `${label}: row ${row} has width ${actual[row].length}, expected ${WIDTH}.`,
      );
    }
    for (let column = 0; column < WIDTH; column += 1) {
      if (actual[row][column] !== expected[row][column]) {
        throw new Error(
          `${label}: row ${row} column ${column} is ` +
            `${actual[row][column]}, expected ${expected[row][column]}.\n` +
            `  built:    ${describe(actual, row)}\n` +
            `  expected: ${describe(expected, row)}`,
        );
      }
    }
  }
};

let rows = 0;
for (const testCase of fixtures.cases) {
  const game = { numPlayers: testCase.numPlayers, round: testCase.round };
  for (const [observer, expected] of Object.entries(testCase.expected)) {
    compare(
      `${testCase.name} seat ${observer}`,
      buildTokens(game, Number(observer)),
      expected,
    );
    rows += expected.length;
  }
  compare(
    `${testCase.name} oracle`,
    buildOracleTokens(game),
    testCase.expectedOracle,
  );
  rows += testCase.expectedOracle.length;
}

console.log(
  `Checked ${rows} Plump token rows across ${fixtures.cases.length} states.`,
);
