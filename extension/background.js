// PracticeX opens in its own small window, floating over the page rather than filling the right edge of the
// screen. One window at a time: clicking the toolbar icon again brings the open one back to the front.
// The window survives tab switches, and Chrome remembers where the student dragged or resized it.

const SIZE = { width: 460, height: 700 };
const MARGIN = 24; // gap from the browser window's top right corner
let panelWindowId = null;

async function placeNear() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win?.width) {
      const height = Math.min(SIZE.height, Math.max(420, win.height - 2 * MARGIN));
      return {
        width: SIZE.width,
        height,
        left: Math.max(0, win.left + win.width - SIZE.width - MARGIN),
        top: Math.max(0, win.top + MARGIN),
      };
    }
  } catch {}
  return SIZE;
}

async function openPanel() {
  if (panelWindowId != null) {
    try {
      await chrome.windows.update(panelWindowId, { focused: true, drawAttention: true });
      return;
    } catch {
      panelWindowId = null; // it was closed while we were not looking
    }
  }
  const { last } = await chrome.storage.local.get("last"); // where the student left it
  const bounds = last?.panelBounds || (await placeNear());
  const win = await chrome.windows.create({ url: "panel.html", type: "popup", focused: true, ...bounds });
  panelWindowId = win.id;
}

chrome.action.onClicked.addListener(openPanel);

// Remember the size and position the student chose.
async function remember(windowId) {
  if (windowId !== panelWindowId) return;
  try {
    const win = await chrome.windows.get(windowId);
    if (win.state !== "normal" || !win.width) return;
    const { last } = await chrome.storage.local.get("last");
    await chrome.storage.local.set({
      last: { ...last, panelBounds: { width: win.width, height: win.height, left: win.left, top: win.top } },
    });
  } catch {}
}

chrome.windows.onBoundsChanged?.addListener((win) => remember(win.id));
chrome.windows.onRemoved.addListener((id) => {
  if (id === panelWindowId) panelWindowId = null;
});
