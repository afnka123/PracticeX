import { renderDiagram } from "./diagram.js";
import { parsePartialJson } from "./partial-json.js";

const MAX_IMAGE_SIDE = 1568; // larger images are downscaled by the model provider anyway
const PAGE_ID = crypto.randomUUID(); // tells this page's own storage writes apart from other windows'
// Unpacked (developer) builds have no update_url. Only they show the model, server and founder settings.
const DEV = !("update_url" in chrome.runtime.getManifest());
// The deployed server. Set this to the Render URL before packing; developer builds keep talking to
// localhost and can point somewhere else in Settings.
const PROD_SERVER = "https://practicex-server.onrender.com";
const DEFAULT_SERVER = DEV ? "http://localhost:8787" : PROD_SERVER;
const HISTORY_MAX = 40; // sets kept on this device
const NO_DIAGRAM_SUBJECTS = new Set(["writing", "language", "history"]);
// Folders. A set is filed under the class the student picked, or under the subject the model detected.
const SUBJECT_LABELS = {
  math: "Math",
  physics: "Physics",
  chemistry: "Chemistry",
  biology: "Biology",
  other_science: "Science",
  writing: "Writing",
  language: "Language",
  history: "History",
  other: "Other",
};
const MIN_FOR_INSIGHT = 4; // answers needed in a subject before calling it a strength or a weakness
const PROBLEM_FIELDS = ["question", "diagram_useful", "figure_kind", "diagram", "options", "correct_option", "answer", "accepted_answers", "approach", "steps", "check", "common_mistake"];

const $ = (id) => document.getElementById(id);

// Practice session. Kept in session storage so it survives closing the panel and is shared with focus mode.
let state = {
  view: "start",
  model: "",
  difficulty: 50, // 0 easy to 100 hard; older sessions may hold "easier"/"same"/"harder"
  subject: "", // math, physics, ..., writing, language, history, other
  courseId: "", // the class this set is filed under, "" for none
  topic: "",
  problems: [],
  expected: 0, // problems asked for; more than problems.length while a set is still streaming
  streaming: false,
  index: 0,
  revealed: [],
  work: [],
  attempts: [],
  chosen: [], // multiple choice: the option index the student picked
  wrongPicks: [], // multiple choice: options already tried and wrong
  checks: [], // per problem: { attempt, verdict, feedback } from Check answer
  diagramOpen: [],
  madeDiagrams: [], // diagrams drawn on request with "Make me a diagram"
  stepsOpen: [], // per problem: which steps are expanded
  setId: "",
  image: null, // last cropped screenshot, for "More like these"
  prereq: null, // { topic, data, streaming, live }
};
let prefs = { textScale: 1, count: 3, verbosity: "standard", courseId: "", slider: "count" };
const VERBOSITY_HINTS = {
  brief: "Just the key move and the math.",
  standard: "",
  detailed: "Every move, including the ones you do in your head.",
};
const drawing = new Set(); // "setId:index" of diagrams being drawn on request
let settings = { serverUrl: DEFAULT_SERVER, founderToken: "" };
let installId = "";
let config = null;
let shot = null; // { dataUrl, sel: {x, y, w, h} in 0..1 or null, requester }
let viewBeforeCrop = "start";
let viewBeforeHistory = "start";
let viewBeforeSettings = "start";
let history = []; // finished sets, most recently practiced first; kept in chrome.storage.local
let courses = []; // the student's classes: { id, name, subject, created }
let openFolder = null; // "type:key" of the folder showing its topics; null until the first render picks one
let openTopic = ""; // "folderKey|topicKey" of the topic showing its sets

// ---------------------------------------------------------------- storage

async function loadStorage() {
  const local = await chrome.storage.local.get(["installId", "settings", "prefs", "history", "courses"]);
  history = Array.isArray(local.history) ? local.history : [];
  courses = Array.isArray(local.courses) ? local.courses : [];
  installId = local.installId;
  if (!installId) {
    installId = crypto.randomUUID();
    await chrome.storage.local.set({ installId });
  }
  settings = { ...settings, ...(local.settings || {}) };
  if (!DEV) settings.serverUrl = DEFAULT_SERVER;
  prefs = { ...prefs, ...(local.prefs || {}) };
  // The written/choices pair used to be two buttons; it is a slider now, so old prefs land on an end.
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

const TRANSIENT_VIEWS = ["crop", "settings", "history"];

function save() {
  chrome.storage.session.set({ state: { writer: PAGE_ID, data: state } });
  recordHistory();
}

function savePrefs() {
  chrome.storage.local.set({ prefs });
}

function watchStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.courses) {
      courses = changes.courses.newValue || [];
      if (state.view === "start") renderClasses();
      else if (state.view === "history") renderHistory();
      return;
    }
    if (area === "local" && changes.history) {
      history = changes.history.newValue || [];
      if (state.view === "history") renderHistory();
      else if (state.view === "start") renderRecent();
      return;
    }
    if (area !== "session") return;

    // One side panel per browser window: keep a second window's panel on the same problem.
    if (!changes.state?.newValue) return;
    const { writer, data } = changes.state.newValue;
    if (writer === PAGE_ID || state.streaming || state.prereq?.streaming) return;
    if (TRANSIENT_VIEWS.includes(state.view)) return; // do not yank the student mid-task
    state = { ...state, ...data };
    renderCurrent({ quiet: true });
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
  // The X-StudyX-* pair is the name these headers had before the rename. Both go out until every
  // server is on a build that reads the new name; drop them once it is.
  const headers = { "X-PracticeX-Install": installId, "X-StudyX-Install": installId };
  if (body) headers["Content-Type"] = "application/json";
  if (settings.founderToken) {
    headers["X-PracticeX-Founder"] = settings.founderToken;
    headers["X-StudyX-Founder"] = settings.founderToken;
  }
  try {
    return await fetch(serverBase() + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ServerError(`The PracticeX server is not reachable at ${serverBase()}. Check Settings.`, 0);
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
  renderUsage();
}

function questionsLeft() {
  const usage = config?.usage;
  if (!usage) return null;
  return Math.max(0, usage.limit - usage.used);
}

// The hourly allowance, in one quiet line under the header. It says enough to explain itself
// and stays out of the way until it runs low.
function renderUsage() {
  const usage = config?.usage;
  const box = $("usage");
  const left = questionsLeft();
  if (left === null) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const out = left === 0;
  box.classList.toggle("out", out);
  box.classList.toggle("low", !out && left <= Math.max(3, Math.round(usage.limit * 0.05)));
  const resets = usage.resets_at ? formatTime(usage.resets_at) : "";
  if (out) {
    $("usage-main").textContent = resets ? `No questions left until ${resets}` : "No questions left this hour";
  } else {
    $("usage-main").textContent = `${left} question${left === 1 ? "" : "s"} left this hour`;
  }
  box.title = `${left} of ${usage.limit} questions this hour.${resets ? ` The count resets at ${resets}.` : ""}`;
  // Everything that would spend a question says so rather than failing on the server.
  const spenders = [$("generate"), $("new-set"), ...$("more-options").querySelectorAll("button")];
  for (const b of spenders) b.disabled = out;
  $("generate").textContent = out ? "Limit reached" : "Screenshot";
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

// Anything still holding a delimiter or a chemistry macro has not been rendered yet.
const RAW_MATH = /\\[([]|\\(?:ce|pu)\{/;
// What tells real math from a price like "$40 for $5 each": a command, a script, or a grouping.
const MATH_LIKE = /\\[a-zA-Z]|[\^_{}]/;

// The prompt asks for \( ... \) and \[ ... \], but a model drops into $ ... $ or writes a formula
// bare often enough to matter, and those delimiters are not configured: the source would sit on
// screen as typed. Normalising here costs nothing and covers the cases we keep seeing.
function normalizeMath(text) {
  if (!/[$]|\\(?:ce|pu)\{/.test(text)) return text;
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, body) => `\\[${body}\\]`);
  // Single dollars only when the body carries a command, so currency is left alone.
  text = text.replace(/\$([^$\n]+?)\$/g, (m, body) => (MATH_LIKE.test(body) ? `\\(${body}\\)` : m));
  return wrapBareChem(text);
}

// \ce{...} or \pu{...} written outside any delimiter, wrapped so MathJax sees it. Braces are matched
// by counting rather than by regex, since a chemical formula nests them.
function wrapBareChem(text) {
  if (!/\\(?:ce|pu)\{/.test(text)) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const starts = [text.indexOf("\\(", i), text.indexOf("\\[", i)].filter((n) => n >= 0);
    const next = starts.length ? Math.min(...starts) : -1;
    out += wrapChemOutsideMath(text.slice(i, next < 0 ? text.length : next));
    if (next < 0) break;
    // Step over the math region untouched; an unclosed one runs to the end.
    const close = text.indexOf(text[next + 1] === "(" ? "\\)" : "\\]", next + 2);
    const end = close < 0 ? text.length : close + 2;
    out += text.slice(next, end);
    i = end;
  }
  return out;
}

function wrapChemOutsideMath(chunk) {
  const re = /\\(?:ce|pu)\{/g;
  let out = "";
  let i = 0;
  let m;
  while ((m = re.exec(chunk))) {
    let depth = 0;
    let j = m.index + m[0].length - 1; // sits on the opening brace
    for (; j < chunk.length; j++) {
      if (chunk[j] === "{") depth++;
      else if (chunk[j] === "}" && --depth === 0) break;
    }
    if (j >= chunk.length) break; // half-written while streaming: leave it for the next pass
    out += chunk.slice(i, m.index) + `\\(${chunk.slice(m.index, j + 1)}\\)`;
    i = j + 1;
    re.lastIndex = i;
  }
  return out + chunk.slice(i);
}

// Model text is set with textContent (never innerHTML); MathJax then renders the \( \) and \[ \] parts.
// Unchanged text is skipped, so re-rendering while streaming only touches the part that grew.
// data-src is what should be on screen; data-typeset is what MathJax has actually rendered. They are
// separate so that a pass which never ran — the bundle was still loading, or MathJax threw — is
// retried instead of leaving the source on screen for the life of the panel.
function setRich(node, text, live = false) {
  text = normalizeMath(String(text || ""));
  if (live) text = hideOpenMath(text);
  node.classList.toggle("live", live);
  if (node.dataset.src === text) return;
  node.dataset.src = text;
  delete node.dataset.typeset;
  delete node.dataset.mathTries;
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

// mathjax-config.js sets window.MathJax synchronously, but `startup` only exists once the 2MB bundle
// has run, and it is deferred. Anything rendered before then used to skip typesetting in silence and
// keep its raw \( ... \) on screen for good, since the node is marked rendered either way.
let mathReady = null;
function whenMathReady() {
  if (window.MathJax?.startup?.promise) return window.MathJax.startup.promise;
  if (!mathReady) {
    const deadline = Date.now() + 20000;
    mathReady = new Promise((resolve) => {
      const look = () => {
        if (window.MathJax?.startup?.promise) return resolve(window.MathJax.startup.promise);
        // Give up on this wait rather than hold the queue, but clear the cache so the next pass
        // starts a fresh one: a bundle that lands late still gets its chance.
        if (Date.now() > deadline) {
          console.warn("MathJax still not loaded; will retry");
          mathReady = null;
          return resolve();
        }
        setTimeout(look, 50);
      };
      look();
    });
  }
  return mathReady;
}

// One pass per node at a time. A pass reads data-src when it runs, so updates that arrive while it
// is queued are picked up by that same pass instead of stacking another full typeset behind it.
let typesetQueue = Promise.resolve();
const queuedNodes = new Set();

function typeset(node) {
  scheduleMathHeal();
  if (queuedNodes.has(node)) return;
  queuedNodes.add(node);
  typesetQueue = typesetQueue
    .then(whenMathReady)
    .then(() => {
      queuedNodes.delete(node);
      const want = node.dataset.src || "";
      if (!node.isConnected || node.dataset.typeset === want) return;
      // Leave data-typeset unset when the bundle is not up yet, so the sweep comes back to it.
      if (!window.MathJax?.typesetPromise) return;
      return MathJax.typesetPromise([node]).then(() => {
        node.dataset.typeset = want;
        fitInlineMath(node);
      });
    })
    .catch((err) => {
      queuedNodes.delete(node);
      console.warn("MathJax:", err);
    });
}

// Whatever the reason a pass did not land, the student must never be left reading LaTeX source.
// This sweep finds nodes that still hold delimiters and tries them again, then stops once clean.
let healTimer = null;
function scheduleMathHeal() {
  if (healTimer) return;
  healTimer = setInterval(() => {
    const stuck = [...document.querySelectorAll("[data-src]:not([data-typeset])")].filter((n) => n.isConnected);
    if (!stuck.length) {
      clearInterval(healTimer);
      healTimer = null;
      return;
    }
    for (const node of stuck) {
      const src = node.dataset.src || "";
      const tries = Number(node.dataset.mathTries || 0);
      // Plain prose needs no pass, and a node that has failed repeatedly will not start working.
      if (!RAW_MATH.test(src) || tries >= 4) {
        node.dataset.typeset = src;
        continue;
      }
      node.dataset.mathTries = String(tries + 1);
      typeset(node);
    }
  }, 1200);
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
    .replace(/\\(?:ce|pu)\{([^{}]*)\}/g, "$1")
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
  if (!quiet && view !== "crop") save();
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

// Difficulty is a number from 0 (easy) to 100 (hard), the same scale the server reads. It slides
// continuously; these bands only decide what to call the spot the student stopped at.
const DIFFICULTY_BANDS = [
  [15, "Very easy", "Much simpler than the question you screenshot."],
  [37, "Easy", "A step simpler than the question you screenshot."],
  [63, "Same", "The same level as the question you screenshot."],
  [85, "Hard", "A step up from the question you screenshot."],
  [100, "Very hard", "Well above the question you screenshot."],
];
// The two ends are earned, not passed through: you only get them by pushing the handle all the way.
const DIFFICULTY_ENDS = {
  0: ["Layup", "A warm-up. The idea with nothing in the way."],
  100: ["Extreme", "Competition hard. Expect to be stuck for a while."],
};
const LEGACY_DIFFICULTY = { easier: 25, same: 50, harder: 75 }; // sessions saved before the slider

function difficultyLevel(value = state.difficulty) {
  if (typeof value === "string") return LEGACY_DIFFICULTY[value] ?? 50;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50;
}

function difficultyBand(level) {
  const end = DIFFICULTY_ENDS[level];
  if (end) return [level, ...end];
  return DIFFICULTY_BANDS.find(([top]) => level <= top) || DIFFICULTY_BANDS[DIFFICULTY_BANDS.length - 1];
}

// Soft teal at 0, green, amber, red, then purple at 100 - the same stops the track is painted with.
// The last hue is negative so the ramp runs red to magenta to purple instead of back through green.
const DIFFICULTY_STOPS = [
  [0, [172, 40, 64]],
  [0.14, [146, 44, 62]],
  [0.5, [45, 72, 58]],
  [0.86, [8, 66, 52]],
  [1, [-78, 52, 62]],
];

function difficultyColor(level) {
  const t = level / 100;
  let i = DIFFICULTY_STOPS.findIndex(([at]) => t <= at);
  if (i <= 0) i = 1;
  const [t0, a] = DIFFICULTY_STOPS[i - 1];
  const [t1, b] = DIFFICULTY_STOPS[i];
  const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const [h, sat, light] = a.map((v, k) => v + (b[k] - v) * f);
  return `hsl(${Math.round((h + 360) % 360)}, ${Math.round(sat)}%, ${Math.round(light)}%)`;
}

const saveDifficulty = throttle(() => save(), 250);

function applyDifficulty({ animate = false } = {}) {
  const level = difficultyLevel();
  const [, word, means] = difficultyBand(level);
  const field = $("slider-field");
  $("difficulty").value = level;
  field.style.setProperty("--dt", level / 100);
  field.style.setProperty("--dcolor", difficultyColor(level));
  $("diff-readout").textContent = word;
  $("difficulty").setAttribute("aria-valuetext", `${word}, ${level} of 100`);
  $("diff-body").title = means;
  // The three labels are the scale, so the nearest one marks where the handle is.
  const near = level <= 33 ? 0 : level >= 67 ? 2 : 1;
  [...$("diff-ticks").children].forEach((t, k) => t.classList.toggle("current", k === near));
  // An end is a small event: the readout above the slider becomes a badge in that end's colour.
  const unlocked = Boolean(DIFFICULTY_ENDS[level]);
  const readout = $("diff-readout");
  if (unlocked && !readout.classList.contains("unlocked")) {
    readout.classList.remove("pop");
    void readout.offsetWidth; // restart the animation
    readout.classList.add("pop");
  }
  readout.classList.toggle("unlocked", unlocked);
  if (animate) {
    const node = $("diff-wrap");
    node.classList.remove("pop");
    void node.offsetWidth; // restart the animation
    node.classList.add("pop");
  }
  renderCurrentSettings();
}


const SLIDERS = ["count", "difficulty"];
const SLIDER_BODY = { count: "count-body", difficulty: "diff-body" };
// Verbosity has no readout: the segmented control already shows which one is on.
const SLIDER_READOUT = { count: "count-readout", difficulty: "diff-readout" };

// The three bodies sit in one grid cell so the field never changes height, and the one on top
// fades in rather than snapping: nothing below it moves when you switch.
function renderSliderPick() {
  const which = SLIDERS.includes(prefs.slider) ? prefs.slider : "count";
  $("slider-pick").value = which;
  for (const name of SLIDERS) {
    const on = name === which;
    const body = $(SLIDER_BODY[name]);
    body.classList.toggle("on", on);
    body.inert = !on;
    if (SLIDER_READOUT[name]) $(SLIDER_READOUT[name]).classList.toggle("on", on);
  }
}

function applyCount({ animate = false } = {}) {
  const v = prefs.count;
  $("count").value = v;
  $("slider-field").style.setProperty("--v", v);
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
  renderCurrentSettings();
}

// One place that says what Generate will produce: the slider only shows one of these at a time,
// and the explanation style lives over in settings.
function renderCurrentSettings() {
  const level = difficultyLevel();
  const [, word] = difficultyBand(level);
  $("cs-difficulty").textContent = word;
  $("cs-difficulty").style.color = difficultyColor(level);
  $("cs-count").textContent = prefs.count;
  $("cs-verbosity").textContent = prefs.verbosity.charAt(0).toUpperCase() + prefs.verbosity.slice(1);
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
  applyDifficulty();
  applyCount();
  renderVerbosity();
  renderSliderPick();
  renderClasses();
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
    notice("PracticeX needs permission to see the page before it can read the problem.");
    return;
  }
  let dataUrl;
  try {
    // The side panel sits inside the browser window, so its own window is the one to photograph.
    const win = await chrome.windows.getCurrent();
    dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: "jpeg", quality: 92 });
  } catch {
    notice("Chrome does not allow screenshots of this page. Open the problem in a normal tab and try again.");
    return;
  }

  // The side panel crops in place. There is no second window to open and nothing to hand over.
  shot = { dataUrl, sel: null };
  $("shot").src = dataUrl;
  $("crop-box").hidden = true;
  if (state.view !== "crop") viewBeforeCrop = state.view;
  show("crop");
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
  generate(image);
}

function cancelCrop() {
  notice("");
  shot = null;
  state.view = viewBeforeCrop;
  renderCurrent();
}

// ---------------------------------------------------------------- generating (streamed)

let generation = null; // AbortController for the set being written

// A set that is still being written repaints the whole question view several times a second. While
// the student is answering, that repaint lands under their hands: the Check answer button is rebuilt
// between the press and the release, and the click goes nowhere. So the repaint is held from the
// first keystroke until they have been still for a moment, and through the check itself. The text
// carries on arriving in the background; only the painting waits.
const TYPING_QUIET = 1200;
let typingAt = 0;
let resumeTimer = null;
let resumePaint = null; // set while a set is streaming, so typing can release the held repaint

function studentIsBusy() {
  return Date.now() - typingAt < TYPING_QUIET || checking.size > 0;
}

function noteTyping() {
  typingAt = Date.now();
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    if (!studentIsBusy()) resumePaint?.();
  }, TYPING_QUIET + 60);
}

// Turns one partially written problem into a display object. A field is finished once the model has
// moved on to a later field; the whole problem is finished once the next problem has started.
function toProblem(raw, complete) {
  const keys = Object.keys(raw || {});
  const last = keys.at(-1);
  const done = { all: complete };
  for (const f of PROBLEM_FIELDS) done[f] = complete || (keys.includes(f) && f !== last);
  return {
    question: typeof raw.question === "string" ? raw.question : "",
    // Missing in sets saved before the model rated each question; those keep the old behavior.
    diagram_useful: raw.diagram_useful !== false,
    // Sets saved before tables existed were all drawings.
    figure_kind: raw.figure_kind === "table" ? "table" : "drawing",
    diagram: raw.diagram && typeof raw.diagram === "object" ? raw.diagram : null,
    options: Array.isArray(raw.options) ? raw.options.filter((o) => typeof o === "string") : [],
    correct_option: Number.isInteger(raw.correct_option) ? raw.correct_option : null,
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
  const fills = { revealed: false, work: false, attempts: "", chosen: null, wrongPicks: null, checks: null, diagramOpen: null, madeDiagrams: null, stepsOpen: null };
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
  if (before.view === "crop") before.view = viewBeforeCrop;
  notice("");
  shot = null;
  Object.assign(state, {
    subject: "",
    courseId: prefs.courseId,
    topic: "",
    problems: [],
    expected: prefs.count,
    streaming: true,
    index: 0,
    revealed: [],
    work: [],
    attempts: [],
    chosen: [],
    wrongPicks: [],
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
  const paint = () => {
    const partial = parsePartialJson(text);
    if (!partial || generation !== controller) return;
    if (typeof partial.subject === "string") state.subject = partial.subject;
    if (typeof partial.topic === "string") state.topic = partial.topic;
    const raw = Array.isArray(partial.problems) ? partial.problems.filter((p) => p && typeof p === "object") : [];
    setProblems(raw, false);
    // State is kept up to date either way; only the repaint waits for the student to be still.
    if (state.view === "problem" && !studentIsBusy()) renderProblem();
  };
  resumePaint = paint;
  const redraw = throttle(paint, 70);

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
        answer_format: "auto",
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
    resumePaint = null;
    if (!result.readable) {
      state = before;
      notice("No question found there. Select just the question and try again.");
      renderCurrent();
      return;
    }
    state.subject = result.subject;
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
    resumePaint = null;
    state = before;
    notice(describeError(err));
    renderCurrent();
  }
}

const MORE_NUDGE = { easier: -25, same: 0, harder: 25 };

function moreLikeThese(which) {
  notice("");
  if (which in MORE_NUDGE) {
    state.difficulty = Math.max(0, Math.min(100, difficultyLevel() + MORE_NUDGE[which]));
  }
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
  // Before a figure exists the model's own call decides the wording; after it, the figure itself does.
  const isTable = diagram ? diagram.kind === "table" : p?.figure_kind === "table";
  const noun = isTable ? "table" : "diagram";
  toggle.dataset.figure = isTable ? "table" : "drawing";
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
    label.textContent = isTable ? "Building table" : "Drawing diagram";
    wrap.hidden = true;
    return;
  }
  if (!diagram) {
    // No figure yet. The student can ask for one, but only where the model judged a figure could help:
    // not for simple arithmetic, and no drawings for writing, language or history — a table is fine there.
    if (!p._done.diagram || !p.diagram_useful || (NO_DIAGRAM_SUBJECTS.has(state.subject) && !isTable)) return hideAll();
    toggle.dataset.action = "make";
    label.textContent = `Make me a ${noun}`;
    wrap.hidden = true;
    return;
  }

  // Essential figures ("the graph shown") start open; the rest wait behind the button.
  if (state.diagramOpen[i] == null) state.diagramOpen[i] = Boolean(diagram.essential);
  const open = state.diagramOpen[i];
  toggle.dataset.action = "toggle";
  toggle.setAttribute("aria-expanded", String(open));
  label.textContent = open ? `Hide ${noun}` : `View ${noun}`;
  wrap.hidden = !open;
  const key = `${i}:${JSON.stringify(diagram)}`;
  if (open && wrap.dataset.src !== key) {
    wrap.dataset.src = key;
    const figure = renderDiagram(diagram, { typeset });
    wrap.replaceChildren(...(figure ? [figure, diagramNote(isTable)] : []));
    if (!figure) hideAll();
  }
}

// A figure can hand over an answer that was meant to be worked out, so it says so, quietly, beside itself.
function diagramNote(isTable) {
  const note = document.createElement("aside");
  note.className = "diagram-note";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "Note";
  const body = document.createElement("p");
  body.textContent = isTable
    ? "A table can give away the answer. Read it to check your working, not to skip it."
    : "A figure can give away the answer. Read it to check your working, not to skip it.";
  note.append(label, body);
  return note;
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
    const data = await api("/v1/diagram", {
      model: state.model,
      subject: state.subject,
      topic: state.topic,
      question: p.question,
      want: p.figure_kind === "table" ? "table" : "drawing",
    });
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

// What the panel says while a question is being written. It follows the field the model is on, so
// the wait reads as work happening rather than one line that sits there.
const WRITING_NOTES = {
  question: "Writing the question",
  options: "Laying out the choices",
  answer: "Working out the answer",
  accepted_answers: "Noting the ways to write it",
  approach: "Explaining the approach",
  steps: "Writing the working, step by step",
  check: "Checking the answer against the question",
  common_mistake: "Naming the mistake to avoid",
  diagram: "Drawing the figure",
};

function writingNote(i) {
  if (!state.problems.length) return "Reading what is on screen";
  const p = state.problems[i];
  if (!p) return `Question ${i + 1} is next in line`;
  return WRITING_NOTES[p._live] || (state.subject ? `Building a ${state.subject} set` : "Putting the set together");
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
  $("typing-note").textContent = writingNote(i);
  $("question").hidden = writing;
  if (p) setRich($("question"), p.question, p._live === "question");
  renderDiagramArea(i, p);
  renderOptions(i, p);

  // Setting an unchanged value would move the caret, so only write it when it differs.
  if ($("attempt").value !== attempt) $("attempt").value = attempt;
  $("attempt").readOnly = revealed;
  // Multiple choice answers by clicking, so the typing box is not shown at all.
  $("attempt-field").hidden = writing || Boolean(p?.options.length) || (revealed && !attempt);
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
// Rebuilding replaces the very button the student may be pressing, which swallows the click, so the
// row is left alone unless something it actually shows has changed.
function renderActions() {
  const i = state.index;
  const p = state.problems[i];
  const actions = $("problem-actions");
  const ready = Boolean(p?._done.answer);
  const key = JSON.stringify([
    state.setId,
    i,
    Boolean(p?.question),
    ready,
    Boolean(state.revealed[i]),
    (state.attempts[i] || "").trim().length > 0,
    p?.options.length || 0,
    Boolean(p?._done.correct_option),
    checking.has(`${state.setId}:${i}`),
    Boolean(state.work[i]),
  ]);
  if (actions.dataset.key === key) return;
  actions.dataset.key = key;
  actions.replaceChildren();
  if (!p || !p.question) return;

  if (!state.revealed[i]) {
    const typed = (state.attempts[i] || "").trim().length > 0;
    if (p.options.length) {
      actions.append(button(p._done.correct_option ? "View answer" : "Writing options", "primary", reveal, !p._done.correct_option));
    } else if (!ready) {
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

const LETTERS = "ABCDEF";

// Multiple choice: the options replace the typing box, and clicking one is the answer.
function renderOptions(i, p) {
  const box = $("options");
  const options = p?.options || [];
  box.hidden = !options.length;
  if (!options.length) {
    box.replaceChildren();
    return;
  }
  const ready = p._done.correct_option;
  const revealed = state.revealed[i];
  const chosen = state.chosen[i];
  const wrong = state.wrongPicks[i] || [];
  if (box.children.length > options.length) {
    if (window.MathJax?.typesetClear) MathJax.typesetClear([box]);
    box.replaceChildren();
  }
  options.forEach((text, k) => {
    let b = box.children[k];
    if (!b) {
      b = document.createElement("button");
      b.className = "option";
      const letter = document.createElement("span");
      letter.className = "letter";
      letter.textContent = LETTERS[k];
      const body = document.createElement("span");
      body.className = "option-text content";
      b.append(letter, body);
      b.addEventListener("click", () => choose(k));
      box.append(b);
    }
    setRich(b.lastChild, text, !ready && p._live === "options" && k === options.length - 1);
    const isCorrect = revealed && k === p.correct_option;
    b.classList.toggle("correct", Boolean(isCorrect || (chosen === k && k === p.correct_option)));
    b.classList.toggle("wrong", wrong.includes(k));
    b.disabled = !ready || revealed || wrong.includes(k);
    b.setAttribute("aria-pressed", String(chosen === k));
  });
}

function choose(k) {
  const i = state.index;
  const p = state.problems[i];
  if (!p?._done.correct_option || state.revealed[i]) return;
  notice("");
  state.chosen[i] = k;
  const right = k === p.correct_option;
  if (right) {
    state.revealed[i] = true;
    state.checks[i] = { attempt: LETTERS[k], verdict: "correct", feedback: "" };
  } else {
    state.wrongPicks[i] = [...(state.wrongPicks[i] || []), k];
    state.checks[i] = { attempt: LETTERS[k], verdict: "incorrect", feedback: "Try another option." };
  }
  renderProblem();
  flash(right ? "flash" : "miss", $("options").children[k]);
}

function renderCheckResult(i) {
  const result = state.checks[i];
  const box = $("attempt-box");
  const multipleChoice = Boolean(state.problems[i]?.options.length);
  // A result only stands while the student's answer is the one that was checked.
  const current = result && (multipleChoice ? state.chosen[i] != null : result.attempt === (state.attempts[i] || "").trim());
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

function flash(kind, box = $("attempt-box")) {
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
  // The check is done, so the rest of the set can catch up on screen.
  if (!studentIsBusy()) resumePaint?.();
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

// ---------------------------------------------------------------- classes
// The student names the classes they are taking. Every set they practice is filed under the class
// that was selected when it was generated, so progress can be read one course at a time.

function saveCourses() {
  return chrome.storage.local.set({ courses });
}

function courseById(id) {
  return courses.find((c) => c.id === id) || null;
}

// The subject a set counts toward: what the class is about, or what the model saw in the question.
function subjectOf(h) {
  const course = courseById(h.courseId);
  const subject = course?.subject || h.subject || "";
  return SUBJECT_LABELS[subject] ? subject : "other";
}

function subjectName(subject) {
  return SUBJECT_LABELS[subject] || SUBJECT_LABELS.other;
}

function renderClasses() {
  const wrap = $("classes");
  const chips = [];
  if (courses.length) {
    chips.push(classChip({ id: "", name: "No class" }));
    for (const c of courses) chips.push(classChip(c));
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "add";
  add.textContent = courses.length ? "+ Add" : "+ Add a class";
  add.addEventListener("click", () => openAddClass());
  chips.push(add);
  wrap.replaceChildren(...chips);

  $("edit-classes").hidden = courses.length === 0;
  $("edit-classes").textContent = wrap.dataset.editing ? "Done" : "Edit";
  $("class-hint").textContent = courses.length ? "" : "Sorts your practice by course.";
  $("class-hint").hidden = courses.length > 0;
}

function classChip(course) {
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("role", "radio");
  const on = (prefs.courseId || "") === course.id;
  b.classList.toggle("on", on);
  b.setAttribute("aria-checked", String(on));
  b.append(course.name);
  const editing = Boolean($("classes").dataset.editing) && course.id;
  if (editing) {
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "x";
    x.setAttribute("aria-hidden", "true");
    b.append(x);
    b.title = `Remove ${course.name}`;
  }
  b.addEventListener("click", () => {
    if (!editing) {
      prefs.courseId = course.id;
      savePrefs();
      renderClasses();
      return;
    }
    // Two taps to remove, so one stray click cannot delete a class.
    if (b.dataset.armed) return removeClass(course.id);
    b.dataset.armed = "1";
    b.classList.add("arm");
    b.replaceChildren("Remove?");
    setTimeout(() => {
      if (b.isConnected && b.dataset.armed) renderClasses();
    }, 4000);
  });
  return b;
}

function openAddClass(open = true) {
  const form = $("add-class");
  form.hidden = !open;
  if (!open) return;
  const select = $("class-subject");
  if (!select.options.length) {
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "Subject: from the questions";
    select.append(auto);
    for (const [value, label] of Object.entries(SUBJECT_LABELS)) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      select.append(opt);
    }
  }
  $("class-name").value = "";
  select.value = "";
  $("class-name").focus();
}

async function addClass(event) {
  event.preventDefault();
  const name = $("class-name").value.trim().slice(0, 40);
  if (!name) return $("class-name").focus();
  const course = { id: crypto.randomUUID(), name, subject: $("class-subject").value, created: Date.now() };
  courses = [...courses, course];
  prefs.courseId = course.id; // what you just added is what you are about to practice
  savePrefs();
  await saveCourses();
  openAddClass(false);
  renderClasses();
}

// Removing a class keeps its sets: they fall back to being filed by subject.
async function removeClass(id) {
  courses = courses.filter((c) => c.id !== id);
  if (prefs.courseId === id) {
    prefs.courseId = "";
    savePrefs();
  }
  delete $("classes").dataset.editing;
  await saveCourses();
  renderClasses();
}

function toggleEditClasses() {
  const wrap = $("classes");
  if (wrap.dataset.editing) delete wrap.dataset.editing;
  else wrap.dataset.editing = "1";
  renderClasses();
}

// ---------------------------------------------------------------- history and progress
// Finished sets are kept on this device (never the screenshot), so a student can see what they have practiced,
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
    subject: state.subject || "",
    courseId: state.courseId || "",
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
  if (state.streaming || !state.setId || !state.problems.length) return;
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
    const practiced = !old || progress(old) !== progress(entry);
    const days = [...new Set([...(old?.days || []), ...(practiced ? [dayKey(entry.updated)] : [])])];
    const updated = practiced ? entry.updated : old.updated;
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

// Under a topic the name is already on screen, so the row leads with when it was practiced instead.
function setRow(h, nested = false) {
  const { correct, answered, total } = setScore(h);
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.className = "set-row";
  const main = document.createElement("span");
  main.className = "set-main";
  const topic = document.createElement("span");
  topic.className = "set-topic";
  topic.textContent = nested ? formatWhen(h.updated) : h.topic;
  const meta = document.createElement("span");
  meta.className = "set-meta mono";
  const band = difficultyBand(difficultyLevel(h.difficulty));
  const level = band[1] === "Medium" ? "" : band[1];
  meta.textContent = nested
    ? level
    : [formatWhen(h.updated), folderOf(h).name, level].filter(Boolean).join(" · ");
  meta.hidden = !meta.textContent;
  main.append(topic, meta);
  const score = document.createElement("span");
  score.className = "set-score mono";
  score.textContent = answered ? `${correct}/${total}` : "New";
  score.title = answered ? `${correct} right of ${total}, ${answered} answered` : "Not tried yet";
  score.classList.toggle("done", total > 0 && correct === total);
  b.append(main, score);
  b.setAttribute("aria-label", `${h.topic}, ${formatWhen(h.updated)}, ${score.title}. Open this set.`);
  b.addEventListener("click", () => openHistorySet(h.id));
  li.append(b);
  return li;
}

function renderRecent() {
  const empty = history.length === 0;
  $("recent").hidden = empty;
  // Nothing to look back on yet, so the room under the button explains the thing instead of
  // sitting blank.
  $("first-run").hidden = !empty;
  $("recent-sets").replaceChildren(...history.slice(0, 3).map((h) => setRow(h)));
}

// Every set belongs to exactly one folder: the class it was generated under, or its subject.
function folderOf(h) {
  const course = courseById(h.courseId);
  if (course) return { type: "course", key: course.id, name: course.name, subject: subjectOf(h) };
  // Sets from before folders existed, and anything the model could not place, sit together.
  if (!h.subject) return { type: "subject", key: "unsorted", name: "Unsorted", subject: "other" };
  const subject = subjectOf(h);
  return { type: "subject", key: subject, name: subjectName(subject), subject };
}

// Strength and weakness are read per subject, across every folder, so two classes in the
// same subject count together.
function subjectStats() {
  const map = new Map();
  for (const h of history) {
    const subject = subjectOf(h);
    const s = setScore(h);
    const t = map.get(subject) || { subject, name: subjectName(subject), correct: 0, answered: 0 };
    t.correct += s.correct;
    t.answered += s.answered;
    map.set(subject, t);
  }
  return [...map.values()];
}

function renderInsight() {
  const ranked = subjectStats()
    .filter((t) => t.answered >= MIN_FOR_INSIGHT)
    .sort((a, b) => b.correct / b.answered - a.correct / a.answered);
  const box = $("insight");
  box.hidden = history.length === 0;
  if (box.hidden) return;
  const pct = (t) => `${Math.round((100 * t.correct) / t.answered)}% of ${t.answered}`;
  const enough = ranked.length >= 2;
  $("insight-best").hidden = ranked.length === 0;
  $("insight-worst").hidden = !enough;
  $("insight-hint").hidden = enough;
  if (ranked.length) {
    $("insight-best-name").textContent = ranked[0].name;
    $("insight-best-score").textContent = pct(ranked[0]);
  }
  if (enough) {
    const worst = ranked[ranked.length - 1];
    $("insight-worst-name").textContent = worst.name;
    $("insight-worst-score").textContent = pct(worst);
  }
  $("insight-hint").textContent = `Needs ${MIN_FOR_INSIGHT} answers in two subjects.`;
}

function scoreMeta(row) {
  return `${row.sets} set${row.sets > 1 ? "s" : ""} · ${row.answered ? `${row.correct}/${row.answered}` : "new"}`;
}

function bar(row) {
  const el = document.createElement("span");
  el.className = "topic-bar";
  el.style.setProperty("--p", row.answered ? row.correct / row.answered : 0);
  el.setAttribute("aria-hidden", "true");
  return el;
}

// Practice reads folder first, then the topics inside it. Folders open one at a time.
function topicRow(folderKey, t) {
  const li = document.createElement("li");
  const key = `${folderKey}|${t.key}`;
  const open = openTopic === key && t.sets > 1;
  const head = document.createElement("button");
  head.type = "button";
  head.className = "subtopic";
  head.classList.toggle("open", open);
  const name = document.createElement("span");
  name.className = "topic-name";
  name.textContent = t.name;
  const meta = document.createElement("span");
  meta.className = "set-meta mono";
  meta.textContent = scoreMeta(t);
  head.append(name, meta, bar(t));
  // One set opens straight away; several list their dates first.
  const single = t.sets === 1;
  head.setAttribute("aria-label", `${t.name}, ${scoreMeta(t)}. ${single ? "Open it." : "Show its sets."}`);
  if (!single) head.setAttribute("aria-expanded", String(open));
  head.addEventListener("click", () => {
    if (single) return openHistorySet(t.sets_[0].id);
    openTopic = open ? "" : key;
    renderFolders();
  });
  li.append(head);
  if (open) {
    const ul = document.createElement("ul");
    ul.className = "subsets";
    ul.append(...t.sets_.map((h) => setRow(h, true)));
    li.append(ul);
  }
  return li;
}

function folderRow(f) {
  const li = document.createElement("li");
  const folderKey = `${f.type}:${f.key}`;
  const open = openFolder === folderKey;
  const head = document.createElement("button");
  head.type = "button";
  head.className = "folder-row";
  head.classList.toggle("open", open);
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "topic-name";
  name.textContent = f.name;
  const meta = document.createElement("span");
  meta.className = "set-meta mono";
  meta.textContent = scoreMeta(f);
  head.append(caret, name, meta, bar(f));
  head.setAttribute("aria-expanded", String(open));
  head.setAttribute("aria-label", `${f.name}, ${scoreMeta(f)}. Show topics.`);
  head.addEventListener("click", () => {
    openFolder = open ? "" : folderKey;
    openTopic = "";
    renderFolders();
  });
  li.append(head);
  if (open && f.topics.size) {
    const ul = document.createElement("ul");
    ul.className = "subtopics";
    ul.append(...[...f.topics.values()].sort((a, b) => b.sets - a.sets).map((t) => topicRow(folderKey, t)));
    li.append(ul);
  }
  return li;
}

function renderFolders() {
  const folders = new Map();
  for (const h of history) {
    const f = folderOf(h);
    const s = setScore(h);
    const key = `${f.type}:${f.key}`;
    const row = folders.get(key) || { ...f, sets: 0, correct: 0, answered: 0, topics: new Map() };
    row.sets++;
    row.correct += s.correct;
    row.answered += s.answered;
    const tk = h.topic.toLowerCase();
    const t = row.topics.get(tk) || { key: tk, name: h.topic, sets: 0, correct: 0, answered: 0, sets_: [] };
    t.sets++;
    t.correct += s.correct;
    t.answered += s.answered;
    t.sets_.push(h); // history is newest first, so these stay in order
    row.topics.set(tk, t);
    folders.set(key, row);
  }
  // Classes the student made come first, even before they have practiced in them.
  for (const c of courses) {
    const key = `course:${c.id}`;
    if (!folders.has(key)) {
      folders.set(key, { type: "course", key: c.id, name: c.name, subject: c.subject || "other", sets: 0, correct: 0, answered: 0, topics: new Map() });
    }
  }
  const rows = [...folders.values()].sort((a, b) => {
    if ((a.type === "course") !== (b.type === "course")) return a.type === "course" ? -1 : 1;
    return b.sets - a.sets || a.name.localeCompare(b.name);
  });
  if (openFolder === null) openFolder = rows.length ? `${rows[0].type}:${rows[0].key}` : "";
  $("folders-wrap").hidden = rows.length === 0;
  $("folders").replaceChildren(...rows.map(folderRow));
}

function renderHistory() {
  renderInsight();
  renderFolders();
  let correct = 0;
  let answered = 0;
  for (const h of history) {
    const s = setScore(h);
    correct += s.correct;
    answered += s.answered;
  }
  $("stat-solved").textContent = correct;
  $("stat-accuracy").textContent = answered ? `${Math.round((100 * correct) / answered)}%` : "–";
  $("stat-streak").textContent = streak();

  $("history-empty").hidden = history.length > 0;
  $("clear-history").hidden = history.length === 0;
  $("clear-history").textContent = "Clear history";
  delete $("clear-history").dataset.armed;
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
    subject: h.subject || "",
    courseId: h.courseId || "",
    difficulty: h.difficulty ?? state.difficulty,
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
  openFolder = null;
  await chrome.storage.local.set({ history });
  renderHistory();
}

// ---------------------------------------------------------------- settings

function renderVerbosity() {
  for (const b of $("verbosity").querySelectorAll("button")) {
    b.setAttribute("aria-checked", String(b.dataset.value === prefs.verbosity));
  }
  $("verbosity-hint").textContent = VERBOSITY_HINTS[prefs.verbosity];
  renderCurrentSettings();
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

// The roomier layout turns on by width, however wide the student has dragged the side panel.
const WIDE_LAYOUT = 720;

function applyWindowSize() {
  document.body.classList.toggle("focus", window.innerWidth >= WIDE_LAYOUT);
}

// ---------------------------------------------------------------- boot

async function loadConfig() {
  try {
    config = await api("/v1/config");
    renderUsage();
    notice("");
    return true;
  } catch (err) {
    config = null;
    renderUsage();
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
  $("difficulty").addEventListener("input", (e) => {
    state.difficulty = Number(e.target.value);
    applyDifficulty();
    saveDifficulty();
  });
  // A settle at the end of the drag, not a bulge on every pixel of it.
  $("difficulty").addEventListener("change", () => applyDifficulty({ animate: true }));
  $("slider-pick").addEventListener("change", (e) => {
    prefs.slider = e.target.value;
    savePrefs();
    renderSliderPick();
  });
  $("count").addEventListener("input", (e) => {
    prefs.count = Number(e.target.value);
    applyCount({ animate: true });
    savePrefs();
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    applyWindowSize();
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
  document.addEventListener("keydown", (e) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if (state.view !== "crop") return;
    if (e.key === "Escape") cancelCrop();
    if (e.key === "Enter") send(Boolean(shot?.sel));
  });

  setupCrop();
  $("send-crop").addEventListener("click", () => send(true));
  $("send-whole").addEventListener("click", () => send(false));
  $("cancel-crop").addEventListener("click", cancelCrop);
  $("attempt").addEventListener("input", (e) => {
    state.attempts[state.index] = e.target.value;
    noteTyping();
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
  $("classes").addEventListener("keydown", (e) => {
    if (e.key === "Escape") openAddClass(false);
  });
  $("edit-classes").addEventListener("click", toggleEditClasses);
  $("add-class").addEventListener("submit", addClass);
  $("cancel-class").addEventListener("click", () => openAddClass(false));
  $("open-history").addEventListener("click", () => (state.view === "history" ? closeHistory() : openHistory()));
  $("history-back").addEventListener("click", closeHistory);
  $("recent-all").addEventListener("click", openHistory);
  $("clear-history").addEventListener("click", clearHistory);
  window.addEventListener("pagehide", flushHistory);
  $("prereq-back").addEventListener("click", () => renderProblem());

  $("open-settings").addEventListener("click", () => (state.view === "settings" ? closeSettings() : openSettings()));
  $("save-settings").addEventListener("click", saveSettings);
}

async function init() {
  bind();
  applyWindowSize();
  // Settings carries the version, so a student can answer "which build are you on?" without
  // turning on Developer mode at chrome://extensions.
  $("version-line").textContent = `PracticeX ${chrome.runtime.getManifest().version || "dev build"}`;
  await loadStorage();
  applyTextScale();
  applyDifficulty();
  applyCount();
  renderVerbosity();
  watchStorage();
  await loadConfig();
  renderCurrent();
  // The opening card fades itself out; drop it from the page once it has, so nothing is left
  // sitting over the panel.
  setTimeout(() => $("splash")?.remove(), 1600);
}

init();
