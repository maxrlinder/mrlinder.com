/** Charts for the Piquet "How the agent was trained" window: single deals, then whole parties. */
import { PIQUET_TRAINING_DATA as DATA } from "./training-data.js?v=2";
import { BLUE, RED, html, mountCharts, paddedDomain, signed, updateLabel } from "../line-chart.js";

const GREEN = "#3e8a50";
const percent = (value) => `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
const { deal, partie } = DATA;
// The untrained network (update 0) is far below the rest; the copy quotes it instead.
const trained = deal.heuristic.filter((d) => d.iteration > 0);
const untrained = deal.heuristic.find((d) => d.iteration === 0);
const band = (d) => [d.iteration, d.margin - 1.96 * d.stderr, d.margin + 1.96 * d.stderr];
const last = deal.elderMargin.at(-1)[0];
// Fine-tune checkpoints against the single-deal agent they started from (update 0: that agent itself).
const against = partie?.against ?? [];
const partieBand = (d) => [d.iteration, d.payoff - 1.96 * d.stderr, d.payoff + 1.96 * d.stderr];

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
      { label: "Elder’s margin", color: BLUE, points: deal.elderMargin },
      { label: "Points per player", color: GREEN, points: deal.pointsPerDeal },
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
      { label: "Pique", color: BLUE, points: deal.pique },
      { label: "Repique", color: RED, points: deal.repique },
      { label: "Capot", color: GREEN, points: deal.capot },
    ],
    endLabels: true,
    valueFormat: percent,
  },
};

if (against.length > 1) {
  CHARTS.partie = {
    height: 230,
    xDomain: [0, paddedDomain(0, against.at(-1).iteration, 0, 100)[1]],
    yDomain: paddedDomain(Math.min(0, ...against.map((d) => partieBand(d)[1])), Math.max(0, ...against.map((d) => partieBand(d)[2])), 2, 10),
    xFormat: (v) => v.toLocaleString("en-US"),
    yFormat: signed(0),
    zeroLabel: "even with the single-deal agent",
    band: { color: BLUE, points: against.map(partieBand) },
    series: [{ label: "Rubicon points / partie", color: BLUE, markers: true, points: against.map((d) => [d.iteration, d.payoff]) }],
    valueFormat: signed(1),
    tooltip: (index) => {
      const row = against[index];
      if (!row.parties) return { title: updateLabel(0), rows: [{ color: BLUE, label: "The single-deal agent itself", value: "±0" }] };
      return {
        title: updateLabel(row.iteration),
        rows: [
          { color: BLUE, label: "Rubicon points / partie", value: `${signed(1)(row.payoff)} ± ${(1.96 * row.stderr).toFixed(1)}` },
          { label: "Parties won", value: percent(row.wins) },
          { label: "Parties played", value: row.parties.toLocaleString("en-US") },
        ],
      };
    },
  };
}

mountCharts(CHARTS);

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
fill("[data-training-hours]", `about ${Math.round(deal.totals.hours)} hours`);
fill("[data-training-decisions]", `${Math.round(deal.totals.decisions / 1e7) * 10} million`);
fill("[data-training-deals]", `${Math.round(deal.totals.games / 1e6)} million`);
fill("[data-deal-checkpoint]", (source.baseCheckpoint ?? source.liveCheckpoint).toLocaleString("en-US"));
fill("[data-live-checkpoint]", source.liveCheckpoint.toLocaleString("en-US"));
fill("[data-eval-deals]", deal.heuristic.at(-1).deals.toLocaleString("en-US"));
if (untrained) fill("[data-eval-untrained]", String(Math.round(-untrained.margin)));
document.querySelectorAll("[data-partie-only]").forEach((node) => { node.hidden = !partie; });
if (partie) {
  const hours = partie.totals.hours;
  fill("[data-partie-hours]", hours < 1.5 ? "about an hour" : `about ${Math.round(hours)} hours`);
  const parties = partie.totals.games;
  fill("[data-partie-parties]", parties >= 1e6 ? `${(parties / 1e6).toFixed(1)} million` : `${Math.round(parties / 1000)} thousand`);
  const live = against.at(-1);
  if (live?.parties) {
    fill("[data-partie-checkpoint]", live.iteration.toLocaleString("en-US"));
    fill("[data-partie-games]", live.parties.toLocaleString("en-US"));
    fill("[data-partie-live]", `${signed(1)(live.payoff)} ± ${(1.96 * live.stderr).toFixed(1)}`);
    fill("[data-partie-verdict]", Math.abs(live.payoff) <= 1.96 * live.stderr
      ? "about even with the agent it started from"
      : live.payoff > 0 ? "ahead of the agent it started from" : "behind the agent it started from, which never sees the score");
  }
}
