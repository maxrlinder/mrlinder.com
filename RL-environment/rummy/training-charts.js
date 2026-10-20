/** Charts for the Rummy "How the agent was trained" window. */
import { RUMMY_TRAINING_DATA as DATA } from "./training-data.js?v=1";
import { BLUE, RED, html, mountCharts, paddedDomain, signed, updateLabel } from "../line-chart.js";

const percent = (value) => `${Math.round(value * 100)}%`;

/** A field-centred ladder: rating line, 95% band, one marker per checkpoint. */
function ladder(points, { height, label, pad, step }) {
  return {
    height,
    xDomain: paddedDomain(points[0].iteration, points.at(-1).iteration, pad, 500),
    yDomain: paddedDomain(
      Math.min(...points.map((d) => d.low)),
      Math.max(...points.map((d) => d.high)),
      0.2,
      step,
    ),
    yFormat: signed(step < 1 ? 1 : 0),
    zeroLabel: "field average",
    band: { color: BLUE, points: points.map((d) => [d.iteration, d.low, d.high]) },
    series: [{ label, color: BLUE, markers: true, points: points.map((d) => [d.iteration, d.rating]) }],
    endLabels: true,
    valueFormat: signed(1),
    tooltip: (index) => {
      const row = points[index];
      return {
        title: updateLabel(row.iteration),
        rows: [
          { color: BLUE, label: "vs field", value: signed(2)(row.rating) },
          { label: "95% CI", value: `${signed(2)(row.low)} … ${signed(2)(row.high)}` },
        ],
      };
    },
  };
}

const CHARTS = {
  "round-robin": ladder(DATA.roundRobin, { height: 270, label: "Points per game vs field", pad: 900, step: 1 }),
  argmax: ladder(DATA.argmax, { height: 190, label: "Points per game vs field", pad: 600, step: 0.5 }),
  hold: {
    height: 190,
    xDomain: [DATA.holdRate[0][0] - 100, DATA.holdRate.at(-1)[0]],
    yDomain: [0, 0.6],
    yFormat: percent,
    series: [
      { label: "Any time", color: BLUE, points: DATA.holdRate },
      { label: "Opponent nearly out", color: RED, points: DATA.holdRateEndgame },
    ],
    endLabels: true,
    valueFormat: percent,
  },
};

mountCharts(CHARTS);

const table = document.querySelector('[data-chart-table="round-robin"]');
if (table) {
  const node = html("table", "", table);
  const head = html("tr", "", html("thead", "", node));
  for (const label of ["Update", "Points / game vs field", "95% interval"]) html("th", "", head, label);
  const body = html("tbody", "", node);
  for (const row of DATA.roundRobin) {
    const tr = html("tr", "", body);
    html("td", "", tr, row.iteration.toLocaleString("en-US"));
    html("td", "", tr, signed(2)(row.rating));
    html("td", "", tr, `${signed(2)(row.low)} … ${signed(2)(row.high)}`);
  }
}

// Copy that tracks the data, so a re-export or a model update cannot leave
// the prose describing older numbers than the charts.
const fill = (selector, text) => {
  for (const node of document.querySelectorAll(selector)) node.textContent = text;
};
const { totals, source } = DATA;
fill("[data-training-hours]", `about ${Math.round(totals.hours)} hours`);
fill("[data-training-decisions]", `${(totals.decisions / 1e9).toFixed(1)} billion`);
fill("[data-training-games]", `${Math.round(totals.games / 1e6)} million`);
fill("[data-live-checkpoint]", totals.liveCheckpoint.toLocaleString("en-US"));
fill("[data-rr-games]", source.tournament.games.toLocaleString("en-US"));
fill("[data-rr-first]", DATA.roundRobin[0].iteration.toLocaleString("en-US"));
fill("[data-rr-last]", DATA.roundRobin.at(-1).iteration.toLocaleString("en-US"));
fill("[data-rr-untrained]", String(Math.round(source.untrainedGap.points)));
