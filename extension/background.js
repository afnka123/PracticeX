// PracticeX lives in Chrome's side panel, docked inside the browser window beside the page. It is not
// a window of its own and not a dropdown that closes the moment you click away: the panel belongs to
// the browser window rather than to one tab, so switching tabs and coming back leaves it open and
// exactly where it was. Clicking the toolbar icon opens it, and Chrome closes it on a second click.

const PANEL = { path: "panel.html", enabled: true };

// setOptions names the page and turns the panel on for every tab; setPanelBehavior is what makes the
// toolbar icon open it instead of doing nothing. Both are set on install and again on every service
// worker start, since the worker is torn down when idle and this has to be in place before the first
// click of the session.
async function setUp() {
  try {
    await chrome.sidePanel.setOptions(PANEL);
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn("PracticeX: could not set up the side panel", err);
  }
}

chrome.runtime.onInstalled.addListener(setUp);
setUp();
