import { render3D } from "./diagram3d.js";

// Draws the model's diagram spec as SVG. The spec is data only; every label goes in via textContent.

const NS = "http://www.w3.org/2000/svg";
const PAD = 24;
const COLORS = {
  main: "var(--studyx-peach)",
  secondary: "var(--studyx-fog)",
  faint: "var(--studyx-cloud)",
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

const FLAT = ["point", "vector", "segment", "line", "ray", "polygon", "circle", "curve", "angle", "text"];
const SPACE = ["point", "vector", "segment", "line", "ray", "polygon", "curve", "text", "sphere", "surface"];
const finite = (n) => typeof n === "number" && Number.isFinite(n);

// Same rules as the server's _clean_diagram, so a diagram still being streamed can never break drawing.
export function cleanDiagram(d) {
  if (!d || typeof d !== "object") return null;
  const kind = ["coordinate_plane", "number_line", "geometry", "space_3d"].includes(d.kind) ? d.kind : "geometry";
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
  };
}

export function renderDiagram(raw) {
  const d = cleanDiagram(raw);
  if (!d) return null;
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

  const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, class: numberLine ? "diagram numberline" : "diagram", role: "img", "aria-label": "Diagram for the question" });
  const defs = el("defs", {}, svg);
  for (const [name, color] of Object.entries(COLORS)) {
    const m = el("marker", { id: `${id}-${name}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
    el("path", { d: "M0 0 L10 5 L0 10 z", style: `fill:${color}` }, m);
  }
  const axisMarker = el("marker", { id: `${id}-axis`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" }, defs);
  el("path", { d: "M0 0 L10 5 L0 10 z", style: "fill:var(--studyx-mist)" }, axisMarker);
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
      el("circle", { cx: X(p[0][0]), cy: Y(p[0][1]), r: 4.5, style: `stroke:${color};fill:${open ? "var(--studyx-slate-raised)" : color}`, class: "dot" }, labels);
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
  return svg;
}
