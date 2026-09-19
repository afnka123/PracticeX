// Mocks the chrome.* APIs the panel uses so it can run as a normal page.
// Storage lives in localStorage so several preview tabs (panel, focus window, crop window) share it the way
// extension pages do. ?focus=1 previews focus mode; the crop window opens as ?crop=1 in a new tab.
(() => {
  const listeners = [];
  const isChild = /[?&](crop|focus)=/.test(location.search);
  const prefix = (area) => `mock-chrome:${area}:`;

  // A fresh panel starts a fresh browser session.
  if (!isChild) {
    for (const k of Object.keys(localStorage)) if (k.startsWith(prefix("session"))) localStorage.removeItem(k);
  }
  if (localStorage.getItem(prefix("local") + "settings") === null) {
    localStorage.setItem(prefix("local") + "settings", JSON.stringify({ serverUrl: "http://localhost:8788" }));
  }

  const area = (name) => ({
    async get(keys) {
      const out = {};
      for (const k of [].concat(keys)) {
        const v = localStorage.getItem(prefix(name) + k);
        if (v !== null) out[k] = JSON.parse(v);
      }
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        const old = localStorage.getItem(prefix(name) + k);
        localStorage.setItem(prefix(name) + k, JSON.stringify(v));
        changes[k] = { oldValue: old === null ? undefined : JSON.parse(old), newValue: structuredClone(v) };
      }
      listeners.forEach((fn) => fn(changes, name));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) localStorage.removeItem(prefix(name) + k);
    },
  });

  // Writes from other preview tabs arrive as storage events.
  window.addEventListener("storage", (e) => {
    const m = e.key?.match(/^mock-chrome:(\w+):(.+)$/);
    if (!m || e.newValue === null) return;
    const changes = { [m[2]]: { oldValue: e.oldValue && JSON.parse(e.oldValue), newValue: JSON.parse(e.newValue) } };
    listeners.forEach((fn) => fn(changes, m[1]));
  });

  function fakeScreenshot() {
    const c = document.createElement("canvas");
    c.width = 1600;
    c.height = 1000;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 1600, 1000);
    g.fillStyle = "#1c5aa6"; g.fillRect(0, 0, 1600, 72);
    g.fillStyle = "#fff"; g.font = "bold 28px sans-serif"; g.fillText("Precalculus · Vectors 8.2", 40, 48);
    g.fillStyle = "#444"; g.font = "22px sans-serif"; g.fillText("Assignment due Friday · 12 questions", 120, 150);
    g.fillStyle = "#222"; g.font = "28px serif"; g.fillText("Question 4 of 12", 120, 260);
    g.font = "40px serif"; g.fillText("Given u = ⟨2, 1⟩ and v = ⟨1, 3⟩, find u + v.", 120, 340);
    g.font = "22px sans-serif"; g.fillStyle = "#666"; g.fillText("Student: Jordan R.   jordan@school.edu", 120, 900);
    return c.toDataURL("image/jpeg", 0.85);
  }

  let nextWindow = 100;
  window.chrome = {
    storage: {
      local: area("local"),
      session: area("session"),
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    permissions: { request: async () => true },
    windows: {
      getLastFocused: async () => ({ id: 1 }),
      create: async ({ url }) => {
        window.open(url.replace("chrome-extension://mock/", "/dev/preview.html"), "_blank");
        return { id: nextWindow++ };
      },
      remove: async () => {},
      onRemoved: { addListener: () => {} },
    },
    tabs: { captureVisibleTab: async () => fakeScreenshot() },
    runtime: {
      getManifest: () => ({}), // no update_url: behaves like an unpacked build
      getURL: (p) => "chrome-extension://mock/" + p.replace(/^panel\.html/, ""),
    },
  };
})();
