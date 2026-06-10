/*
 * Livance — background service worker.
 *
 * Long-lived party state lives in the content script (the Netflix tab stays
 * open). This worker only seeds defaults and absorbs status pings so the
 * content script's broadcasts always have a receiver.
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['livanceServerUrl'], (cfg) => {
    if (!cfg.livanceServerUrl) {
      chrome.storage.local.set({ livanceServerUrl: 'ws://localhost:8080' });
    }
  });
});

// Content script broadcasts { type:'status' }; just acknowledge it.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'status') {
    chrome.storage.local.set({ livanceStatus: msg.status });
  }
  sendResponse({});
  return false;
});
