/**
 * Charts for the Piquet "How the agent was trained" window (single deals, then whole parties)
 * and the "How it was played" window (the checkpoint round robin).
 */
import { PIQUET_TRAINING_DATA as DATA } from "./training-data.js?v=3";
import { BLUE, RED, html, mountCharts, paddedDomain, signed, updateLabel } from "../line-chart.js";

const GREEN = "#3e8a50";
const percent = (value) => `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
const percentFine = (value) => `${(value * 100).toFixed(1)}%`;
const percentAxis = (value) => `${Number((value * 100).toFixed(1))}%`;
const { deal, partie } = DATA;
// The untrained network (update 0) is far below the rest; the copy quotes it instead.
const trained = deal.heuristic.filter((d) => d.iteration > 0);
const untrained = deal.heuristic.find((d) => d.iteration === 0);
const band = (d) => [d.iteration, d.margin - 1.96 * d.stderr, d.margin + 1.96 * d.stderr];
const last = deal.elderMargin.at(-1)[0];
// The round robin: the single-deal agent (update 0 of the partie training) and checkpoints of the partie training.
const rr = partie?.roundRobin;
const ladder = rr?.checkpoints ?? [];
const ladderBand = (d) => [d.iteration, d.rating - 1.96 * d.stderr, d.rating + 1.96 * d.stderr];
const checkpointLabel = (iteration) => (iteration ? updateLabel(iteration) : "The single-deal agent");
// Dashed rules where the partie training changed its batch (192, then 576 parties per update).
const rules = (partie?.batches ?? []).slice(1).map(([update, parties]) => ({ x: update - 1, label: `${parties} parties / update` }));

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

if (ladder.length) {
  const xDomain = [0, ladder.at(-1).iteration];
  const field = (key, label, color) => ({ label, color, markers: true, points: ladder.map((d) => [d.iteration, d[key]]) });
  CHARTS["round-robin"] = {
    height: 270,
    xDomain,
    yDomain: paddedDomain(Math.min(0, ...ladder.map((d) => ladderBand(d)[1])), Math.max(0, ...ladder.map((d) => ladderBand(d)[2])), 2, 5),
    yFormat: signed(0),
    zeroLabel: "the single-deal agent",
    rules,
    band: { color: BLUE, points: ladder.map(ladderBand) },
    series: [{ ...field("rating", "Rubicon points / partie", BLUE), hollowFirst: true }],
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
  CHARTS["rr-wins"] = {
    height: 190,
    xDomain,
    yDomain: paddedDomain(Math.min(...ladder.map((d) => d.wins)), Math.max(...ladder.map((d) => d.wins)), 0.005, 0.01),
    yFormat: percentAxis,
    rules,
    series: [field("wins", "Parties won", BLUE)],
    endLabels: true,
    valueFormat: percentFine,
  };
  CHARTS["rr-rubicon"] = {
    height: 190,
    xDomain,
    yDomain: [0, paddedDomain(0, Math.max(...ladder.map((d) => Math.max(d.rubicons, d.rubiconed))), 0.01, 0.05)[1]],
    yFormat: percentAxis,
    rules,
    series: [field("rubicons", "Rubicons its opponent", BLUE), field("rubiconed", "Is rubiconed", RED)],
    endLabels: true,
    valueFormat: percentFine,
  };
}

mountCharts(CHARTS);

/** Mix a hex colour into the neutral midpoint: t = 0 is neutral, 1 the full colour. */
const NEUTRAL = [242, 241, 236];
const mix = (hex, t) => {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${rgb.map((c, i) => Math.round(NEUTRAL[i] + (c - NEUTRAL[i]) * t)).join(",")})`;
};

/** Who beats whom: each row's Rubicon points per partie against each column, blue where the row wins. */
function drawMatrix(container) {
  const iterations = ladder.map((d) => d.iteration);
  const n = iterations.length;
  const short = (iteration) => (iteration ? (iteration / 1000).toFixed(1) : "0");
  const width = Math.max(260, Math.round(container.clientWidth));
  const left = 34;
  const top = 32;
  const cell = Math.max(11, Math.min(26, Math.floor((width - left - 4) / n)));
  const size = cell * n;
  const values = rr.payoff.flat().filter((v) => v !== null);
  const limit = Math.ceil(Math.max(...values.map(Math.abs)) / 10) * 10;
  const color = (v) => mix(v >= 0 ? BLUE : RED, Math.min(1, Math.abs(v) / limit));

  container.replaceChildren();
  const ns = "http://www.w3.org/2000/svg";
  const node = (name, attrs, parent) => {
    const el = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    parent.append(el);
    return el;
  };
  const root = node("svg", {
    width: left + size + 4,
    height: top + size + 4,
    class: "chart-svg matrix-svg",
    tabindex: "0",
    role: "img",
    "aria-label": container.closest("figure")?.querySelector("figcaption")?.textContent.replace(/\s+/g, " ").trim() || "",
  }, container);
  const axis = node("g", { class: "chart-axis" }, root);
  const fontPx = cell < 16 ? 8 : 10;
  iterations.forEach((iteration, i) => {
    const middle = i * cell + cell / 2;
    node("text", { x: left - 5, y: top + middle + 3, "text-anchor": "end", "font-size": fontPx }, axis).textContent = short(iteration);
    node("text", { x: 0, y: 0, "text-anchor": "start", "font-size": fontPx, transform: `translate(${left + middle + 3},${top - 4}) rotate(-90)` }, axis).textContent = short(iteration);
  });
  const cells = node("g", {}, root);
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      const value = rr.payoff[row][col];
      node("rect", {
        x: left + col * cell, y: top + row * cell, width: cell - 1, height: cell - 1,
        fill: value === null ? "#fff" : color(value), class: value === null ? "matrix-self" : "",
      }, cells);
    }
  }
  const focus = node("rect", { width: cell + 1, height: cell + 1, class: "matrix-focus", visibility: "hidden" }, root);
  const tip = html("div", "chart-tooltip", container);
  tip.hidden = true;
  let current = null;

  const show = (row, col) => {
    row = Math.max(0, Math.min(n - 1, row));
    col = Math.max(0, Math.min(n - 1, col));
    current = [row, col];
    focus.setAttribute("x", left + col * cell - 1);
    focus.setAttribute("y", top + row * cell - 1);
    focus.setAttribute("visibility", "visible");
    tip.replaceChildren();
    html("strong", "", tip, `${checkpointLabel(iterations[row])} vs ${iterations[col] ? `update ${iterations[col].toLocaleString("en-US")}` : "the single-deal agent"}`);
    const value = rr.payoff[row][col];
    const line = html("span", "chart-tooltip-row", tip);
    const key = html("span", "chart-key", line);
    if (value === null) {
      key.classList.add("is-blank");
      html("span", "", line, "Itself");
    } else {
      key.style.background = color(value);
      html("span", "", line, "Rubicon points / partie");
      html("b", "", line, `${signed(1)(value)} ± ${(1.96 * rr.stderr[row][col]).toFixed(1)}`);
    }
    tip.hidden = false;
    const x = left + col * cell + cell;
    const tipW = tip.offsetWidth;
    tip.style.left = `${Math.max(0, x + 8 + tipW > width ? left + col * cell - 8 - tipW : x + 8)}px`;
    tip.style.top = `${top + row * cell}px`;
  };
  const hide = () => {
    current = null;
    tip.hidden = true;
    focus.setAttribute("visibility", "hidden");
  };
  root.addEventListener("pointermove", (event) => {
    const box = root.getBoundingClientRect();
    const col = Math.floor((event.clientX - box.left - left) / cell);
    const row = Math.floor((event.clientY - box.top - top) / cell);
    if (row < 0 || col < 0 || row >= n || col >= n) hide();
    else show(row, col);
  });
  root.addEventListener("pointerleave", hide);
  root.addEventListener("blur", hide);
  root.addEventListener("keydown", (event) => {
    const [row, col] = current ?? [n - 1, 0];
    const moves = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
    if (event.key === "Escape") hide();
    else if (moves[event.key]) show(row + (current ? moves[event.key][0] : 0), col + (current ? moves[event.key][1] : 0));
    else return;
    event.preventDefault();
  });

  const legend = html("div", "matrix-legend", container);
  html("span", "", legend, `Row loses ${signed(0)(-limit)}`);
  html("span", "matrix-ramp", legend).style.background = `linear-gradient(90deg, ${RED}, ${mix(RED, 0)}, ${BLUE})`;
  html("span", "", legend, `${signed(0)(limit)} row wins`);
}

const matrix = document.querySelector('[data-chart="rr-matrix"]');
if (matrix && rr) {
  let lastWidth = 0;
  new ResizeObserver(() => {
    const width = Math.round(matrix.clientWidth);
    if (!width || width === lastWidth) return;
    lastWidth = width;
    drawMatrix(matrix);
  }).observe(matrix);
}

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
}
document.querySelectorAll("[data-rr-only]").forEach((node) => { node.hidden = !rr; });
if (rr) {
  const live = ladder.at(-1);
  const count = ladder.length;
  fill("[data-rr-count]", String(count));
  fill("[data-rr-stage2]", String(count - 1));
  fill("[data-rr-pairings]", String((count * (count - 1)) / 2));
  fill("[data-rr-last]", live.iteration.toLocaleString("en-US"));
  fill("[data-rr-per-pair]", rr.perPair.toLocaleString("en-US"));
  fill("[data-rr-parties]", rr.parties.toLocaleString("en-US"));
  fill("[data-rr-live]", `${signed(1)(live.rating)} ± ${(1.96 * live.stderr).toFixed(1)}`);
  fill("[data-rr-live-wins]", percentFine(live.wins));
  fill("[data-rr-base-wins]", percentFine(ladder[0].wins));
  fill("[data-rr-live-rubiconed]", percentFine(live.rubiconed));
  fill("[data-rr-base-rubiconed]", percentFine(ladder[0].rubiconed));
  let laterWins = 0;
  rr.payoff.forEach((row, later) => row.forEach((value, earlier) => { if (earlier < later && value > 0) laterWins += 1; }));
  fill("[data-rr-later-wins]", String(laterWins));
}
