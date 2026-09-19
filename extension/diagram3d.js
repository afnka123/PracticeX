// Draws a "space_3d" diagram as SVG the student can rotate by dragging.
// Orthographic projection, z up, painter's algorithm for depth. The spec is data only; labels go in via
// textContent.

const NS = "http://www.w3.org/2000/svg";
const W = 420;
const MAX_H = 400;
const MARGIN = 26;
const DEFAULT_YAW = (-125 * Math.PI) / 180; // x toward the viewer and left, y to the right
const DEFAULT_PITCH = (24 * Math.PI) / 180;
const COLORS = {
  main: "var(--studyx-peach)",
  secondary: "var(--studyx-fog)",
  faint: "var(--studyx-cloud)",
};
// Surface shading runs from cloud (low) to peach (high); these are the brand tokens as RGB.
const LOW = [0x5a, 0x6e, 0x86];
const HIGH = [0xff, 0xd9, 0xc2];
const LIGHT = normalize([-0.35, -0.45, 0.82]);

let uid = 0;

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

function normalize(v) {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
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

function mix(t) {
  const c = LOW.map((lo, i) => Math.round(lo + (HIGH[i] - lo) * Math.min(1, Math.max(0, t))));
  return `rgb(${c.join(",")})`;
}

export function render3D(d) {
  const id = `d3${uid++}`;
  const lo = [d.x_min, d.y_min, d.z_min];
  const hi = [d.x_max, d.y_max, d.z_max];
  const center = lo.map((v, i) => (v + hi[i]) / 2);
  const ranges = lo.map((v, i) => hi[i] - v);
  // Equal scale keeps angles and lengths honest; fall back to per-axis scale when one axis would be squashed.
  const uniform = Math.max(...ranges) / Math.min(...ranges) <= 4;
  const scale = uniform ? ranges.map(() => 1 / Math.max(...ranges)) : ranges.map((r) => 1 / r);
  const N = (p) => p.map((v, i) => (v - center[i]) * scale[i]);

  // Size the view so the bounding box fills the width at the starting angle.
  const corners = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) corners.push([x, y, z]);
  let extentX = 0;
  let extentY = 0;
  for (const c of corners) {
    const [x, y, z] = N(c);
    const u = x * Math.cos(DEFAULT_YAW) - y * Math.sin(DEFAULT_YAW);
    const v = x * Math.sin(DEFAULT_YAW) + y * Math.cos(DEFAULT_YAW);
    extentX = Math.max(extentX, Math.abs(u));
    extentY = Math.max(extentY, Math.abs(z * Math.cos(DEFAULT_PITCH) + v * Math.sin(DEFAULT_PITCH)));
  }
  const S = Math.min((W / 2 - MARGIN) / extentX, (MAX_H / 2 - MARGIN) / extentY);
  const H = Math.round(2 * (extentY * S + MARGIN));

  const wrap = document.createElement("div");
  wrap.className = "diagram3d";
  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "diagram space",
    role: "img",
    tabindex: "0",
    "aria-label": "3D diagram. Drag or use the arrow keys to rotate; double-click to reset.",
  });
  const defs = el("defs", {}, svg);
  for (const [name, color] of Object.entries({ ...COLORS, axis: "var(--studyx-mist)" })) {
    const m = el("marker", { id: `${id}-${name}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
    el("path", { d: "M0 0 L10 5 L0 10 z", style: `fill:${color}` }, m);
  }
  const sphereFill = el("radialGradient", { id: `${id}-sphere`, cx: "35%", cy: "30%", r: "70%" }, defs);
  el("stop", { offset: "0%", "stop-color": "#FFD9C2", "stop-opacity": "0.55" }, sphereFill);
  el("stop", { offset: "100%", "stop-color": "#5A6E86", "stop-opacity": "0.25" }, sphereFill);
  const scene = el("g", {}, svg);
  const hint = document.createElement("p");
  hint.className = "diagram-hint mono";
  hint.textContent = "Drag to rotate · double-click to reset";
  wrap.append(svg, hint);

  let yaw = DEFAULT_YAW;
  let pitch = DEFAULT_PITCH;

  function draw() {
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    // Returns screen position and nearness (larger is closer to the viewer).
    const project = (p) => {
      const [x, y, z] = N(p);
      const u = x * cy - y * sy;
      const v = x * sy + y * cy;
      return { X: W / 2 + u * S, Y: H / 2 - (z * cp + v * sp) * S, d: -v * cp + z * sp };
    };
    const items = []; // { d, node }
    const labels = [];
    const addLabel = (text, p, dx = 8, dy = -8, cls = "dlabel") => {
      if (!text) return;
      const q = project(p);
      labels.push({ text, x: q.X + dx, y: q.Y + dy, cls });
    };
    const line = (a, b, attrs, depthBias = 0) => {
      const pa = project(a);
      const pb = project(b);
      items.push({ d: (pa.d + pb.d) / 2 + depthBias, node: el("line", { x1: pa.X, y1: pa.Y, x2: pb.X, y2: pb.Y, ...attrs }) });
    };
    // Clips the infinite line p + t·dir to the bounding box; returns [tMin, tMax] or null.
    const clip = (p, dir) => {
      let t0 = -Infinity;
      let t1 = Infinity;
      for (let i = 0; i < 3; i++) {
        if (Math.abs(dir[i]) < 1e-12) {
          if (p[i] < lo[i] || p[i] > hi[i]) return null;
          continue;
        }
        const a = (lo[i] - p[i]) / dir[i];
        const b = (hi[i] - p[i]) / dir[i];
        t0 = Math.max(t0, Math.min(a, b));
        t1 = Math.min(t1, Math.max(a, b));
      }
      return t0 <= t1 ? [t0, t1] : null;
    };
    const at = (p, dir, t) => p.map((v, i) => v + dir[i] * t);

    // Bounding box, faint
    for (let a = 0; a < 8; a++) {
      for (let b = a + 1; b < 8; b++) {
        const diff = corners[a].filter((v, i) => v !== corners[b][i]).length;
        if (diff === 1) line(corners[a], corners[b], { class: "box" }, -10);
      }
    }

    // Axes through the origin when it is inside the box, otherwise along the near-bottom edges.
    const origin = lo.map((v, i) => (v <= 0 && hi[i] >= 0 ? 0 : v));
    const names = [d.x_label || "x", d.y_label || "y", d.z_label || "z"];
    for (let i = 0; i < 3; i++) {
      const a = [...origin];
      const b = [...origin];
      a[i] = lo[i];
      b[i] = hi[i];
      line(a, b, { class: "axis", "marker-end": `url(#${id}-axis)` }, -5);
      const tip = [...b];
      tip[i] += ranges[i] * 0.07;
      addLabel(names[i], tip, -3, 4, "axis-name");
      const step = niceStep(ranges[i], 4);
      for (let t = Math.ceil(lo[i] / step) * step; t <= hi[i] + 1e-9; t += step) {
        if (Math.abs(t - origin[i]) < 1e-9) continue;
        const p = [...origin];
        p[i] = t;
        addLabel(fmt(t), p, 4, 12, "tick");
      }
    }

    for (const e of d.elements) {
      const color = COLORS[e.emphasis] || COLORS.main;
      const stroke = { style: `stroke:${color}`, class: `shape${e.dashed ? " dashed" : ""}${e.emphasis === "faint" ? " thin" : ""}` };
      const p = e.points;
      if (e.kind === "point") {
        const q = project(p[0]);
        items.push({ d: q.d + 0.02, node: el("circle", { cx: q.X, cy: q.Y, r: 4.5, class: "dot", style: `stroke:${color};fill:${e.dashed ? "var(--studyx-slate-raised)" : color}` }) });
        addLabel(e.label, p[0]);
      } else if ((e.kind === "vector" || e.kind === "segment") && p.length >= 2) {
        const attrs = { ...stroke };
        if (e.kind === "vector") attrs["marker-end"] = `url(#${id}-${e.emphasis})`;
        line(p[0], p[1], attrs, 0.01);
        addLabel(e.label, p[0].map((v, i) => v + (p[1][i] - v) * 0.6), 8, -8);
      } else if ((e.kind === "line" || e.kind === "ray") && p.length >= 2) {
        const dir = sub(p[1], p[0]);
        const span = clip(p[0], dir);
        if (!span) continue;
        const t0 = e.kind === "ray" ? Math.max(0, span[0]) : span[0];
        if (t0 > span[1]) continue;
        line(at(p[0], dir, t0), at(p[0], dir, span[1]), stroke, 0.01);
        addLabel(e.label, at(p[0], dir, t0 + (span[1] - t0) * 0.8));
      } else if (e.kind === "curve" && p.length >= 2) {
        // Split into short pieces so depth sorting works when the curve passes in front of a surface.
        for (let k = 0; k < p.length - 1; k++) line(p[k], p[k + 1], { ...stroke, "stroke-linecap": "round" }, 0.01);
        addLabel(e.label, p[p.length - 1]);
      } else if (e.kind === "polygon" && p.length >= 3) {
        const pts = p.map(project);
        const n = normalize(cross(sub(N(p[1]), N(p[0])), sub(N(p[2]), N(p[0]))));
        const light = 0.45 + 0.55 * Math.abs(n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
        items.push({
          d: pts.reduce((a, q) => a + q.d, 0) / pts.length,
          node: el("polygon", {
            points: pts.map((q) => `${q.X},${q.Y}`).join(" "),
            class: `face${e.dashed ? " dashed" : ""}`,
            style: `stroke:${color};fill:${color};fill-opacity:${(0.1 + 0.22 * light).toFixed(3)}`,
          }),
        });
        const c = p.reduce((a, q) => a.map((v, i) => v + q[i] / p.length), [0, 0, 0]);
        addLabel(e.label, c, 0, 0);
      } else if (e.kind === "sphere" && e.radius) {
        const q = project(p[0]);
        const r = e.radius * (scale[0] + scale[1] + scale[2]) / 3 * S;
        items.push({ d: q.d, node: el("circle", { cx: q.X, cy: q.Y, r, class: "sphere", style: `stroke:${color};fill:url(#${id}-sphere)` }) });
        addLabel(e.label, p[0].map((v, i) => (i === 2 ? v + e.radius : v)), 6, -6);
      } else if (e.kind === "surface" && e.grid_cols >= 2) {
        const cols = e.grid_cols;
        const rows = p.length / cols;
        const zs = p.map((q) => q[2]);
        const zLo = Math.min(...zs);
        const zSpan = Math.max(...zs) - zLo || 1;
        for (let r = 0; r < rows - 1; r++) {
          for (let c = 0; c < cols - 1; c++) {
            const quad = [p[r * cols + c], p[r * cols + c + 1], p[(r + 1) * cols + c + 1], p[(r + 1) * cols + c]];
            const pts = quad.map(project);
            const n = normalize(cross(sub(N(quad[1]), N(quad[0])), sub(N(quad[3]), N(quad[0]))));
            const light = 0.5 + 0.5 * Math.abs(n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
            const zMid = quad.reduce((a, q) => a + q[2], 0) / 4;
            const fill = e.emphasis === "main" ? mix((zMid - zLo) / zSpan) : color;
            items.push({
              d: pts.reduce((a, q) => a + q.d, 0) / 4,
              node: el("polygon", {
                points: pts.map((q) => `${q.X},${q.Y}`).join(" "),
                class: "mesh",
                style: `fill:${fill};fill-opacity:${(0.35 + 0.5 * light).toFixed(3)}`,
              }),
            });
          }
        }
        addLabel(e.label, p[p.length - 1]);
      } else if (e.kind === "text") {
        addLabel(e.label, p[0], 0, 0);
      }
    }

    items.sort((a, b) => a.d - b.d);
    const layer = document.createDocumentFragment();
    for (const it of items) layer.append(it.node);
    // Object labels first, then axis names and ticks; each is nudged down if it would overlap an earlier one.
    const placed = [];
    const order = [...labels.filter((l) => l.cls === "dlabel"), ...labels.filter((l) => l.cls !== "dlabel")];
    for (const l of order) {
      const w = l.text.length * (l.cls === "tick" ? 5.5 : 7.5);
      const h = l.cls === "tick" ? 10 : 15;
      let y = l.y;
      const hits = (yy) => placed.some((b) => l.x < b.x + b.w && l.x + w > b.x && yy - h / 2 < b.y + b.h / 2 && yy + h / 2 > b.y - b.h / 2);
      for (let k = 0; k < 4 && hits(y); k++) y += h;
      if (hits(y)) continue; // no room: skip rather than pile text on text
      placed.push({ x: l.x, y, w, h });
      const t = el("text", { x: l.x, y, class: l.cls, "dominant-baseline": "middle" });
      t.textContent = l.text;
      layer.append(t);
    }
    scene.replaceChildren(layer);
  }

  // Rotation
  let frame = 0;
  const redraw = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    }
  };
  const clampPitch = (v) => Math.max(-1.45, Math.min(1.45, v));
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    svg.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, yaw, pitch };
    svg.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
    pitch = clampPitch(drag.pitch + (e.clientY - drag.y) * 0.01);
    redraw();
  });
  const end = () => {
    drag = null;
    svg.classList.remove("dragging");
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("dblclick", () => {
    yaw = DEFAULT_YAW;
    pitch = DEFAULT_PITCH;
    redraw();
  });
  svg.addEventListener("keydown", (e) => {
    const step = 0.14;
    if (e.key === "ArrowLeft") yaw -= step;
    else if (e.key === "ArrowRight") yaw += step;
    else if (e.key === "ArrowUp") pitch = clampPitch(pitch - step);
    else if (e.key === "ArrowDown") pitch = clampPitch(pitch + step);
    else return;
    e.preventDefault();
    redraw();
  });

  // A short turn on first show makes it obvious the figure is 3D and can be rotated.
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const start = performance.now();
    const from = DEFAULT_YAW - 0.45;
    const spin = (now) => {
      if (drag) return;
      const t = Math.min(1, (now - start) / 700);
      yaw = from + (DEFAULT_YAW - from) * (1 - (1 - t) ** 3);
      draw();
      if (t < 1) requestAnimationFrame(spin);
    };
    yaw = from;
    requestAnimationFrame(spin);
  }
  draw();
  return wrap;
}
