// StudyX opens as a side panel for the tab it was opened on only: switching tabs hides it, and coming back to
// that tab shows it again. Chrome keeps each tab's panel until the tab closes.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.sidePanel.setOptions({ enabled: false }).catch(() => {}); // no panel on tabs where it was not opened

chrome.action.onClicked.addListener((tab) => {
  // Not awaited: sidePanel.open() must run inside the click's user gesture.
  chrome.sidePanel.setOptions({ tabId: tab.id, path: "panel.html", enabled: true });
  chrome.sidePanel.open({ tabId: tab.id });
});
