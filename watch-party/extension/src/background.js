/*
 * Couch - background service worker.
 *
 * Long-lived party state lives in the content script (the Netflix tab stays
 * open). Signaling uses the PeerJS public cloud by default, so there is no
 * server URL to seed. This worker only absorbs status pings so the content
 * script's broadcasts always have a receiver.
 */

// Content script broadcasts { type:'status' }; just acknowledge it.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'status') {
    chrome.storage.local.set({ couchStatus: msg.status });
  }
  sendResponse({});
  return false;
});
