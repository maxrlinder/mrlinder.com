/** Line charts for the "How the agent was trained" window. */
import { PLUMP_TRAINING_DATA as DATA } from "./training-data.js?v=2";
import { PLUMP_MODEL_CONFIG } from "./model-config.js";
import { BLUE, RED, fixed, html, mountCharts, paddedDomain, signed, updateLabel } from "../line-chart.js";

const roundRobin = DATA.roundRobin;

const CHARTS = {
  "round-robin": {
    height: 270,
    xDomain: paddedDomain(roundRobin[0].iteration, roundRobin.at(-1).iteration, 600, 500),
    yDomain: paddedDomain(
      Math.min(...roundRobin.map((d) => d.low)),
      Math.max(...roundRobin.map((d) => d.high)),
      0.01,
      0.05,
    ),
    yFormat: signed(2),
    zeroLabel: "field average",
    band: { color: BLUE, points: roundRobin.map((d) => [d.iteration, d.low, d.high]) },
    series: [
      {
        label: "Points per round vs field",
        color: BLUE,
        markers: true,
        hollowFirst: true,
        points: roundRobin.map((d) => [d.iteration, d.reward]),
      },
    ],
    notes: [{ index: 0, text: "distilled student", dx: 9, dy: 4, anchor: "start" }],
    endLabels: true,
    tooltip: (index) => {
      const row = roundRobin[index];
      return {
        title: `${updateLabel(row.iteration)}${row.run === "distill-v5" ? " · distilled" : ""}`,
        rows: [
          { color: BLUE, label: "vs field", value: signed(3)(row.reward) },
          {
            label: "95% CI",
            value: `${signed(3)(row.low)} … ${signed(3)(row.high)}`,
          },
        ],
      };
    },
  },
  distill: {
    height: 190,
    xDomain: [0, 5600],
    yDomain: [0, 0.8],
    yFormat: fixed(1),
    series: [{ label: "KL", color: BLUE, points: DATA.distillKl }],
    endLabels: true,
    valueFormat: fixed(2),
  },
  value: {
    height: 190,
    xDomain: [5600, DATA.oracleValueRmse.at(-1)[0]],
    yDomain: [3, 7],
    yFormat: fixed(0),
    series: [
      { label: "Oracle critic", color: BLUE, points: DATA.oracleValueRmse },
      { label: "Agent", color: RED, points: DATA.actorValueRmse },
    ],
    endLabels: true,
    valueFormat: fixed(2),
  },
  beliefs: {
    height: 190,
    xDomain: [5600, DATA.suitLoss.at(-1)[0]],
    yDomain: [0.32, 0.46],
    yFormat: fixed(2),
    series: [
      { label: "Suit held", color: BLUE, points: DATA.suitLoss },
      { label: "Higher/lower cards", color: RED, points: DATA.rankBoundaryLoss },
    ],
    endLabels: true,
    valueFormat: fixed(3),
  },
};

function drawRoundRobinTable(container) {
  const table = html("table", "", container);
  const head = html("tr", "", html("thead", "", table));
  for (const label of ["Update", "Points / round", "95% interval", "Rounds"]) html("th", "", head, label);
  const body = html("tbody", "", table);
  for (const row of roundRobin) {
    const tr = html("tr", "", body);
    html("td", "", tr, `${row.iteration.toLocaleString("en-US")}${row.run === "distill-v5" ? " (distilled)" : ""}`);
    html("td", "", tr, signed(3)(row.reward));
    html("td", "", tr, `${signed(3)(row.low)} … ${signed(3)(row.high)}`);
    html("td", "", tr, row.rounds.toLocaleString("en-US"));
  }
}

mountCharts(CHARTS);

const table = document.querySelector('[data-chart-table="round-robin"]');
if (table) drawRoundRobinTable(table);

// Copy that tracks the data, so a re-export or a model update cannot leave
// the prose describing older numbers than the charts.
const fill = (selector, text) => {
  for (const node of document.querySelectorAll(selector)) node.textContent = text;
};
const weeks = Math.round(DATA.totals.days / 7);
fill("[data-training-days]", DATA.totals.days < 45 ? `about ${["", "one", "two", "three", "four", "five", "six"][weeks] || weeks} weeks` : `about ${Math.round(DATA.totals.days / 30)} months`);
fill("[data-training-decisions]", `${(DATA.totals.decisions / 1e9).toFixed(1)} billion`);
const liveManifest = PLUMP_MODEL_CONFIG.models.deeper.actorManifests.fp32;
const liveCheckpoint = Number(liveManifest.match(/-(\d+)-ev-/)?.[1]);
if (liveCheckpoint) fill("[data-live-checkpoint]", liveCheckpoint.toLocaleString("en-US"));
