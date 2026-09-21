// PracticeX lives in Chrome's side panel, beside the page instead of in a window of its own. The panel
// belongs to the browser window rather than to one tab, so switching tabs and coming back leaves it
// open and exactly where it was. Clicking the toolbar icon opens it; Chrome closes it on a second
// click, so there is nothing here to track or remember.

function openOnClick() {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
}

// Set on install and again on every service-worker start: the worker is torn down when idle, and the
// behavior has to be in place before the first click of the session.
chrome.runtime.onInstalled.addListener(openOnClick);
openOnClick();
