/**
 * WhiteCode Meet Automation - Background Service Worker
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log("[WhiteCode Sync] Background service worker initialized.");
});

// Update extension icon badge when tracking is active
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "UPDATE_BADGE") {
    const tabId = sender.tab ? sender.tab.id : undefined;
    if (tabId !== undefined) {
      if (message.isTracking) {
        chrome.action.setBadgeText({ tabId, text: "REC" });
        chrome.action.setBadgeBackgroundColor({ tabId, color: "#EF4444" });
      } else {
        chrome.action.setBadgeText({ tabId, text: "" });
      }
    }
    sendResponse({ ok: true });
    return true;
  }
});
