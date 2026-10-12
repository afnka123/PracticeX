// Loaded first in panel.html, before anything is drawn. The background color a student picked in
// Settings lives in chrome.storage, which only answers asynchronously, so the panel would open in the
// default slate and then jump. A copy is kept in localStorage for this one synchronous read.
// Extension pages cannot run inline scripts, so this sits in its own file.
(() => {
  try {
    const color = localStorage.getItem("px-bg");
    if (color && /^#[0-9a-f]{6}$/i.test(color) && color.toLowerCase() !== "#1e2a38") {
      document.documentElement.style.setProperty("--practicex-slate", color);
      document.documentElement.classList.add("themed");
    }
  } catch {}
})();
