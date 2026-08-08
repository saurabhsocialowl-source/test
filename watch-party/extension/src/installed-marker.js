/*
 * Couch - "the extension is installed" marker.
 *
 * Runs only on the Couch website. The invite page needs to know whether the
 * visitor already has Couch before it forwards them to Netflix, otherwise a
 * friend without the extension just lands on the show and quietly watches
 * alone, with no idea they missed the party.
 *
 * Content scripts live in an isolated world, so the page cannot see our
 * variables - but the DOM is shared, so an attribute is the handshake. This
 * deliberately avoids externally_connectable / chrome.runtime messaging, which
 * would require hardcoding a published extension id we do not have yet.
 *
 * The only thing published here is "Couch is installed, at this version". No
 * page content is read and nothing is sent anywhere.
 */
(function () {
  'use strict';
  const mark = () => {
    try {
      const v = chrome.runtime.getManifest().version;
      document.documentElement.setAttribute('data-couch-installed', v);
      // The page may have booted and started polling before us, or may be
      // re-rendered by its own script afterwards; an event covers both.
      document.dispatchEvent(new CustomEvent('couch:installed', { detail: { version: v } }));
    } catch (e) { /* extension context torn down; nothing useful to do */ }
  };
  mark();
  // documentElement exists at document_start, but re-assert once the page has
  // settled in case anything replaced the node underneath us.
  document.addEventListener('DOMContentLoaded', mark);
})();
