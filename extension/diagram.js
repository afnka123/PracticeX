import { render3D } from "./diagram3d.js";
import { renderTable } from "./table.js";
import { controlBar } from "./diagram-ui.js";

// Draws the model's diagram spec as SVG. The spec is data only; every label goes in via textContent.

const NS = "http://www.w3.org/2000/svg";
const PAD = 24;
const COLORS = {
  main: "var(--practicex-peach)",
  secondary: "var(--practicex-fog)",
  faint: "var(--practicex-cloud)",
};

let uid = 0;

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

function niceStep(range, target) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

function fmt(n) {
  return String(Math.round(n * 1000) / 1000).replace("-", "−");
}

// A crossing is only as exact as the drawing it was read off, so it is not quoted to more than this.
function fmtRead(n) {
  return String(Math.round(n * 100) / 100).replace("-", "−");
}

const FLAT = ["point", "vector", "segment", "line", "ray", "polygon", "circle", "curve", "angle", "text"];
const MAX_TABLE_COLS = 8;
const MAX_TABLE_ROWS = 14;
const MAX_CELL = 160;
const SPACE = ["point", "vector", "segment", "line", "ray", "polygon", "curve", "text", "sphere", "surface"];
const finite = (n) => typeof n === "number" && Number.isFinite(n);

const cell = (v) =>
  typeof v === "string" || (typeof v === "number" && Number.isFinite(v))
    ? String(v).split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_CELL)
    : "";

// Same rules as the server's _clean_table.
function cleanTable(d) {
  const t = d.table;
  if (!t || typeof t !== "object") return null;
  let headers = (Array.isArray(t.headers) ? t.headers : [])
    .filter((h) => typeof h === "string")
    .map(cell)
    .slice(0, MAX_TABLE_COLS);
  const rawRows = (Array.isArray(t.rows) ? t.rows : []).filter(Array.isArray).slice(0, MAX_TABLE_ROWS);
  const cols = Math.min(headers.length || Math.max(0, ...rawRows.map((r) => r.length)), MAX_TABLE_COLS);
  if (cols < 2 || !rawRows.length) return null;
  if (headers.length) headers = Array.from({ length: cols }, (_, k) => headers[k] ?? "");
  const rows = [];
  for (const r of rawRows) {
    // Short rows are padded rather than dropped, so a table still draws while it is streaming.
    const row = Array.from({ length: cols }, (_, k) => cell(r[k]));
    if (row.some(Boolean)) rows.push(row);
  }
  if (!rows.length) return null;
  return {
    kind: "table",
    essential: Boolean(d.essential),
    x_min: null, x_max: null, y_min: null, y_max: null, z_min: null, z_max: null,
    show_grid: false,
    x_label: null, y_label: null, z_label: null,
    elements: [],
    table: {
      caption: t.caption ? String(t.caption).slice(0, 80) : null,
      headers,
      rows,
      row_labels: Boolean(t.row_labels),
    },
  };
}

// Same rules as the server's _clean_diagram, so a diagram still being streamed can never break drawing.
export function cleanDiagram(d) {
  if (!d || typeof d !== "object") return null;
  const kind = ["coordinate_plane", "number_line", "geometry", "space_3d", "table"].includes(d.kind) ? d.kind : "geometry";
  if (kind === "table") return cleanTable(d); // before the bounds check, which a table has no use for
  const space = kind === "space_3d";
  const axes = space ? ["x", "y", "z"] : ["x", "y"];
  const b = [];
  for (const a of axes) {
    const lo = d[`${a}_min`];
    const hi = d[`${a}_max`];
    if (!finite(lo) || !finite(hi) || lo >= hi) return null;
    b.push(lo, hi);
  }
  const dims = axes.length;
  const allowed = space ? SPACE : FLAT;
  const elements = [];
  for (const e of (Array.isArray(d.elements) ? d.elements : []).slice(0, 30)) {
    if (!e || !allowed.includes(e.kind)) continue;
    let points = (Array.isArray(e.points) ? e.points : [])
      .slice(0, e.kind === "surface" ? 900 : 400)
      .filter((p) => Array.isArray(p) && p.length === dims && p.every(finite));
    if (!points.length) continue;
    let cols = null;
    if (e.kind === "surface") {
      cols = e.grid_cols;
      if (!Number.isInteger(cols) || cols < 2 || cols > 30) continue;
      points = points.slice(0, points.length - (points.length % cols));
      if (points.length < cols * 2) continue;
    }
    elements.push({
      kind: e.kind,
      points,
      radius: finite(e.radius) && e.radius > 0 ? e.radius : null,
      grid_cols: cols,
      label: e.label ? String(e.label).slice(0, 40) : null,
      emphasis: ["main", "secondary", "faint"].includes(e.emphasis) ? e.emphasis : "main",
      dashed: Boolean(e.dashed),
    });
  }
  if (!elements.length) return null;
  return {
    kind,
    essential: Boolean(d.essential),
    x_min: b[0],
    x_max: b[1],
    y_min: b[2],
    y_max: b[3],
    z_min: space ? b[4] : null,
    z_max: space ? b[5] : null,
    show_grid: Boolean(d.show_grid),
    x_label: d.x_label ? String(d.x_label).slice(0, 20) : null,
    y_label: d.y_label ? String(d.y_label).slice(0, 20) : null,
    z_label: space && d.z_label ? String(d.z_label).slice(0, 20) : null,
    elements,
    table: null,
  };
}

// Where two straight pieces cross, in data coordinates. Endpoints count; parallels do not.
function crossing(a, b) {
  const [p, q] = a;
  const [r, t] = b;
  const d1 = [q[0] - p[0], q[1] - p[1]];
  const d2 = [t[0] - r[0], t[1] - r[1]];
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-12) return null; // parallel, or a piece with no length
  const u = ((r[0] - p[0]) * d2[1] - (r[1] - p[1]) * d2[0]) / den;
  const v = ((r[0] - p[0]) * d1[1] - (r[1] - p[1]) * d1[0]) / den;
  const eps = 1e-9;
  if (u < -eps || u > 1 + eps || v < -eps || v > 1 + eps) return null;
  return [p[0] + d1[0] * u, p[1] + d1[1] * u];
}

// Every point worth reading off: the ones the model marked, the corners and ends of what it drew,
// and wherever two of its pieces cross. The axes count as pieces, so intercepts are included.
function readablePoints(d, numberLine) {
  const pts = [];
  const segs = []; // { seg: [[x,y],[x,y]], from: element index }
  const xr = d.x_max - d.x_min;
  const yr = d.y_max - d.y_min;
  const add = (p, label, crossed) => {
    if (Array.isArray(p) && finite(p[0]) && finite(p[1])) pts.push({ x: p[0], y: p[1], label: label || null, crossed });
  };
  d.elements.forEach((e, k) => {
    const p = e.points;
    const line = (a, b) => segs.push({ seg: [a, b], from: k });
    if (e.kind === "point") add(p[0], e.label, false);
    else if ((e.kind === "segment" || e.kind === "vector") && p.length >= 2) {
      add(p[0], null, false);
      add(p[1], e.label, false);
      line(p[0], p[1]);
    } else if ((e.kind === "line" || e.kind === "ray") && p.length >= 2) {
      const [dx, dy] = [p[1][0] - p[0][0], p[1][1] - p[0][1]];
      const far = ((xr + yr) * 4) / (Math.hypot(dx, dy) || 1);
      const start = e.kind === "line" ? [p[0][0] - dx * far, p[0][1] - dy * far] : p[0];
      if (e.kind === "ray") add(p[0], null, false);
      line(start, [p[0][0] + dx * far, p[0][1] + dy * far]);
    } else if (e.kind === "polygon" && p.length >= 3) {
      p.forEach((q) => add(q, null, false));
      p.forEach((q, i) => line(q, p[(i + 1) % p.length]));
    } else if (e.kind === "curve" && p.length >= 2) {
      add(p[0], null, false);
      add(p[p.length - 1], e.label, false);
      for (let i = 1; i < p.length; i++) line(p[i - 1], p[i]);
    } else if (e.kind === "circle" && p[0]) {
      add(p[0], e.label, false);
    }
  });
  if (!numberLine) {
    if (d.y_min <= 0 && d.y_max >= 0) segs.push({ seg: [[d.x_min, 0], [d.x_max, 0]], from: -1 });
    if (d.x_min <= 0 && d.x_max >= 0) segs.push({ seg: [[0, d.y_min], [0, d.y_max]], from: -2 });
  }
  // Only across different elements: the joints inside one polygon or curve are not crossings.
  const list = segs.slice(0, 1600);
  for (let i = 0; i < list.length && pts.length < 200; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (list[i].from === list[j].from) continue;
      const hit = crossing(list[i].seg, list[j].seg);
      if (hit) add(hit, null, true);
    }
  }

  const tol = Math.max(xr, yr) / 2000;
  const seen = new Map();
  for (const pt of pts) {
    if (pt.x < d.x_min - tol || pt.x > d.x_max + tol) continue;
    if (!numberLine && (pt.y < d.y_min - tol || pt.y > d.y_max + tol)) continue;
    const key = `${Math.round(pt.x / tol)}:${Math.round(numberLine ? 0 : pt.y / tol)}`;
    const old = seen.get(key);
    // A marked point beats a bare crossing at the same spot, and a label beats no label.
    if (!old || (old.crossed && !pt.crossed) || (!old.label && pt.label)) seen.set(key, { ...old, ...pt });
  }
  return [...seen.values()].slice(0, 40);
}

export function renderDiagram(raw, opts = {}) {
  const d = cleanDiagram(raw);
  if (!d) return null;
  if (d.kind === "table") return renderTable(d, opts);
  if (d.kind === "space_3d") return render3D(d);
  const id = `dg${uid++}`;
  const numberLine = d.kind === "number_line";
  const xr = d.x_max - d.x_min;
  const yr = numberLine ? 1 : d.y_max - d.y_min;
  // Drawn at roughly panel size so text stays legible when the SVG scales to fit.
  const s = numberLine ? 340 / xr : Math.min(340 / xr, 280 / yr);
  const w = xr * s + PAD * 2;
  const h = numberLine ? 72 : yr * s + PAD * 2;
  const X = (x) => PAD + (x - d.x_min) * s;
  const Y = numberLine ? () => h / 2 : (y) => PAD + (d.y_max - y) * s;

  const svg = el("svg", {
    viewBox: `0 0 ${w} ${h}`,
    class: numberLine ? "diagram numberline" : "diagram",
    role: "img",
    tabindex: "0",
    "aria-label": "Diagram for the question. Click a marked point to read its value; + and − zoom.",
  });
  const defs = el("defs", {}, svg);
  for (const [name, color] of Object.entries(COLORS)) {
    const m = el("marker", { id: `${id}-${name}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
    el("path", { d: "M0 0 L10 5 L0 10 z", style: `fill:${color}` }, m);
  }
  const axisMarker = el("marker", { id: `${id}-axis`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" }, defs);
  el("path", { d: "M0 0 L10 5 L0 10 z", style: "fill:var(--practicex-mist)" }, axisMarker);
  const clip = el("clipPath", { id: `${id}-clip` }, defs);
  el("rect", { x: PAD - 6, y: numberLine ? 0 : PAD - 6, width: xr * s + 12, height: numberLine ? h : yr * s + 12 }, clip);

  // Grid, axes and ticks
  const xStep = niceStep(xr, numberLine ? 10 : 7);
  const yStep = niceStep(yr, 7);
  const axes = el("g", { class: "axes" }, svg);
  if (d.show_grid && !numberLine) {
    for (let x = Math.ceil(d.x_min / xStep) * xStep; x <= d.x_max + 1e-9; x += xStep) {
      el("line", { x1: X(x), x2: X(x), y1: Y(d.y_min), y2: Y(d.y_max), class: "grid" }, axes);
    }
    for (let y = Math.ceil(d.y_min / yStep) * yStep; y <= d.y_max + 1e-9; y += yStep) {
      el("line", { x1: X(d.x_min), x2: X(d.x_max), y1: Y(y), y2: Y(y), class: "grid" }, axes);
    }
  }
  const tick = (x, y, text, anchor, dx, dy) => {
    const t = el("text", { x: x + dx, y: y + dy, "text-anchor": anchor, class: "tick" }, axes);
    t.textContent = text;
  };
  if (numberLine) {
    el("line", { x1: PAD - 16, x2: w - PAD + 16, y1: h / 2, y2: h / 2, class: "axis", "marker-start": `url(#${id}-axis)`, "marker-end": `url(#${id}-axis)` }, axes);
    for (let x = Math.ceil(d.x_min / xStep) * xStep; x <= d.x_max + 1e-9; x += xStep) {
      el("line", { x1: X(x), x2: X(x), y1: h / 2 - 5, y2: h / 2 + 5, class: "axis" }, axes);
      tick(X(x), h / 2, fmt(x), "middle", 0, 22);
    }
  } else if (d.kind === "coordinate_plane") {
    if (d.y_min <= 0 && d.y_max >= 0) {
      el("line", { x1: X(d.x_min), x2: X(d.x_max) + 10, y1: Y(0), y2: Y(0), class: "axis", "marker-end": `url(#${id}-axis)` }, axes);
      for (let x = Math.ceil(d.x_min / xStep) * xStep; x <= d.x_max + 1e-9; x += xStep) {
        if (Math.abs(x) > 1e-9) tick(X(x), Y(0), fmt(x), "middle", 0, 15);
      }
      if (d.x_label) tick(X(d.x_max) + 10, Y(0), d.x_label, "end", 0, -8);
    }
    if (d.x_min <= 0 && d.x_max >= 0) {
      el("line", { x1: X(0), x2: X(0), y1: Y(d.y_min), y2: Y(d.y_max) - 10, class: "axis", "marker-end": `url(#${id}-axis)` }, axes);
      for (let y = Math.ceil(d.y_min / yStep) * yStep; y <= d.y_max + 1e-9; y += yStep) {
        if (Math.abs(y) > 1e-9) tick(X(0), Y(y), fmt(y), "end", -7, 4);
      }
      if (d.y_label) tick(X(0), Y(d.y_max) - 10, d.y_label, "start", 8, 4);
    }
  }

  // Elements
  const shapes = el("g", { "clip-path": `url(#${id}-clip)` }, svg);
  const labels = el("g", {}, svg);
  const label = (text, x, y, anchor = "middle") => {
    if (!text) return;
    const t = el("text", { x, y, "text-anchor": anchor, "dominant-baseline": "middle", class: "dlabel" }, labels);
    t.textContent = text;
  };
  // Label beside the midpoint of a segment, pushed out perpendicular to it.
  const sideLabel = (text, a, b) => {
    const [x1, y1, x2, y2] = [X(a[0]), Y(a[1]), X(b[0]), Y(b[1])];
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    label(text, (x1 + x2) / 2 - ((y2 - y1) / len) * 14, (y1 + y2) / 2 + ((x2 - x1) / len) * 14);
  };

  for (const e of d.elements) {
    const color = COLORS[e.emphasis] || COLORS.main;
    const stroke = { style: `stroke:${color}`, class: `shape${e.dashed ? " dashed" : ""}${e.emphasis === "faint" ? " thin" : ""}` };
    const p = e.points;
    if (e.kind === "point" && p[0]) {
      const open = e.dashed;
      el("circle", { cx: X(p[0][0]), cy: Y(p[0][1]), r: 4.5, style: `stroke:${color};fill:${open ? "var(--practicex-slate-raised)" : color}`, class: "dot" }, labels);
      label(e.label, X(p[0][0]) + 10, Y(p[0][1]) - (numberLine ? 16 : 10), numberLine ? "middle" : "start");
    } else if ((e.kind === "vector" || e.kind === "segment") && p.length >= 2) {
      const line = el("line", { x1: X(p[0][0]), y1: Y(p[0][1]), x2: X(p[1][0]), y2: Y(p[1][1]), ...stroke }, shapes);
      if (e.kind === "vector") line.setAttribute("marker-end", `url(#${id}-${e.emphasis})`);
      sideLabel(e.label, p[0], p[1]);
    } else if ((e.kind === "line" || e.kind === "ray") && p.length >= 2) {
      const [dx, dy] = [p[1][0] - p[0][0], p[1][1] - p[0][1]];
      const far = (xr + yr) * 4 / (Math.hypot(dx, dy) || 1);
      const start = e.kind === "line" ? [p[0][0] - dx * far, p[0][1] - dy * far] : p[0];
      const end = [p[0][0] + dx * far, p[0][1] + dy * far];
      el("line", { x1: X(start[0]), y1: Y(start[1]), x2: X(end[0]), y2: Y(end[1]), ...stroke }, shapes);
      sideLabel(e.label, p[0], p[1]);
    } else if (e.kind === "polygon" && p.length >= 3) {
      el("polygon", { points: p.map((q) => `${X(q[0])},${Y(q[1])}`).join(" "), ...stroke, style: `stroke:${color};fill:${color};fill-opacity:0.08` }, shapes);
      const cx = p.reduce((a, q) => a + q[0], 0) / p.length;
      const cy = p.reduce((a, q) => a + q[1], 0) / p.length;
      label(e.label, X(cx), Y(cy));
    } else if (e.kind === "circle" && p[0] && e.radius) {
      el("circle", { cx: X(p[0][0]), cy: Y(p[0][1]), r: e.radius * s, ...stroke, style: `stroke:${color};fill:none` }, shapes);
      label(e.label, X(p[0][0] + e.radius * 0.72) + 8, Y(p[0][1] + e.radius * 0.72) - 8, "start");
    } else if (e.kind === "curve" && p.length >= 2) {
      el("polyline", { points: p.map((q) => `${X(q[0])},${Y(q[1])}`).join(" "), ...stroke, style: `stroke:${color};fill:none` }, shapes);
      const last = p[p.length - 1];
      label(e.label, X(last[0]) - 6, Y(last[1]) - 12, "end");
    } else if (e.kind === "angle" && p.length >= 3) {
      // Angles in screen space, taking the shorter way round from a to b.
      const [a, v, b] = p;
      const [vx, vy] = [X(v[0]), Y(v[1])];
      const a1 = Math.atan2(Y(a[1]) - vy, X(a[0]) - vx);
      let a2 = Math.atan2(Y(b[1]) - vy, X(b[0]) - vx);
      let sweep = a2 - a1;
      while (sweep <= -Math.PI) sweep += 2 * Math.PI;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      a2 = a1 + sweep;
      const r = 22;
      el("path", {
        d: `M${vx + r * Math.cos(a1)} ${vy + r * Math.sin(a1)} A${r} ${r} 0 0 ${sweep > 0 ? 1 : 0} ${vx + r * Math.cos(a2)} ${vy + r * Math.sin(a2)}`,
        ...stroke,
        style: `stroke:${color};fill:none`,
      }, shapes);
      const mid = a1 + sweep / 2;
      label(e.label, vx + 38 * Math.cos(mid), vy + 38 * Math.sin(mid));
    } else if (e.kind === "text" && p[0]) {
      label(e.label, X(p[0][0]), Y(p[0][1]));
    }
  }

  // ---- what the student can do with it -------------------------------------------------------

  const wrap = document.createElement("div");
  wrap.className = "diagram2d";
  const base = { x: 0, y: 0, w, h };
  const view = { ...base };
  const MAX_ZOOM = 6;

  const applyView = () => {
    view.x = Math.max(base.x, Math.min(base.x + base.w - view.w, view.x));
    view.y = Math.max(base.y, Math.min(base.y + base.h - view.h, view.y));
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
    wrap.classList.toggle("zoomed", view.w < base.w - 0.5);
    // Points and labels stay their own size, so zooming reveals detail instead of magnifying ink.
    svg.style.setProperty("--dz", base.w / view.w);
  };
  const zoomBy = (factor, cx = view.x + view.w / 2, cy = view.y + view.h / 2) => {
    const next = Math.max(base.w / MAX_ZOOM, Math.min(base.w, view.w / factor));
    const k = next / view.w;
    view.x = cx - (cx - view.x) * k;
    view.y = cy - (cy - view.y) * k;
    view.w = next;
    view.h = base.h * (next / base.w);
    applyView();
  };
  const resetView = () => {
    Object.assign(view, base);
    applyView();
    select(null);
  };

  const readable = readablePoints(d, numberLine);
  const { bar, say } = controlBar({
    onZoom: (f) => zoomBy(f),
    onReset: resetView,
    hint: readable.length ? "Click a point to read it" : "Pinch or use + to zoom",
  });

  const hits = el("g", { class: "hits" }, svg);
  let chosen = null;
  function select(node, pt) {
    if (chosen) chosen.classList.remove("on");
    chosen = node && node !== chosen ? node : null;
    if (!chosen) return say("");
    chosen.classList.add("on");
    const f = pt.crossed ? fmtRead : fmt;
    const where = numberLine ? `x = ${f(pt.x)}` : `(${f(pt.x)}, ${f(pt.y)})`;
    say([pt.label, pt.crossed && !pt.label ? `crosses at about ${where}` : where].filter(Boolean).join(" · "));
  }

  for (const pt of readable) {
    const g = el("g", { class: `hit${pt.crossed ? " crossed" : ""}`, tabindex: "0", role: "button" }, hits);
    const [cx, cy] = [X(pt.x), Y(pt.y)];
    el("circle", { cx, cy, r: 4, class: "hit-dot" }, g);
    el("circle", { cx, cy, r: 13, class: "hit-area" }, g);
    const f = pt.crossed ? fmtRead : fmt;
    const where = numberLine ? `x = ${f(pt.x)}` : `${f(pt.x)}, ${f(pt.y)}`;
    g.setAttribute("aria-label", [pt.label, pt.crossed ? `crossing at about ${where}` : where].filter(Boolean).join(", "));
    const pick = (e) => {
      e.stopPropagation();
      select(g, pt);
    };
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      pick(e);
    });
  }

  // Pinch on a trackpad arrives as ctrl+wheel. A plain wheel still scrolls the panel.
  svg.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomBy(
        Math.exp(-e.deltaY * 0.012),
        view.x + ((e.clientX - r.left) / r.width) * view.w,
        view.y + ((e.clientY - r.top) / r.height) * view.h,
      );
    },
    { passive: false },
  );

  let pan = null;
  svg.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".hit")) return;
    if (view.w >= base.w - 0.5) return select(null); // not zoomed in: a click on the paper just clears
    svg.setPointerCapture(e.pointerId);
    pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, r: svg.getBoundingClientRect() };
    wrap.classList.add("panning");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!pan) return;
    view.x = pan.vx - ((e.clientX - pan.x) / pan.r.width) * view.w;
    view.y = pan.vy - ((e.clientY - pan.y) / pan.r.height) * view.h;
    applyView();
  });
  const endPan = () => {
    pan = null;
    wrap.classList.remove("panning");
  };
  svg.addEventListener("pointerup", endPan);
  svg.addEventListener("pointercancel", endPan);
  svg.addEventListener("dblclick", resetView);
  svg.addEventListener("keydown", (e) => {
    const step = view.w / 8;
    if (e.key === "+" || e.key === "=") zoomBy(1.4);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.4);
    else if (e.key === "0") resetView();
    else if (e.key === "ArrowLeft") view.x -= step;
    else if (e.key === "ArrowRight") view.x += step;
    else if (e.key === "ArrowUp") view.y -= step;
    else if (e.key === "ArrowDown") view.y += step;
    else return;
    e.preventDefault();
    applyView();
  });

  applyView();
  wrap.append(svg, bar);
  return wrap;
}
