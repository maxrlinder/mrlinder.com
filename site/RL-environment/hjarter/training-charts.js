/**
 * Charts for the Hjärter "How the agent was trained" window: a round robin of checkpoints in
 * each stage. Single deals: one fitted rating per checkpoint over the untrained network. Whole
 * games: each checkpoint's average place over all its games against the others (or, without a
 * round robin, every checkpoint against the single-deal agent the fine-tune started from).
 */
import { HJARTER_TRAINING_DATA as DATA } from "./training-data.js?v=2";
import { BLUE, html, mountCharts, paddedDomain, signed, updateLabel } from "../line-chart.js";

const PLAYERS = ["3", "4", "5"];
const percent = (value) => `${(value * 100).toFixed(1)}%`;
const fair = (players) => 1 / Number(players);
const { deal, game } = DATA;
// The untrained network (update 0) is far below the rest; the copy quotes it instead.
const ladder = deal.roundRobin.checkpoints.filter((d) => d.iteration > 0);
const band = (d, value) => [d.iteration, value - 1.96 * d.stderr, value + 1.96 * d.stderr];
const evals = game?.evals ?? [];
// Whole games' round robin: each checkpoint's average over all its games, 0 an even result.
const gameLadder = game?.roundRobin?.checkpoints ?? [];
const placeBand = (rows, value) => paddedDomain(
  Math.min(0, ...rows.map((d) => band(d, value(d))[1])),
  Math.max(0, ...rows.map((d) => band(d, value(d))[2])),
  0.005,
  0.02,
);
const checkpointLabel = (iteration) => (iteration ? updateLabel(iteration) : "The single-deal agent");

const CHARTS = {
  "round-robin": {
    height: 230,
    xDomain: [0, paddedDomain(0, ladder.at(-1).iteration, 500, 1000)[1]],
    yDomain: paddedDomain(Math.min(...ladder.map((d) => d.rating)), Math.max(...ladder.map((d) => d.rating)), 0.2, 0.5),
    yFormat: signed(1),
    band: { color: BLUE, points: ladder.map((d) => band(d, d.rating)) },
    series: [{ label: "Points / deal", color: BLUE, markers: true, points: ladder.map((d) => [d.iteration, d.rating]) }],
    endLabels: true,
    valueFormat: signed(1),
    tooltip: (index) => {
      const row = ladder[index];
      return {
        title: updateLabel(row.iteration),
        rows: [
          { color: BLUE, label: "Points / deal", value: `${signed(2)(row.rating)} ± ${(1.96 * row.stderr).toFixed(2)}` },
          ...PLAYERS.map((p) => ({ label: `${p} players`, value: signed(1)(row.players[p]) })),
        ],
      };
    },
  },
};

if (gameLadder.length > 1) {
  CHARTS.games = {
    height: 230,
    xDomain: [0, gameLadder.at(-1).iteration],
    yDomain: placeBand(gameLadder, (d) => d.place),
    yFormat: signed(2),
    zeroLabel: "even against the others",
    band: { color: BLUE, points: gameLadder.map((d) => band(d, d.place)) },
    series: [{ label: "Place / game", color: BLUE, markers: true, points: gameLadder.map((d) => [d.iteration, d.place]) }],
    endLabels: true,
    valueFormat: signed(3),
    tooltip: (index) => {
      const row = gameLadder[index];
      return {
        title: checkpointLabel(row.iteration),
        rows: [
          { color: BLUE, label: "Place / game", value: `${signed(3)(row.place)} ± ${(1.96 * row.stderr).toFixed(3)}` },
          ...PLAYERS.map((p) => ({ label: `${p} players`, value: `${signed(3)(row.players[p].place)}, wins ${percent(row.players[p].wins)}` })),
        ],
      };
    },
  };
} else if (evals.length > 1) {
  CHARTS.games = {
    height: 230,
    xDomain: [0, evals.at(-1).iteration],
    yDomain: placeBand(evals, (d) => d.placement),
    yFormat: signed(2),
    zeroLabel: "the single-deal agent",
    band: { color: BLUE, points: evals.map((d) => band(d, d.placement)) },
    series: [{ label: "Place / game", color: BLUE, markers: true, hollowFirst: true, points: evals.map((d) => [d.iteration, d.placement]) }],
    endLabels: true,
    valueFormat: signed(3),
    tooltip: (index) => {
      const row = evals[index];
      return {
        title: checkpointLabel(row.iteration),
        rows: [
          { color: BLUE, label: "Place / game", value: row.iteration ? `${signed(3)(row.placement)} ± ${(1.96 * row.stderr).toFixed(3)}` : "±0" },
          ...PLAYERS.map((p) => ({ label: `Wins, ${p} players`, value: `${percent(row.players[p].wins)} (fair ${percent(fair(p))})` })),
        ],
      };
    },
  };
}

mountCharts(CHARTS);

function table(name, headers, rows) {
  const container = document.querySelector(`[data-chart-table="${name}"]`);
  if (!container) return;
  const node = html("table", "", container);
  const head = html("tr", "", html("thead", "", node));
  for (const label of headers) html("th", "", head, label);
  const body = html("tbody", "", node);
  for (const cells of rows) {
    const tr = html("tr", "", body);
    for (const cell of cells) html("td", "", tr, cell);
  }
}

table(
  "round-robin",
  ["Update", "Points / deal", ...PLAYERS.map((p) => `${p} players`)],
  deal.roundRobin.checkpoints.map((row) => [
    row.iteration ? row.iteration.toLocaleString("en-US") : "0 (untrained)",
    row.iteration ? `${signed(2)(row.rating)} ± ${(1.96 * row.stderr).toFixed(2)}` : "±0",
    ...PLAYERS.map((p) => signed(2)(row.players[p])),
  ]),
);
// The rows of the chart drawn: round-robin averages, or head to head (update 0 the anchor, at 0).
table(
  "games",
  ["Update", "Place / game", ...PLAYERS.map((p) => `Wins, ${p} players`)],
  (gameLadder.length > 1 ? gameLadder : evals).map((row) => {
    const place = row.place ?? row.placement;
    return [
      row.iteration ? row.iteration.toLocaleString("en-US") : "0 (single-deal agent)",
      row.stderr ? `${signed(3)(place)} ± ${(1.96 * row.stderr).toFixed(3)}` : "±0",
      ...PLAYERS.map((p) => percent(row.players[p].wins)),
    ];
  }),
);

// Copy that tracks the data, so a re-export cannot leave the prose describing older numbers than the charts.
const fill = (selector, text) => {
  for (const node of document.querySelectorAll(selector)) node.textContent = text;
};
const millions = (value) => (value >= 1e6 ? `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)} million` : `${Math.round(value / 1000)} thousand`);
fill("[data-training-parameters]", `${(DATA.parameters / 1e6).toFixed(1)}M`);
fill("[data-training-deals]", millions(deal.totals.deals));
fill("[data-training-hours]", `about ${Math.round(deal.totals.hours + (game?.totals.hours ?? 0))} hours`);
fill("[data-rr-untrained]", String(Math.round(ladder[0].rating)));
fill("[data-rr-live]", `${signed(1)(ladder.at(-1).rating - ladder[0].rating)}`);
document.querySelectorAll("[data-game-only]").forEach((node) => { node.hidden = !game; });
// The caption that matches the chart drawn: the round robin, or the head-to-head series.
document.querySelectorAll("[data-game-rr]").forEach((node) => { node.hidden = gameLadder.length < 2; });
document.querySelectorAll("[data-game-h2h]").forEach((node) => { node.hidden = gameLadder.length > 1; });
if (gameLadder.length > 1) {
  fill("[data-game-rr-size]", String(gameLadder.length));
  fill("[data-game-rr-last]", gameLadder.at(-1).iteration.toLocaleString("en-US"));
  fill("[data-game-rr-seeds]", String(game.roundRobin.seeds));
  const [first, last] = [gameLadder[0], gameLadder.at(-1)];
  fill("[data-game-rr-first]", `${signed(3)(first.place)}`);
  fill("[data-game-rr-live]", `${signed(3)(last.place)}`);
}
if (game) {
  fill("[data-game-games]", millions(game.totals.games));
  const last = evals.at(-1);
  fill("[data-game-update]", last.iteration.toLocaleString("en-US"));
  fill("[data-game-live]", `${signed(3)(last.placement)} ± ${(1.96 * last.stderr).toFixed(3)}`);
  const list = (items) => `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  fill("[data-game-wins]", `${list(PLAYERS.map((p) => percent(last.players[p].wins)))} of 3-, 4- and 5-player games `
    + `(a fair share: ${PLAYERS.map((p) => percent(fair(p))).join(", ")})`);
}
// The live checkpoint is the model's: the site publishes new ones as the run trains.
fetch("./model/manifest.json")
  .then((response) => (response.ok ? response.json() : null))
  .then((manifest) => manifest && fill("[data-live-checkpoint]", Number(manifest.iteration).toLocaleString("en-US")))
  .catch(() => {});
