/**
 * Charts for the Piquet "How the agent was trained" window: single deals against a
 * rule-based player, then whole parties in a round robin of checkpoints.
 */
import { PIQUET_TRAINING_DATA as DATA } from "./training-data.js?v=3";
import { BLUE, RED, html, mountCharts, paddedDomain, signed, updateLabel } from "../line-chart.js";

const GREEN = "#3e8a50";
const percent = (value) => `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
const percentFine = (value) => `${(value * 100).toFixed(1)}%`;
const { deal, partie } = DATA;
// The untrained network (update 0) is far below the rest; the copy quotes it instead.
const trained = deal.heuristic.filter((d) => d.iteration > 0);
const untrained = deal.heuristic.find((d) => d.iteration === 0);
const band = (d) => [d.iteration, d.margin - 1.96 * d.stderr, d.margin + 1.96 * d.stderr];
// The round robin: the single-deal agent (update 0 of the partie training) and checkpoints of the partie training.
const rr = partie?.roundRobin;
const ladder = rr?.checkpoints ?? [];
const ladderBand = (d) => [d.iteration, d.rating - 1.96 * d.stderr, d.rating + 1.96 * d.stderr];
const checkpointLabel = (iteration) => (iteration ? updateLabel(iteration) : "The single-deal agent");

const CHARTS = {
  heuristic: {
    height: 230,
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
};

if (ladder.length) {
  CHARTS["round-robin"] = {
    height: 230,
    xDomain: [0, ladder.at(-1).iteration],
    yDomain: paddedDomain(Math.min(0, ...ladder.map((d) => ladderBand(d)[1])), Math.max(0, ...ladder.map((d) => ladderBand(d)[2])), 2, 5),
    yFormat: signed(0),
    zeroLabel: "the single-deal agent",
    band: { color: BLUE, points: ladder.map(ladderBand) },
    series: [{ label: "Rubicon points / partie", color: BLUE, markers: true, hollowFirst: true, points: ladder.map((d) => [d.iteration, d.rating]) }],
    endLabels: true,
    valueFormat: signed(1),
    tooltip: (index) => {
      const row = ladder[index];
      return {
        title: checkpointLabel(row.iteration),
        rows: [
          { color: BLUE, label: "Points / partie vs update 0", value: row.iteration ? `${signed(1)(row.rating)} ± ${(1.96 * row.stderr).toFixed(1)}` : "±0" },
          { label: "Parties won vs the field", value: percentFine(row.wins) },
          { label: "Point margin vs the field", value: signed(1)(row.margin) },
        ],
      };
    },
  };
}

mountCharts(CHARTS);

const rrTable = document.querySelector('[data-chart-table="round-robin"]');
if (rrTable && rr) {
  const node = html("table", "", rrTable);
  const head = html("tr", "", html("thead", "", node));
  for (const label of ["Update", "Points / partie vs update 0", "Parties won", "Point margin", "Rubicons", "Rubiconed"]) html("th", "", head, label);
  const body = html("tbody", "", node);
  for (const row of ladder) {
    const tr = html("tr", "", body);
    html("td", "", tr, row.iteration ? row.iteration.toLocaleString("en-US") : "0 (single-deal agent)");
    html("td", "", tr, row.iteration ? `${signed(2)(row.rating)} ± ${(1.96 * row.stderr).toFixed(2)}` : "±0");
    html("td", "", tr, percentFine(row.wins));
    html("td", "", tr, signed(1)(row.margin));
    html("td", "", tr, percent(row.rubicons));
    html("td", "", tr, percent(row.rubiconed));
  }
}

const table = document.querySelector('[data-chart-table="heuristic"]');
if (table) {
  const node = html("table", "", table);
  const head = html("tr", "", html("thead", "", node));
  for (const label of ["Update", "Points / deal", "As Elder", "As Younger", "Deals won"]) html("th", "", head, label);
  const body = html("tbody", "", node);
  for (const row of deal.heuristic) {
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
const { source } = DATA;
fill("[data-training-parameters]", `${(DATA.parameters / 1e6).toFixed(1)}M`);
fill("[data-training-deals]", `${Math.round(deal.totals.games / 1e6)} million`);
fill("[data-training-hours]", `about ${Math.round(deal.totals.hours + (partie?.totals.hours ?? 0))} hours`);
fill("[data-live-checkpoint]", source.liveCheckpoint.toLocaleString("en-US"));
if (untrained) fill("[data-eval-untrained]", String(Math.round(-untrained.margin)));
if (partie) {
  const parties = partie.totals.games;
  fill("[data-partie-parties]", parties >= 1e6 ? `${(parties / 1e6).toFixed(1)} million` : `${Math.round(parties / 1000)} thousand`);
}
document.querySelectorAll("[data-rr-only]").forEach((node) => { node.hidden = !rr; });
if (rr) {
  const live = ladder.at(-1);
  fill("[data-rr-live]", `${signed(1)(live.rating)} ± ${(1.96 * live.stderr).toFixed(1)}`);
}
