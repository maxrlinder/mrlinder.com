/** Charts for the Piquet "How the agent was trained" window. */
import { PIQUET_TRAINING_DATA as DATA } from "./training-data.js?v=1";
import { BLUE, RED, html, mountCharts, paddedDomain, signed, updateLabel } from "../line-chart.js";

const GREEN = "#3e8a50";
const percent = (value) => `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
// The untrained network (update 0) is far below the rest; the copy quotes it instead.
const trained = DATA.heuristic.filter((d) => d.iteration > 0);
const untrained = DATA.heuristic.find((d) => d.iteration === 0);
const band = (d) => [d.iteration, d.margin - 1.96 * d.stderr, d.margin + 1.96 * d.stderr];
const last = DATA.elderMargin.at(-1)[0];

const CHARTS = {
  heuristic: {
    height: 270,
    xDomain: [0, paddedDomain(0, trained.at(-1).iteration, 300, 500)[1]],
    yDomain: paddedDomain(Math.min(...trained.map((d) => d.younger)), Math.max(...trained.map((d) => d.elder)), 1, 5),
    yFormat: signed(0),
    zeroLabel: "even with the heuristic",
    band: { color: BLUE, points: trained.map(band) },
    series: [
      { label: "Overall", color: BLUE, markers: true, points: trained.map((d) => [d.iteration, d.margin]) },
      { label: "As Elder", color: GREEN, points: trained.map((d) => [d.iteration, d.elder]) },
      { label: "As Younger", color: RED, points: trained.map((d) => [d.iteration, d.younger]) },
    ],
    endLabels: true,
    valueFormat: signed(1),
    tooltip: (index) => {
      const row = trained[index];
      return {
        title: updateLabel(row.iteration),
        rows: [
          { color: BLUE, label: "Points / deal", value: `${signed(2)(row.margin)} ± ${(1.96 * row.stderr).toFixed(2)}` },
          { color: GREEN, label: "As Elder", value: signed(1)(row.elder) },
          { color: RED, label: "As Younger", value: signed(1)(row.younger) },
          { label: "Deals won", value: percent(row.wins) },
        ],
      };
    },
  },
  elder: {
    height: 190,
    xDomain: [0, last],
    yDomain: [0, 30],
    yFormat: (v) => String(v),
    series: [
      { label: "Elder’s margin", color: BLUE, points: DATA.elderMargin },
      { label: "Points per player", color: GREEN, points: DATA.pointsPerDeal },
    ],
    endLabels: true,
    valueFormat: signed(1),
  },
  bonuses: {
    height: 190,
    xDomain: [0, last],
    yDomain: [0, 0.12],
    yFormat: percent,
    series: [
      { label: "Pique", color: BLUE, points: DATA.pique },
      { label: "Repique", color: RED, points: DATA.repique },
      { label: "Capot", color: GREEN, points: DATA.capot },
    ],
    endLabels: true,
    valueFormat: percent,
  },
};

mountCharts(CHARTS);

const table = document.querySelector('[data-chart-table="heuristic"]');
if (table) {
  const node = html("table", "", table);
  const head = html("tr", "", html("thead", "", node));
  for (const label of ["Update", "Points / deal", "As Elder", "As Younger", "Deals won"]) html("th", "", head, label);
  const body = html("tbody", "", node);
  for (const row of DATA.heuristic) {
    const tr = html("tr", "", body);
    html("td", "", tr, row.iteration.toLocaleString("en-US"));
    html("td", "", tr, `${signed(2)(row.margin)} ± ${(1.96 * row.stderr).toFixed(2)}`);
    html("td", "", tr, signed(1)(row.elder));
    html("td", "", tr, signed(1)(row.younger));
    html("td", "", tr, percent(row.wins));
  }
}

// Copy that tracks the data, so a re-export cannot leave the prose describing older numbers than the charts.
const fill = (selector, text) => {
  for (const node of document.querySelectorAll(selector)) node.textContent = text;
};
const { totals, source } = DATA;
fill("[data-training-parameters]", `${(totals.parameters / 1e6).toFixed(1)}M`);
fill("[data-training-hours]", `about ${Math.round(totals.hours)} hours`);
fill("[data-training-decisions]", `${Math.round(totals.decisions / 1e7) * 10} million`);
fill("[data-training-deals]", `${Math.round(totals.deals / 1e6)} million`);
fill("[data-live-checkpoint]", source.liveCheckpoint.toLocaleString("en-US"));
fill("[data-eval-deals]", DATA.heuristic.at(-1).deals.toLocaleString("en-US"));
if (untrained) fill("[data-eval-untrained]", String(Math.round(-untrained.margin)));
