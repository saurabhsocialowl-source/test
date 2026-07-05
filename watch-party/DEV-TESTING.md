# Testing Couch without reinstalling every time

You do **not** need to remove + re-add the extension for each change.

## Fast dev loop (recommended while iterating)

Load the extension **from a git checkout once**, then update in place:

```bash
git clone https://github.com/saurabhsocialowl-source/test.git couch
cd couch && git checkout claude/watch-party-browser-plugin-i6i4zb
```

1. `chrome://extensions` -> **Load unpacked** -> pick `couch/watch-party/extension`
   (do this only once).
2. To update after new changes:
   ```bash
   git pull
   ```
   then on `chrome://extensions` click the **reload (circular arrow) icon** on the
   Couch card, and **reload the streaming tab**. No unzip, no re-adding.

Tip: keep `chrome://extensions` open in a tab so the reload button is one click away.

## Zero-touch updates (for real users / friends)

Publish the extension to the Chrome Web Store (even **Unlisted**). Chrome then
**auto-updates** every install within a few hours of a new approved version - your
friends never reinstall. Use the fast dev loop above while iterating, and the store
for distribution.

## Reliability note

If connections drop after working once, that is the free PeerJS public cloud
rate-limiting you. Deploy `signal-server/` (see its README) and set `DEFAULT_BROKER`
in `extension/src/content.js` to your broker host. That is the durable fix.
