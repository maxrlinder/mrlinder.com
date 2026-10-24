/** Shared SVG line charts for the "How the agent was trained" windows. */

const SVG_NS = "http://www.w3.org/2000/svg";
export const BLUE = "#3276a7";
export const RED = "#c73b32";

export const thousands = (value) => (value === 0 ? "0" : `${value / 1000}k`);
export const updateLabel = (value) => `Update ${Math.round(value).toLocaleString("en-US")}`;
export const signed = (digits) => (value) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}`;
export const fixed = (digits) => (value) => value.toFixed(digits);

/** Round a padded data range outward to a multiple of `step`. */
export const paddedDomain = (lo, hi, pad, step) => [
  Math.floor((lo - pad) / step) * step,
  Math.ceil((hi + pad) / step) * step,
];

function svg(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  parent?.append(node);
  return node;
}

export function html(name, className, parent, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent?.append(node);
  return node;
}

/** About five round ticks across a domain, steps of 1, 2, 2.5 or 5 × 10^k. */
function niceTicks([lo, hi], target = 5) {
  const raw = (hi - lo) / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw);
  const ticks = [];
  for (let value = Math.ceil(lo / step) * step; value <= hi + step * 1e-9; value += step) {
    ticks.push(Math.round(value / step) * step);
  }
  return ticks;
}

function legend(spec, parent) {
  if (spec.series.length < 2) return;
  const list = html("ul", "chart-legend", parent);
  for (const series of spec.series) {
    const item = html("li", "", list);
    html("span", "chart-key", item).style.background = series.color;
    item.append(series.label);
  }
}

export function drawChart(container, spec) {
  const width = Math.max(260, Math.round(container.clientWidth));
  const height = spec.height;
  const labelRoom = spec.endLabels ? 46 : 12;
  const margin = { top: 14, right: labelRoom, bottom: 26, left: 40 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const [x0, x1] = spec.xDomain;
  const [y0, y1] = spec.yDomain;
  const sx = (x) => margin.left + ((x - x0) / (x1 - x0)) * plotW;
  const sy = (y) => margin.top + (1 - (y - y0) / (y1 - y0)) * plotH;
  const valueFormat = spec.valueFormat || spec.yFormat;

  container.replaceChildren();
  legend(spec, container);
  const root = svg("svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    class: "chart-svg",
    tabindex: "0",
    role: "img",
    "aria-label": container.closest("figure")?.querySelector("figcaption")?.textContent.replace(/\s+/g, " ").trim() || "",
  }, container);

  const grid = svg("g", { class: "chart-grid" }, root);
  const axis = svg("g", { class: "chart-axis" }, root);
  for (const tick of niceTicks(spec.yDomain, height > 220 ? 6 : 4)) {
    const y = sy(tick);
    svg("line", { x1: margin.left, x2: margin.left + plotW, y1: y, y2: y, class: tick === 0 && spec.zeroLabel ? "is-zero" : "" }, grid);
    svg("text", { x: margin.left - 7, y: y + 3.5, "text-anchor": "end" }, axis).textContent = spec.yFormat(tick);
  }
  for (const tick of niceTicks(spec.xDomain, plotW < 300 ? 3 : 6)) {
    if (tick < x0 || tick > x1) continue;
    svg("text", { x: sx(tick), y: height - 8, "text-anchor": "middle" }, axis).textContent = (spec.xFormat ?? thousands)(tick);
  }
  svg("line", { x1: margin.left, x2: margin.left + plotW, y1: margin.top + plotH, y2: margin.top + plotH, class: "chart-baseline" }, root);
  if (spec.zeroLabel && plotW >= 480) {
    svg("text", { x: margin.left + 6, y: sy(0) - 6, class: "chart-note" }, root).textContent = spec.zeroLabel;
  }

  // Vertical rules mark where something changed (a new training setting).
  for (const rule of spec.rules || []) {
    const x = sx(rule.x);
    svg("line", { x1: x, x2: x, y1: margin.top, y2: margin.top + plotH, class: "chart-rule" }, root);
    if (rule.label && plotW >= 300) {
      svg("text", { x: x + 5, y: margin.top + 9, class: "chart-note" }, root).textContent = rule.label;
    }
  }

  if (spec.band) {
    const upper = spec.band.points.map(([x, , hi]) => `${sx(x)},${sy(hi)}`);
    const lower = spec.band.points.map(([x, lo]) => `${sx(x)},${sy(lo)}`).reverse();
    svg("polygon", { points: [...upper, ...lower].join(" "), fill: spec.band.color, class: "chart-band" }, root);
  }

  for (const series of spec.series) {
    const d = series.points.map(([x, y], i) => `${i ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join("");
    svg("path", { d, stroke: series.color, class: "chart-line" }, root);
    if (series.markers) {
      series.points.forEach(([x, y], i) => {
        const hollow = series.hollowFirst && i === 0;
        svg("circle", { cx: sx(x), cy: sy(y), r: 4, fill: hollow ? "#fbfbf7" : series.color, stroke: hollow ? series.color : "#fff", class: "chart-marker" }, root);
      });
    }
    if (spec.endLabels) {
      const [x, y] = series.points.at(-1);
      svg("text", { x: sx(x) + 8, y: sy(y) + 3.5, class: "chart-end" }, root).textContent = valueFormat(y);
    }
  }

  for (const note of spec.notes || []) {
    if (!note.text) continue;
    const [x, y] = spec.series[0].points[note.index];
    svg("text", { x: sx(x) + note.dx, y: sy(y) + note.dy, "text-anchor": note.anchor, class: "chart-note" }, root).textContent = note.text;
  }

  // Hover and keyboard layer: snap to the nearest sampled update.
  const xs = spec.series[0].points.map(([x]) => x);
  const cross = svg("line", { y1: margin.top, y2: margin.top + plotH, class: "chart-cross", visibility: "hidden" }, root);
  const dots = spec.series.map((series) =>
    svg("circle", { r: 4.5, fill: series.color, class: "chart-hover-dot", visibility: "hidden" }, root),
  );
  const tip = html("div", "chart-tooltip", container);
  tip.hidden = true;
  let current = -1;

  const show = (index) => {
    current = Math.max(0, Math.min(xs.length - 1, index));
    const x = sx(xs[current]);
    cross.setAttribute("x1", x);
    cross.setAttribute("x2", x);
    cross.setAttribute("visibility", "visible");
    spec.series.forEach((series, i) => {
      const point = series.points[current];
      if (!point) return;
      dots[i].setAttribute("cx", sx(point[0]));
      dots[i].setAttribute("cy", sy(point[1]));
      dots[i].setAttribute("visibility", "visible");
    });
    const content = spec.tooltip
      ? spec.tooltip(current)
      : {
          title: updateLabel(xs[current]),
          rows: spec.series.map((series) => ({
            color: series.color,
            label: series.label,
            value: valueFormat(series.points[current][1]),
          })),
        };
    tip.replaceChildren();
    html("strong", "", tip, content.title);
    for (const row of content.rows) {
      const line = html("span", "chart-tooltip-row", tip);
      const key = html("span", "chart-key", line);
      if (row.color) key.style.background = row.color;
      else key.classList.add("is-blank");
      html("span", "", line, row.label);
      html("b", "", line, row.value);
    }
    tip.hidden = false;
    const offset = root.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const tipW = tip.offsetWidth;
    const left = x + 12 + tipW > width ? x - 12 - tipW : x + 12;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${offset + margin.top}px`;
  };

  const hide = () => {
    current = -1;
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
    dots.forEach((dot) => dot.setAttribute("visibility", "hidden"));
  };

  const nearest = (clientX) => {
    const box = root.getBoundingClientRect();
    const value = x0 + ((clientX - box.left - margin.left) / plotW) * (x1 - x0);
    let best = 0;
    for (let i = 1; i < xs.length; i += 1) {
      if (Math.abs(xs[i] - value) < Math.abs(xs[best] - value)) best = i;
    }
    return best;
  };

  root.addEventListener("pointermove", (event) => show(nearest(event.clientX)));
  root.addEventListener("pointerleave", hide);
  root.addEventListener("blur", hide);
  root.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowRight") show(current < 0 ? 0 : current + step);
    else if (event.key === "ArrowLeft") show(current < 0 ? xs.length - 1 : current - step);
    else if (event.key === "Escape") hide();
    else return;
    event.preventDefault();
  });
}

/** Draw every [data-chart] element whose name is in `charts`, again on resize. */
export function mountCharts(charts) {
  for (const container of document.querySelectorAll("[data-chart]")) {
    const spec = charts[container.dataset.chart];
    if (!spec) continue;
    let lastWidth = 0;
    new ResizeObserver(() => {
      const width = Math.round(container.clientWidth);
      if (!width || width === lastWidth) return;
      lastWidth = width;
      drawChart(container, spec);
    }).observe(container);
  }
}
