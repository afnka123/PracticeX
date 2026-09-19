import { renderDiagram } from "./diagram.js";
import { parsePartialJson } from "./partial-json.js";

const DEFAULT_SERVER = "http://localhost:8787";
const MAX_IMAGE_SIDE = 1568; // larger images are downscaled by the model provider anyway
const PAGE_ID = crypto.randomUUID(); // tells this page's own storage writes apart from other windows'
const PARAMS = new URLSearchParams(location.search);
const FOCUS = PARAMS.has("focus"); // fullscreen practice window
const CROP = PARAMS.has("crop"); // large window used only to select the problem on a screenshot
// Unpacked (developer) builds have no update_url. Only they show the model, server and founder settings.
const DEV = !("update_url" in chrome.runtime.getManifest());
const HISTORY_MAX = 40; // sets kept on this device
const PROBLEM_FIELDS = ["question", "diagram", "answer", "accepted_answers", "approach", "steps", "check", "common_mistake"];

const $ = (id) => document.getElementById(id);

// Practice session. Kept in session storage so it survives closing the panel and is shared with focus mode.
let state = {
  view: "start",
  model: "",
  difficulty: "same",
  topic: "",
  problems: [],
  expected: 0, // problems asked for; more than problems.length while a set is still streaming
  streaming: false,
  index: 0,
  revealed: [],
  work: [],
  attempts: [],
  checks: [], // per problem: { attempt, verdict, feedback } from Check answer
  diagramOpen: [],
  madeDiagrams: [], // diagrams drawn on request with "Make me a diagram"
  stepsOpen: [], // per problem: which steps are expanded
  setId: "",
  image: null, // last cropped screenshot, for "More like these"
  prereq: null, // { topic, data, streaming, live }
};
let prefs = { textScale: 1, count: 3, verbosity: "standard" };
const VERBOSITY_HINTS = {
  brief: "Short steps with just the key move and the math.",
  standard: "Each step says what to do and why, with every line of algebra.",
  detailed: "Every move explained, including the ones you might do in your head.",
};
const drawing = new Set(); // "setId:index" of diagrams being drawn on request
let settings = { serverUrl: DEFAULT_SERVER, founderToken: "" };
let installId = "";
let config = null;
let shot = null; // { dataUrl, sel: {x, y, w, h} in 0..1 or null, requester }
let cropWindowId = null;
let viewBeforeCrop = "start";
let viewBeforeHistory = "start";
let viewBeforeSettings = "start";
let history = []; // finished sets, most recently practised first; kept in chrome.storage.local

// ---------------------------------------------------------------- storage

async function loadStorage() {
  const local = await chrome.storage.local.get(["installId", "settings", "prefs", "history"]);
  history = Array.isArray(local.history) ? local.history : [];
  installId = local.installId;
  if (!installId) {
    installId = crypto.randomUUID();
    await chrome.storage.local.set({ installId });
  }
  settings = { ...settings, ...(local.settings || {}) };
  prefs = { ...prefs, ...(local.prefs || {}) };
  const session = await chrome.storage.session.get("state");
  if (session.state) state = { ...state, ...session.state.data };
  state.problems = state.problems.map((p) => ({ ...p, steps: toSteps(p.steps) })); // sessions saved before step titles
  if (state.streaming) {
    // The panel closed mid-stream: keep only the problems that finished.
    state.problems = state.problems.filter((p) => p._done?.all);
    state.expected = state.problems.length;
    state.streaming = false;
    state.index = Math.min(state.index, Math.max(0, state.problems.length - 1));
  }
  if (state.prereq?.streaming) state.prereq = null;
  if (TRANSIENT_VIEWS.includes(state.view) || (state.view === "problem" && !state.problems.length)) {
    state.view = state.problems.length ? "problem" : "start";
  }
}

const TRANSIENT_VIEWS = ["crop", "settings", "waiting", "history"];

function save() {
  chrome.storage.session.set({ state: { writer: PAGE_ID, data: state } });
  recordHistory();
}

function savePrefs() {
  chrome.storage.local.set({ prefs });
}

function watchStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.history) {
      history = changes.history.newValue || [];
      if (state.view === "history") renderHistory();
      else if (state.view === "start") renderRecent();
      return;
    }
    if (area !== "session") return;

    // The crop window finished: generate from its selection.
    const crop = changes.cropResult?.newValue;
    if (crop?.requester === PAGE_ID) {
      chrome.storage.session.remove("cropResult");
      cropWindowId = null;
      generate(crop.image);
      return;
    }

    // Keep the side panel and the focus window on the same problem.
    if (!changes.state?.newValue) return;
    const { writer, data } = changes.state.newValue;
    if (writer === PAGE_ID || state.streaming || state.prereq?.streaming) return;
    if (TRANSIENT_VIEWS.includes(state.view)) return; // do not yank the student mid-task
    state = { ...state, ...data };
    renderCurrent({ quiet: true });
  });

  chrome.windows.onRemoved.addListener((id) => {
    if (id !== cropWindowId) return;
    cropWindowId = null;
    // Closed without a selection (a selection, if any, arrives before the window closes).
    setTimeout(() => {
      if (state.view === "waiting") {
        state.view = viewBeforeCrop;
        renderCurrent();
      }
    }, 300);
  });
}

// ---------------------------------------------------------------- server

class ServerError extends Error {
  constructor(message, status, resetsAt) {
    super(message);
    this.status = status;
    this.resetsAt = resetsAt;
  }
}

function serverBase() {
  return settings.serverUrl.replace(/\/+$/, "");
}

async function request(path, body, signal) {
  const headers = { "X-StudyX-Install": installId };
  if (body) headers["Content-Type"] = "application/json";
  if (settings.founderToken) headers["X-StudyX-Founder"] = settings.founderToken;
  try {
    return await fetch(serverBase() + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ServerError(`The StudyX server is not reachable at ${serverBase()}. Check Settings.`, 0);
  }
}

async function readError(res) {
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (data.usage) setUsage(data.usage);
  return new ServerError(data.error || `The server returned ${res.status}.`, res.status, data.resets_at);
}

async function api(path, body) {
  const res = await request(path, body);
  if (!res.ok) throw await readError(res);
  const data = await res.json();
  if (data.usage) setUsage(data.usage);
  return data;
}

// Streams a model response. onText gets each new piece of the model's JSON; resolves with the final result.
async function streamApi(path, body, onText, signal) {
  const res = await request(path, body, signal);
  if (!res.ok) throw await readError(res);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "meta") setUsage(event.usage);
      else if (event.type === "delta") onText(event.text);
      else if (event.type === "done") return event.result;
      else if (event.type === "error") throw new ServerError(event.error, 502);
    }
  }
  throw new ServerError("The connection closed before the answer finished. Try again.", 0);
}

function formatTime(epochSeconds) {
  return new Date(epochSeconds * 1000)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .replace(/\s?[AP]M$/i, "");
}

function describeError(err) {
  if (err.status === 429 && err.resetsAt) {
    const limit = config?.usage?.limit;
    const lead = limit ? `${limit} per hour.` : err.message;
    return `${lead} Resets at ${formatTime(err.resetsAt)}.`;
  }
  return err.message;
}

function setUsage(usage) {
  if (!config) config = {};
  config.usage = usage;
  const left = Math.max(0, usage.limit - usage.used);
  const counter = $("counter");
  counter.textContent = `${left}/${usage.limit}`;
  counter.title = `${left} of ${usage.limit} left this hour`;
  counter.classList.toggle("empty", left === 0);
  $("generate").disabled = left === 0;
}

// Runs fn at most once every `ms` while triggered; cancel() drops a pending run.
function throttle(fn, ms) {
  let timer = null;
  const trigger = () => {
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    }
  };
  trigger.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return trigger;
}

// ---------------------------------------------------------------- rich text and math

// While a field is still streaming, hold back a formula whose closing delimiter has not arrived yet,
// so raw LaTeX never flashes on screen.
function hideOpenMath(text) {
  let cut = text.length;
  for (const [open, close] of [["\\(", "\\)"], ["\\[", "\\]"]]) {
    const at = text.lastIndexOf(open);
    if (at >= 0 && text.indexOf(close, at + 2) < 0) cut = Math.min(cut, at);
  }
  return text.slice(0, cut);
}

// Model text is set with textContent (never innerHTML); MathJax then renders the \( \) and \[ \] parts.
// Unchanged text is skipped, so re-rendering while streaming only touches the part that grew.
function setRich(node, text, live = false) {
  text = String(text || "");
  if (live) text = hideOpenMath(text);
  node.classList.toggle("live", live);
  if (node.dataset.src === text) return;
  node.dataset.src = text;
  if (window.MathJax?.typesetClear) MathJax.typesetClear([node]);
  node.replaceChildren(
    ...text
      .split(/\n\s*\n/)
      .map((para) => {
        const p = document.createElement("p");
        p.textContent = para.trim();
        return p;
      })
      .filter((p) => p.textContent),
  );
  typeset(node);
}

let typesetQueue = Promise.resolve();
function typeset(node) {
  typesetQueue = typesetQueue
    .then(() => window.MathJax?.startup?.promise)
    .then(() => window.MathJax?.typesetPromise?.([node]))
    .then(() => fitInlineMath(node))
    .catch((err) => console.warn("MathJax:", err));
}

function fitInlineMath(root) {
  for (const m of root.querySelectorAll('mjx-container:not([display="true"])')) {
    // Browsers may break a line right after an inline SVG, stranding "." or "," on the next line.
    const next = m.nextSibling;
    const punct = next?.nodeType === Node.TEXT_NODE && next.data.match(/^[.,;:!?)\]]+/);
    if (punct && !m.parentElement.classList.contains("nobr")) {
      const glue = document.createElement("span");
      glue.className = "nobr";
      m.replaceWith(glue);
      glue.append(m, punct[0]);
      next.data = next.data.slice(punct[0].length);
    }
    const box = m.closest("p") || root;
    m.classList.toggle("too-wide", m.getBoundingClientRect().width > box.clientWidth);
  }
}

// Loose comparison of a typed answer with the model's LaTeX answer.
function normalizeAnswer(text) {
  return String(text)
    .replace(/\\[()[\]]/g, "")
    .replace(/\\(left|right|displaystyle|,|;|!|quad|qquad)/g, "")
    .replace(/\\d?frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)")
    .replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)")
    .replace(/\\langle|⟨/g, "<")
    .replace(/\\rangle|⟩/g, ">")
    .replace(/\\(cdot|times)|×|·/g, "*")
    .replace(/\\pi/g, "π")
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/[{}\\$]/g, "")
    .replace(/[−–]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\((-?[\w.]+)\)/g, "$1")
    .replace(/^[a-z]=/, "")
    .replace(/[.]$/, "");
}

// A lone number, as typed or as the model wrote it: "0.5", "1/2", "\frac{1}{2}", "x = -3".
function numericValue(text) {
  const t = normalizeAnswer(text).replace(/[()]/g, "");
  const m = t.match(/^(-?\d*\.?\d+)(?:\/(-?\d*\.?\d+))?$/);
  if (!m) return null;
  const v = m[2] === undefined ? Number(m[1]) : Number(m[1]) / Number(m[2]);
  return Number.isFinite(v) ? v : null;
}

// Marks an answer right without a request when it matches the answer or one of the forms the model listed
// when it wrote the problem. Returns false when unsure, so the model can judge it instead.
function quickCheck(attempt, p) {
  const typed = normalizeAnswer(attempt);
  if (!typed) return false;
  if ([p.answer, ...(p.accepted_answers || [])].some((a) => normalizeAnswer(a) === typed)) return true;
  const want = numericValue(p.answer);
  const got = numericValue(attempt);
  return want !== null && got !== null && Math.abs(want - got) <= 1e-9 * Math.max(1, Math.abs(want));
}

// ---------------------------------------------------------------- general UI

function notice(text) {
  const el = $("notice");
  el.textContent = text || "";
  el.hidden = !text;
}

function show(view, { quiet = false } = {}) {
  state.view = view;
  for (const section of document.querySelectorAll(".view")) {
    section.hidden = section.id !== `view-${view}`;
  }
  if (!quiet && !CROP && !["crop", "waiting"].includes(view)) save();
}

function renderCurrent(opts) {
  if (state.view === "problem" && (state.problems.length || state.streaming)) renderProblem(opts);
  else if (state.view === "prereq" && state.prereq) renderPrereq(opts);
  else renderStart(opts);
}

function button(label, kind, onClick, disabled = false) {
  const b = document.createElement("button");
  b.className = `btn ${kind}`;
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

function applyTextScale() {
  document.documentElement.style.setProperty("--content-scale", prefs.textScale);
  $("text-size").value = prefs.textScale;
  $("text-size-value").textContent = `${Math.round(prefs.textScale * 100)}%`;
}

function applyCount({ animate = false } = {}) {
  const v = prefs.count;
  $("count").value = v;
  $("count-field").style.setProperty("--v", v);
  $("count-readout").textContent = v;
  $("count").setAttribute("aria-valuetext", `${v} problem${v > 1 ? "s" : ""}`);
  [...$("count-ticks").children].forEach((t, i) => {
    t.classList.toggle("on", i + 1 <= v);
    t.classList.toggle("current", i + 1 === v);
  });
  if (animate) {
    for (const node of [$("count-wrap"), $("count-readout")]) {
      node.classList.remove("pop");
      void node.offsetWidth; // restart the animation
      node.classList.add("pop");
    }
  }
}

// ---------------------------------------------------------------- start

function startOver() {
  notice("");
  shot = null;
  renderStart();
}

function renderModels() {
  const select = $("model");
  select.replaceChildren();
  const models = config?.models || [];
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    select.append(opt);
  }
  if (!models.some((m) => m.id === state.model)) state.model = config?.default_model || "";
  select.value = state.model;
  select.disabled = models.length === 0;
}

function renderStart(opts) {
  renderModels();
  const usage = config?.usage;
  if (usage && usage.used >= usage.limit && usage.resets_at) {
    notice(`${usage.limit} per hour. Resets at ${formatTime(usage.resets_at)}.`);
  }
  for (const b of $("difficulty").querySelectorAll("button")) {
    b.setAttribute("aria-checked", String(b.dataset.value === state.difficulty));
  }
  applyCount();
  renderRecent();
  show("start", opts);
}

async function capture() {
  notice("");
  // Must be the first call in the click handler: Chrome only shows the prompt during a user gesture.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
  } catch {}
  if (!granted) {
    notice("StudyX needs permission to see the page before it can read the problem.");
    return;
  }
  let dataUrl;
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: "jpeg", quality: 92 });
  } catch {
    notice("Chrome does not allow screenshots of this page. Open the problem in a normal tab and try again.");
    return;
  }

  if (FOCUS) {
    // Focus mode is already fullscreen, so select in place.
    shot = { dataUrl, sel: null };
    $("shot").src = dataUrl;
    $("crop-box").hidden = true;
    if (state.view !== "crop") viewBeforeCrop = state.view;
    show("crop");
    return;
  }

  // The side panel is too narrow to select comfortably: open a window that fills most of the screen.
  await chrome.storage.session.set({ pendingShot: { dataUrl, requester: PAGE_ID } });
  const width = Math.round(screen.availWidth * 0.94);
  const height = Math.round(screen.availHeight * 0.94);
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("panel.html?crop=1"),
    type: "popup",
    width,
    height,
    left: Math.round((screen.availLeft || 0) + (screen.availWidth - width) / 2),
    top: Math.round((screen.availTop || 0) + (screen.availHeight - height) / 2),
    focused: true,
  });
  cropWindowId = win?.id ?? null;
  if (state.view !== "waiting") viewBeforeCrop = state.view;
  show("waiting", { quiet: true });
}

// ---------------------------------------------------------------- crop

function setupCrop() {
  const area = $("crop");
  const box = $("crop-box");
  let start = null;

  const point = (e) => {
    const r = area.getBoundingClientRect();
    return {
      x: Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1),
      y: Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1),
    };
  };
  const draw = (sel) => {
    box.hidden = false;
    box.style.left = `${sel.x * 100}%`;
    box.style.top = `${sel.y * 100}%`;
    box.style.width = `${sel.w * 100}%`;
    box.style.height = `${sel.h * 100}%`;
  };

  area.addEventListener("pointerdown", (e) => {
    area.setPointerCapture(e.pointerId);
    start = point(e);
    shot.sel = null;
    box.hidden = true;
  });
  area.addEventListener("pointermove", (e) => {
    if (!start) return;
    const p = point(e);
    const sel = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    shot.sel = sel;
    draw(sel);
  });
  area.addEventListener("pointerup", () => {
    start = null;
    const r = area.getBoundingClientRect();
    // Treat a click or tiny drag as "no selection".
    if (shot.sel && (shot.sel.w * r.width < 12 || shot.sel.h * r.height < 12)) {
      shot.sel = null;
      box.hidden = true;
    }
  });
}

async function cropToJpeg(dataUrl, sel) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const sx = sel ? sel.x * img.naturalWidth : 0;
  const sy = sel ? sel.y * img.naturalHeight : 0;
  const sw = sel ? sel.w * img.naturalWidth : img.naturalWidth;
  const sh = sel ? sel.h * img.naturalHeight : img.naturalHeight;
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
}

async function send(useSelection) {
  if (!shot) return;
  if (useSelection && !shot.sel) {
    notice("Drag over the problem first, or use the whole page.");
    return;
  }
  notice("");
  const image = await cropToJpeg(shot.dataUrl, useSelection ? shot.sel : null);
  if (CROP) {
    // Hand the selection back to the panel that asked for it, then get out of the way.
    await chrome.storage.session.set({ cropResult: { requester: shot.requester, image, at: Date.now() } });
    await chrome.storage.session.remove("pendingShot");
    window.close();
    return;
  }
  generate(image);
}

function cancelCrop() {
  if (CROP) {
    window.close();
    return;
  }
  notice("");
  shot = null;
  state.view = viewBeforeCrop;
  renderCurrent();
}

// ---------------------------------------------------------------- generating (streamed)

let generation = null; // AbortController for the set being written

// Turns one partially written problem into a display object. A field is finished once the model has
// moved on to a later field; the whole problem is finished once the next problem has started.
function toProblem(raw, complete) {
  const keys = Object.keys(raw || {});
  const last = keys.at(-1);
  const done = { all: complete };
  for (const f of PROBLEM_FIELDS) done[f] = complete || (keys.includes(f) && f !== last);
  return {
    question: typeof raw.question === "string" ? raw.question : "",
    diagram: raw.diagram && typeof raw.diagram === "object" ? raw.diagram : null,
    answer: typeof raw.answer === "string" ? raw.answer : "",
    accepted_answers: Array.isArray(raw.accepted_answers) ? raw.accepted_answers.filter((a) => typeof a === "string") : [],
    approach: typeof raw.approach === "string" ? raw.approach : "",
    steps: toSteps(raw.steps),
    _stepLive: last === "steps" && !complete ? Object.keys(raw.steps?.at?.(-1) || {}).at(-1) || "title" : null,
    check: typeof raw.check === "string" ? raw.check : "",
    common_mistake: typeof raw.common_mistake === "string" ? raw.common_mistake : "",
    _done: done,
    _live: complete ? null : last,
  };
}

function toSteps(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((s) => (typeof s === "string" ? { title: "", detail: s } : s && typeof s === "object" ? s : null))
    .filter(Boolean)
    .map((s) => ({ title: typeof s.title === "string" ? s.title : "", detail: typeof s.detail === "string" ? s.detail : "" }));
}

function setProblems(rawList, complete) {
  state.problems = rawList.map((p, k) => toProblem(p, complete || k < rawList.length - 1));
  const n = Math.max(state.problems.length, state.expected);
  const fills = { revealed: false, work: false, attempts: "", checks: null, diagramOpen: null, madeDiagrams: null, stepsOpen: null };
  for (const [key, fill] of Object.entries(fills)) {
    if (!Array.isArray(state[key])) state[key] = [];
    while (state[key].length < n) state[key].push(fill);
  }
}

async function generate(image) {
  generation?.abort();
  const controller = new AbortController();
  generation = controller;
  const before = structuredClone(state);
  if (["waiting", "crop"].includes(before.view)) before.view = viewBeforeCrop;
  notice("");
  shot = null;
  Object.assign(state, {
    topic: "",
    problems: [],
    expected: prefs.count,
    streaming: true,
    index: 0,
    revealed: [],
    work: [],
    attempts: [],
    checks: [],
    diagramOpen: [],
    madeDiagrams: [],
    stepsOpen: [],
    setId: crypto.randomUUID(),
    image,
    prereq: null,
  });
  setProblems([], false);
  renderProblem();
  window.scrollTo({ top: 0 });

  let text = "";
  const redraw = throttle(() => {
    const partial = parsePartialJson(text);
    if (!partial || generation !== controller) return;
    if (typeof partial.topic === "string") state.topic = partial.topic;
    const raw = Array.isArray(partial.problems) ? partial.problems.filter((p) => p && typeof p === "object") : [];
    setProblems(raw, false);
    if (state.view === "problem") renderProblem();
  }, 70);

  try {
    const result = await streamApi(
      "/v1/generate",
      {
        image,
        media_type: "image/jpeg",
        model: state.model,
        difficulty: state.difficulty,
        count: prefs.count,
        verbosity: prefs.verbosity,
      },
      (delta) => {
        text += delta;
        redraw();
      },
      controller.signal,
    );
    redraw.cancel();
    if (generation !== controller) return;
    generation = null;
    if (!result.readable) {
      state = before;
      notice("No math problem found there. Select just the problem and try again.");
      renderCurrent();
      return;
    }
    state.topic = result.topic;
    state.streaming = false;
    state.expected = result.problems.length;
    setProblems(result.problems, true);
    if (state.view === "problem") renderProblem();
    else save();
  } catch (err) {
    redraw.cancel();
    if (err.name === "AbortError" || generation !== controller) return;
    generation = null;
    state = before;
    notice(describeError(err));
    renderCurrent();
  }
}

function moreLikeThese(difficulty) {
  notice("");
  if (difficulty) state.difficulty = difficulty;
  if (!state.image) {
    startOver();
    return;
  }
  generate(state.image);
}

// ---------------------------------------------------------------- problem

const CHEVRON =
  '<svg class="step-chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Each step shows only its title; clicking it opens the explanation underneath.
function renderSteps(i, p) {
  const list = $("steps");
  const steps = p.steps;
  if (!Array.isArray(state.stepsOpen[i])) state.stepsOpen[i] = [];
  const open = state.stepsOpen[i];
  if (list.children.length > steps.length) {
    if (window.MathJax?.typesetClear) MathJax.typesetClear([list]);
    list.replaceChildren();
  }
  steps.forEach((step, k) => {
    let li = list.children[k];
    if (!li) {
      li = document.createElement("li");
      li.className = "step";
      const head = document.createElement("button");
      head.className = "step-head";
      const title = document.createElement("span");
      title.className = "step-title content";
      head.append(title);
      head.insertAdjacentHTML("beforeend", CHEVRON);
      head.addEventListener("click", () => {
        const s = state.stepsOpen[state.index];
        s[k] = !s[k];
        renderProblem();
      });
      const body = document.createElement("div");
      body.className = "step-body content";
      li.append(head, body);
      list.append(li);
    }
    const [head, body] = li.children;
    const isLive = p._live === "steps" && k === steps.length - 1;
    const expanded = Boolean(open[k]);
    li.classList.toggle("open", expanded);
    head.setAttribute("aria-expanded", String(expanded));
    setRich(head.firstChild, step.title || `Step ${k + 1}`, isLive && p._stepLive === "title");
    body.hidden = !expanded;
    if (expanded) setRich(body, step.detail, isLive && p._stepLive === "detail");
  });
  const allOpen = steps.length > 0 && steps.every((_, k) => open[k]);
  $("toggle-steps").textContent = allOpen ? "Close all" : "Open all";
  $("toggle-steps").hidden = steps.length < 2;
}

function toggleAllSteps() {
  const i = state.index;
  const n = state.problems[i]?.steps.length || 0;
  const allOpen = n > 0 && Array.from({ length: n }, (_, k) => state.stepsOpen[i]?.[k]).every(Boolean);
  state.stepsOpen[i] = Array.from({ length: n }, () => !allOpen);
  renderProblem();
}

function renderDiagramArea(i, p) {
  const toggle = $("diagram-toggle");
  const label = $("diagram-toggle-label");
  const wrap = $("diagram");
  const diagram = p?.diagram || state.madeDiagrams[i] || null;
  const hideAll = () => {
    toggle.hidden = true;
    wrap.hidden = true;
  };
  if (!p || !p._done.question) return hideAll();

  toggle.hidden = false;
  toggle.disabled = false;
  toggle.removeAttribute("aria-expanded");
  if (drawing.has(`${state.setId}:${i}`) || (p.diagram && !p._done.diagram)) {
    toggle.disabled = true;
    toggle.dataset.action = "";
    label.textContent = "Drawing diagram";
    wrap.hidden = true;
    return;
  }
  if (!diagram) {
    // The model left this one without a figure; the student can still ask for one.
    if (!p._done.diagram) return hideAll();
    toggle.dataset.action = "make";
    label.textContent = "Make me a diagram";
    wrap.hidden = true;
    return;
  }

  // Essential figures ("the graph shown") start open; the rest wait behind the button.
  if (state.diagramOpen[i] == null) state.diagramOpen[i] = Boolean(diagram.essential);
  const open = state.diagramOpen[i];
  toggle.dataset.action = "toggle";
  toggle.setAttribute("aria-expanded", String(open));
  label.textContent = open ? "Hide diagram" : "View diagram";
  wrap.hidden = !open;
  const key = `${i}:${JSON.stringify(diagram)}`;
  if (open && wrap.dataset.src !== key) {
    wrap.dataset.src = key;
    const svg = renderDiagram(diagram);
    wrap.replaceChildren(...(svg ? [svg] : []));
    if (!svg) hideAll();
  }
}

async function makeDiagram() {
  const i = state.index;
  const p = state.problems[i];
  const setId = state.setId;
  const key = `${setId}:${i}`;
  if (!p || drawing.has(key)) return;
  drawing.add(key);
  notice("");
  renderProblem();
  try {
    const data = await api("/v1/diagram", { model: state.model, topic: state.topic, question: p.question });
    if (state.setId === setId) {
      state.madeDiagrams[i] = data.diagram;
      state.diagramOpen[i] = true;
    }
  } catch (err) {
    if (state.setId === setId) notice(describeError(err));
  } finally {
    drawing.delete(key);
    if (state.setId === setId && state.view === "problem") renderProblem({ quiet: state.streaming });
  }
}

function renderProblem(opts) {
  const i = state.index;
  const p = state.problems[i];
  const total = Math.max(state.expected, state.problems.length);
  const revealed = Boolean(p && state.revealed[i]);
  const attempt = state.attempts[i] || "";
  const isLast = i >= total - 1;
  const writing = !p || !p.question; // nothing to show for this question yet

  $("q-label").textContent = `Question ${i + 1} of ${total}`;
  $("q-topic").textContent = state.topic || "";

  $("typing").hidden = !writing;
  $("typing-label").textContent = !state.problems.length ? "Reading the problem" : `Writing question ${i + 1}`;
  $("question").hidden = writing;
  if (p) setRich($("question"), p.question, p._live === "question");
  renderDiagramArea(i, p);

  // Setting an unchanged value would move the caret, so only write it when it differs.
  if ($("attempt").value !== attempt) $("attempt").value = attempt;
  $("attempt").readOnly = revealed;
  $("attempt-field").hidden = writing || (revealed && !attempt);
  renderCheckResult(i);

  $("reveal").hidden = !revealed;
  if (revealed) {
    setRich($("answer"), p.answer, p._live === "answer");
    const matched = state.checks[i]?.verdict === "correct" || quickCheck(attempt, p);
    $("match").hidden = !(p._done.answer && attempt && matched);
    const showWork = state.work[i];
    $("work").hidden = !showWork;
    if (showWork) {
      for (const [id, field] of [["approach", "approach"], ["check", "check"], ["mistake", "common_mistake"]]) {
        setRich($(id), p[field], p._live === field);
        $(id).parentElement.hidden = !p[field] && p._live !== field;
      }
      renderSteps(i, p);
      $("steps").parentElement.hidden = !p.steps.length && p._live !== "steps";
    }
  }

  renderActions();

  const status = $("stream-status");
  status.hidden = !state.streaming;
  if (state.streaming) status.textContent = `Writing ${Math.max(1, state.problems.length)} of ${total}`;

  $("open-prereq").hidden = !p?._done.question;
  $("open-report").hidden = !p?._done.all;
  if (!p?._done.all) $("report").hidden = true;
  // Previous and Next keep their slots when they do not apply, so the bar never shifts.
  $("prev").classList.toggle("ghost", i === 0);
  $("prev").disabled = i === 0;
  $("next").classList.toggle("ghost", isLast);
  $("next").disabled = isLast;
  $("next").classList.toggle("emph", revealed && !isLast);

  // Needs the screenshot, which is not kept with sets reopened from history.
  $("more-card").hidden = !state.image || state.streaming;
  for (const b of $("more-options").children) {
    const main = isLast && revealed && b.dataset.value === "same"; // the one coral button at the end of a set
    b.className = `btn ${main ? "primary" : "secondary"}`;
  }
  renderProgress(i, total);
  show("problem", { quiet: opts?.quiet || state.streaming });
}

function renderProgress(current, total) {
  const bar = $("q-progress");
  while (bar.children.length > total) bar.lastChild.remove();
  while (bar.children.length < total) {
    const k = bar.children.length;
    const b = document.createElement("button");
    b.addEventListener("click", () => {
      if (k !== state.index) go(k);
    });
    bar.append(b);
  }
  [...bar.children].forEach((b, k) => {
    const p = state.problems[k];
    const correct = state.checks[k]?.verdict === "correct";
    b.className = [
      k === current ? "current" : "",
      correct ? "correct" : state.revealed[k] ? "viewed" : "",
      state.streaming && !p?._done.all ? "pending" : "",
    ].join(" ");
    const status = correct ? ", answered correctly" : state.revealed[k] ? ", answer viewed" : !p ? ", still being written" : "";
    b.setAttribute("aria-label", `Question ${k + 1}${status}`);
    if (k === current) b.setAttribute("aria-current", "step");
    else b.removeAttribute("aria-current");
  });
}

// The buttons under the answer box. Re-rendered on every keystroke, so it touches nothing else.
function renderActions() {
  const i = state.index;
  const p = state.problems[i];
  const actions = $("problem-actions");
  actions.replaceChildren();
  if (!p || !p.question) return;
  const ready = p._done.answer;

  if (!state.revealed[i]) {
    const typed = (state.attempts[i] || "").trim().length > 0;
    if (!ready) {
      actions.append(button("Writing answer", "primary", () => {}, true));
    } else if (typed) {
      const busy = checking.has(`${state.setId}:${i}`);
      actions.append(button(busy ? "Checking" : "Check answer", "primary", checkAnswer, busy));
      actions.append(button("View answer", "secondary", reveal));
    } else {
      actions.append(button("View answer", "primary", reveal));
    }
    return;
  }
  actions.append(
    button(state.work[i] ? "Hide work" : "Show work", "secondary", () => {
      state.work[i] = !state.work[i];
      renderProblem();
    }),
  );
}

function renderCheckResult(i) {
  const result = state.checks[i];
  const box = $("attempt-box");
  // A result only stands while the student's answer is the one that was checked.
  const current = result && result.attempt === (state.attempts[i] || "").trim();
  $("check-result").hidden = !current;
  box.classList.toggle("correct", Boolean(current && result.verdict === "correct"));
  if (!current) return;
  const verdict = $("check-verdict");
  verdict.className = `label verdict ${result.verdict}`;
  verdict.textContent = { correct: "Correct", partly: "Partly right", incorrect: "Not quite" }[result.verdict];
  setRich($("check-feedback"), result.feedback);
  $("check-feedback").hidden = !result.feedback;
}

const checking = new Set(); // "setId:index" of answers being checked

function flash(kind) {
  const box = $("attempt-box");
  box.classList.remove("flash", "miss");
  void box.offsetWidth; // restart the animation
  box.classList.add(kind);
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => box.classList.remove(kind), kind === "flash" ? 3200 : 500);
}

async function checkAnswer() {
  const i = state.index;
  const p = state.problems[i];
  const attempt = (state.attempts[i] || "").trim();
  const setId = state.setId;
  const key = `${setId}:${i}`;
  if (!p?._done.answer || !attempt || checking.has(key)) return;
  notice("");

  let result;
  if (quickCheck(attempt, p)) {
    // One of the forms the model listed with the problem: no need to ask it again.
    result = { verdict: "correct", feedback: "" };
  } else {
    checking.add(key);
    renderActions();
    try {
      const data = await api("/v1/check", { model: state.model, question: p.question, answer: p.answer, attempt });
      result = { verdict: data.verdict, feedback: data.feedback };
    } catch (err) {
      if (state.setId === setId) notice(describeError(err));
    } finally {
      checking.delete(key);
    }
  }
  if (state.setId !== setId) return;
  if (result) {
    state.checks[i] = { attempt, ...result };
    if (result.verdict === "correct") state.revealed[i] = true;
  }
  if (state.index !== i || state.view !== "problem") {
    save();
    return;
  }
  renderProblem({ quiet: state.streaming });
  if (result) flash(result.verdict === "correct" ? "flash" : "miss");
}

function reveal() {
  state.revealed[state.index] = true;
  renderProblem();
}

function go(i) {
  state.index = i;
  notice("");
  $("report").hidden = true;
  renderProblem();
  window.scrollTo({ top: 0 });
}

function onDiagramButton() {
  if ($("diagram-toggle").dataset.action === "make") {
    makeDiagram();
    return;
  }
  const i = state.index;
  state.diagramOpen[i] = !state.diagramOpen[i];
  renderProblem();
}

async function report(reason) {
  const p = state.problems[state.index];
  $("report").hidden = true;
  try {
    await api("/v1/report", {
      reason,
      model: state.model,
      topic: state.topic,
      question: p.question,
      answer: p.answer,
      steps: [p.approach, ...p.steps.map((s) => `${s.title}: ${s.detail}`), p.check],
    });
    notice("Reported. Thank you. The question will be reviewed.");
  } catch (err) {
    notice(describeError(err));
  }
}

// ---------------------------------------------------------------- prerequisite (streamed)

let prereqStream = null;

function toPrereq(raw, complete) {
  const keys = Object.keys(raw || {});
  const list = Array.isArray(raw?.prerequisites) ? raw.prerequisites.filter((x) => x && typeof x === "object") : [];
  let live = null;
  if (!complete && keys.at(-1) === "summary") live = "summary";
  if (!complete && keys.at(-1) === "prerequisites" && list.length) live = Object.keys(list.at(-1)).at(-1) || "name";
  return {
    summary: typeof raw?.summary === "string" ? raw.summary : "",
    prerequisites: list.map((x) => ({ name: String(x.name || ""), explanation: String(x.explanation || "") })),
    video_searches: complete && Array.isArray(raw?.video_searches) ? raw.video_searches.map(String) : [],
    live,
  };
}

async function openPrereq() {
  notice("");
  if (state.prereq && state.prereq.topic === state.topic && state.prereq.verbosity === prefs.verbosity) {
    renderPrereq();
    window.scrollTo({ top: 0 });
    return;
  }
  prereqStream?.abort();
  const controller = new AbortController();
  prereqStream = controller;
  const question = state.problems[state.index].question;
  const topic = state.topic;
  const verbosity = prefs.verbosity;
  state.prereq = { topic, verbosity, streaming: true, ...toPrereq({ summary: "" }, false) };
  renderPrereq();
  window.scrollTo({ top: 0 });

  let text = "";
  const redraw = throttle(() => {
    const partial = parsePartialJson(text);
    if (!partial || prereqStream !== controller) return;
    Object.assign(state.prereq, toPrereq(partial, false));
    if (state.view === "prereq") renderPrereq();
  }, 70);

  try {
    const result = await streamApi(
      "/v1/prerequisite",
      { model: state.model, topic, question, verbosity },
      (delta) => {
        text += delta;
        redraw();
      },
      controller.signal,
    );
    redraw.cancel();
    if (prereqStream !== controller) return;
    prereqStream = null;
    state.prereq = { topic, verbosity, streaming: false, ...toPrereq(result, true) };
    if (state.view === "prereq") renderPrereq();
    else save();
  } catch (err) {
    redraw.cancel();
    if (err.name === "AbortError" || prereqStream !== controller) return;
    prereqStream = null;
    state.prereq = null;
    notice(describeError(err));
    renderProblem();
  }
}

function renderPrereq(opts) {
  const pr = state.prereq;
  $("prereq-label").textContent = pr.topic ? `Before ${pr.topic}` : "Before this";
  setRich($("prereq-summary"), pr.summary, pr.live === "summary" || (pr.streaming && !pr.summary));

  const list = $("prereq-list");
  if (list.children.length > pr.prerequisites.length) list.replaceChildren();
  pr.prerequisites.forEach((item, k) => {
    let card = list.children[k];
    if (!card) {
      card = document.createElement("div");
      card.className = "card";
      const h = document.createElement("h3");
      const body = document.createElement("div");
      body.className = "content";
      card.append(h, body);
      list.append(card);
    }
    const isLast = k === pr.prerequisites.length - 1;
    card.firstChild.textContent = item.name;
    setRich(card.lastChild, item.explanation, isLast && pr.live === "explanation");
  });

  // Links are searches, not model-written URLs, so they never point at a page that does not exist.
  const links = pr.video_searches.map((q) => ({
    text: q,
    src: "YouTube",
    href: "https://www.youtube.com/results?search_query=" + encodeURIComponent(q),
  }));
  if (pr.topic && !pr.streaming) {
    links.push({
      text: pr.topic,
      src: "Khan Academy",
      href: "https://www.khanacademy.org/search?page_search_query=" + encodeURIComponent(pr.topic),
    });
  }
  $("prereq-videos").replaceChildren(
    ...links.map((l) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = l.href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = l.text;
      const src = document.createElement("span");
      src.className = "src";
      src.textContent = l.src;
      li.append(a, src);
      return li;
    }),
  );
  $("prereq-videos-wrap").hidden = links.length === 0;
  show("prereq", { quiet: opts?.quiet || pr.streaming });
}

// ---------------------------------------------------------------- history and progress
// Finished sets are kept on this device (never the screenshot), so a student can see what they have practised,
// how often they got it right, and reopen a set to try it again.

const pendingHistory = new Map(); // setId -> entry waiting to be written
let historyTimer = null;

function dayKey(time) {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function historyEntry() {
  const n = state.problems.length;
  return {
    id: state.setId,
    updated: Date.now(),
    topic: state.topic || "Practice set",
    difficulty: state.difficulty,
    problems: state.problems.map(({ _done, _live, _stepLive, ...p }) => p),
    revealed: Array.from({ length: n }, (_, k) => Boolean(state.revealed[k])),
    checks: Array.from({ length: n }, (_, k) => state.checks[k] || null),
    attempts: Array.from({ length: n }, (_, k) => state.attempts[k] || ""),
    made: Array.from({ length: n }, (_, k) => state.madeDiagrams[k] || null),
  };
}

// Called from save(). Writes are batched, since save() runs on every keystroke in the answer box.
function recordHistory() {
  if (CROP || state.streaming || !state.setId || !state.problems.length) return;
  pendingHistory.set(state.setId, historyEntry());
  clearTimeout(historyTimer);
  historyTimer = setTimeout(flushHistory, 400);
}

async function flushHistory() {
  clearTimeout(historyTimer);
  if (!pendingHistory.size) return;
  const entries = [...pendingHistory.values()];
  pendingHistory.clear();
  // Read the stored list rather than our copy, so the side panel and focus window do not overwrite each other.
  const stored = (await chrome.storage.local.get("history")).history;
  let list = Array.isArray(stored) ? stored : [];
  for (const entry of entries) {
    const old = list.find((h) => h.id === entry.id);
    // Only real practice counts toward the streak and moves a set up the list, not just reopening it.
    const progress = (h) => JSON.stringify([h.revealed, h.checks, h.attempts, h.made]);
    const practised = !old || progress(old) !== progress(entry);
    const days = [...new Set([...(old?.days || []), ...(practised ? [dayKey(entry.updated)] : [])])];
    const updated = practised ? entry.updated : old.updated;
    list = [{ ...entry, updated, at: old?.at ?? entry.updated, days }, ...list.filter((h) => h.id !== entry.id)];
    list.sort((x, y) => y.updated - x.updated);
  }
  history = list.slice(0, HISTORY_MAX);
  await chrome.storage.local.set({ history });
}

function setScore(h) {
  const correct = h.checks.filter((c) => c?.verdict === "correct").length;
  const answered = h.revealed.filter(Boolean).length;
  return { correct, answered, total: h.problems.length };
}

function streak() {
  const days = new Set(history.flatMap((h) => h.days || [dayKey(h.at)]));
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // today does not break a streak until it is over
  let n = 0;
  while (days.has(dayKey(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function formatWhen(time) {
  const d = new Date(time);
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 864e5);
  const clock = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (dayKey(time) === today) return `Today ${clock}`;
  if (dayKey(time) === yesterday) return `Yesterday ${clock}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function setRow(h) {
  const { correct, answered, total } = setScore(h);
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.className = "set-row";
  const main = document.createElement("span");
  main.className = "set-main";
  const topic = document.createElement("span");
  topic.className = "set-topic";
  topic.textContent = h.topic;
  const meta = document.createElement("span");
  meta.className = "set-meta mono";
  const level = { easier: "Easier", same: "", harder: "Harder" }[h.difficulty] || "";
  meta.textContent = [formatWhen(h.updated), level].filter(Boolean).join(" · ");
  main.append(topic, meta);
  const score = document.createElement("span");
  score.className = "set-score mono";
  score.textContent = answered ? `${correct}/${total}` : "New";
  score.title = answered ? `${correct} right of ${total}, ${answered} answered` : "Not tried yet";
  score.classList.toggle("done", total > 0 && correct === total);
  b.append(main, score);
  b.setAttribute("aria-label", `${h.topic}, ${meta.textContent}, ${score.title}. Open this set.`);
  b.addEventListener("click", () => openHistorySet(h.id));
  li.append(b);
  return li;
}

function renderRecent() {
  $("recent").hidden = history.length === 0;
  $("recent-sets").replaceChildren(...history.slice(0, 3).map(setRow));
}

function renderHistory() {
  let correct = 0;
  let answered = 0;
  const topics = new Map();
  for (const h of history) {
    const s = setScore(h);
    correct += s.correct;
    answered += s.answered;
    const key = h.topic.toLowerCase();
    const t = topics.get(key) || { name: h.topic, sets: 0, correct: 0, answered: 0 };
    t.sets++;
    t.correct += s.correct;
    t.answered += s.answered;
    topics.set(key, t);
  }
  $("stat-solved").textContent = correct;
  $("stat-accuracy").textContent = answered ? `${Math.round((100 * correct) / answered)}%` : "–";
  $("stat-streak").textContent = streak();

  $("history-empty").hidden = history.length > 0;
  $("topics-wrap").hidden = topics.size === 0;
  $("sets-wrap").hidden = history.length === 0;
  $("clear-history").hidden = history.length === 0;
  $("clear-history").textContent = "Clear history";
  delete $("clear-history").dataset.armed;

  $("topics").replaceChildren(
    ...[...topics.values()]
      .sort((a, b) => b.sets - a.sets)
      .map((t) => {
        const li = document.createElement("li");
        li.className = "topic-row";
        const name = document.createElement("span");
        name.className = "topic-name";
        name.textContent = t.name;
        const meta = document.createElement("span");
        meta.className = "set-meta mono";
        meta.textContent = `${t.sets} set${t.sets > 1 ? "s" : ""} · ${t.answered ? `${t.correct}/${t.answered} right` : "not tried"}`;
        const bar = document.createElement("span");
        bar.className = "topic-bar";
        bar.style.setProperty("--p", t.answered ? t.correct / t.answered : 0);
        bar.setAttribute("aria-hidden", "true");
        li.append(name, meta, bar);
        return li;
      }),
  );
  $("sets").replaceChildren(...history.map(setRow));
  show("history");
}

async function openHistory() {
  notice("");
  await flushHistory(); // include the set on screen
  if (state.view !== "history") viewBeforeHistory = state.view;
  renderHistory();
  window.scrollTo({ top: 0 });
}

function openHistorySet(id) {
  const h = history.find((x) => x.id === id);
  if (!h) return;
  generation?.abort();
  generation = null;
  prereqStream?.abort();
  notice("");
  const n = h.problems.length;
  const firstOpen = h.revealed.findIndex((r) => !r);
  Object.assign(state, {
    topic: h.topic,
    difficulty: h.difficulty || state.difficulty,
    problems: [],
    expected: n,
    streaming: false,
    index: firstOpen >= 0 ? firstOpen : 0,
    revealed: [...h.revealed],
    work: [],
    attempts: [...h.attempts],
    checks: [...h.checks],
    diagramOpen: [],
    madeDiagrams: [...h.made],
    stepsOpen: [],
    setId: h.id,
    image: null, // screenshots are never kept, so "More like these" needs a new one
    prereq: null,
  });
  setProblems(h.problems, true);
  renderProblem();
  window.scrollTo({ top: 0 });
}

async function clearHistory() {
  const b = $("clear-history");
  if (!b.dataset.armed) {
    // Two taps, so a stray click cannot wipe it.
    b.dataset.armed = "1";
    b.textContent = "Tap again to clear all history";
    setTimeout(() => {
      if (b.dataset.armed) {
        delete b.dataset.armed;
        b.textContent = "Clear history";
      }
    }, 4000);
    return;
  }
  pendingHistory.clear();
  history = [];
  await chrome.storage.local.set({ history });
  renderHistory();
}

// ---------------------------------------------------------------- settings

function renderVerbosity() {
  for (const b of $("verbosity").querySelectorAll("button")) {
    b.setAttribute("aria-checked", String(b.dataset.value === prefs.verbosity));
  }
  $("verbosity-hint").textContent = `${VERBOSITY_HINTS[prefs.verbosity]} Applies to the next set you generate.`;
}

function openSettings() {
  notice("");
  $("server-url").value = settings.serverUrl;
  $("founder-token").value = settings.founderToken;
  $("settings-status").textContent = "";
  $("dev-settings").hidden = !DEV;
  if (DEV) renderModels();
  if (state.view !== "settings") viewBeforeSettings = state.view;
  setRich($("size-sample"), String.raw`Solve \(2x^2 - 7x + 3 = 0\) by factoring, then check both roots.`);
  renderVerbosity();
  show("settings");
}

function closeSettings() {
  if (viewBeforeSettings === "history") return renderHistory();
  state.view = viewBeforeSettings;
  renderCurrent();
}

function closeHistory() {
  state.view = viewBeforeHistory;
  if (state.view === "problem" && !state.problems.length && !state.streaming) state.view = "start";
  renderCurrent();
}

async function saveSettings() {
  if (!DEV) {
    closeSettings();
    return;
  }
  const url = $("server-url").value.trim() || DEFAULT_SERVER;
  if (!/^https?:\/\/[^/\s]+/.test(url)) {
    $("settings-status").textContent = "SERVER MUST START WITH http:// OR https://";
    return;
  }
  const changed = url !== settings.serverUrl || $("founder-token").value.trim() !== settings.founderToken;
  if (!changed) {
    closeSettings();
    return;
  }
  settings = { serverUrl: url, founderToken: $("founder-token").value.trim() };
  await chrome.storage.local.set({ settings });
  $("settings-status").textContent = "CHECKING SERVER";
  const ok = await loadConfig();
  if (ok) {
    state.model = "";
    closeSettings();
  } else {
    $("settings-status").textContent = "SAVED. SERVER NOT REACHABLE";
  }
}

// ---------------------------------------------------------------- focus mode

async function toggleFocus() {
  if (FOCUS) {
    window.close();
    return;
  }
  save();
  await chrome.windows.create({
    url: chrome.runtime.getURL("panel.html?focus=1"),
    type: "popup",
    state: "fullscreen",
  });
}

// ---------------------------------------------------------------- boot

async function loadConfig() {
  try {
    config = await api("/v1/config");
    notice("");
    return true;
  } catch (err) {
    config = null;
    notice(describeError(err));
    return false;
  }
}

function bind() {
  $("generate").addEventListener("click", capture);
  $("model").addEventListener("change", (e) => {
    state.model = e.target.value;
    save();
  });
  $("difficulty").addEventListener("click", (e) => {
    const value = e.target.closest("button")?.dataset.value;
    if (!value) return;
    state.difficulty = value;
    renderStart();
  });
  $("count").addEventListener("input", (e) => {
    prefs.count = Number(e.target.value);
    applyCount({ animate: true });
    savePrefs();
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => fitInlineMath(document.body), 150);
  });
  $("verbosity").addEventListener("click", (e) => {
    const value = e.target.closest("button")?.dataset.value;
    if (!value) return;
    prefs.verbosity = value;
    renderVerbosity();
    savePrefs();
  });
  $("text-size").addEventListener("input", (e) => {
    prefs.textScale = Number(e.target.value);
    applyTextScale();
    fitInlineMath(document.body);
    savePrefs();
  });
  $("toggle-focus").addEventListener("click", toggleFocus);
  $("toggle-focus").title = FOCUS ? "Exit focus mode (Esc)" : "Focus mode";
  if (FOCUS || CROP) {
    document.addEventListener("keydown", (e) => {
      if (["INPUT", "SELECT"].includes(document.activeElement?.tagName)) return;
      if (e.key === "Escape") window.close();
      if (CROP && e.key === "Enter") send(Boolean(shot?.sel));
    });
  }

  setupCrop();
  $("send-crop").addEventListener("click", () => send(true));
  $("send-whole").addEventListener("click", () => send(false));
  $("cancel-crop").addEventListener("click", cancelCrop);
  $("cancel-waiting").addEventListener("click", () => {
    if (cropWindowId != null) chrome.windows.remove(cropWindowId).catch(() => {});
    cropWindowId = null;
    state.view = viewBeforeCrop;
    renderCurrent();
  });

  $("attempt").addEventListener("input", (e) => {
    state.attempts[state.index] = e.target.value;
    renderActions();
    renderCheckResult(state.index);
    if (!state.streaming) save();
  });
  $("attempt").addEventListener("keydown", (e) => {
    const p = state.problems[state.index];
    // Enter checks what was typed; it never reveals the answer by accident.
    if (e.key === "Enter" && p?._done.answer && !state.revealed[state.index] && e.target.value.trim()) checkAnswer();
  });
  $("diagram-toggle").addEventListener("click", onDiagramButton);
  $("toggle-steps").addEventListener("click", toggleAllSteps);
  $("open-prereq").addEventListener("click", openPrereq);
  $("open-report").addEventListener("click", () => {
    $("report").hidden = !$("report").hidden;
  });
  $("report-reasons").addEventListener("click", (e) => {
    const reason = e.target.closest("button")?.dataset.reason;
    if (reason) report(reason);
  });
  $("prev").addEventListener("click", () => go(state.index - 1));
  $("next").addEventListener("click", () => go(state.index + 1));
  $("new-set").addEventListener("click", capture);
  $("start-over").addEventListener("click", startOver);
  $("more-options").addEventListener("click", (e) => {
    const value = e.target.closest("button")?.dataset.value;
    if (value) moreLikeThese(value);
  });
  $("open-history").addEventListener("click", () => (state.view === "history" ? closeHistory() : openHistory()));
  $("history-back").addEventListener("click", closeHistory);
  $("recent-all").addEventListener("click", openHistory);
  $("clear-history").addEventListener("click", clearHistory);
  window.addEventListener("pagehide", flushHistory);
  $("prereq-back").addEventListener("click", () => renderProblem());

  $("open-settings").addEventListener("click", () => (state.view === "settings" ? closeSettings() : openSettings()));
  $("save-settings").addEventListener("click", saveSettings);
}

async function initCropWindow() {
  document.body.classList.add("crop-mode");
  const { pendingShot } = await chrome.storage.session.get("pendingShot");
  if (!pendingShot) {
    window.close();
    return;
  }
  shot = { dataUrl: pendingShot.dataUrl, sel: null, requester: pendingShot.requester };
  $("shot").src = shot.dataUrl;
  show("crop", { quiet: true });
}

async function init() {
  document.body.classList.toggle("focus", FOCUS);
  bind();
  await loadStorage();
  applyTextScale();
  applyCount();
  if (CROP) {
    await initCropWindow();
    return;
  }
  watchStorage();
  await loadConfig();
  renderCurrent();
}

init();
