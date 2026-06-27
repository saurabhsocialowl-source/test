# Couch - Netflix Watch Party (Browser Extension)

Host **synchronized Netflix watch parties** with a built-in **group video & audio call**.
Everyone shares the playback controls - when anyone plays, pauses, or seeks, everyone's
player follows along, and you see and hear each other in a floating call overlay on top
of Netflix.

> **Same title, own account:** Netflix video is DRM-protected and cannot be streamed from
> one person to the group. Like Teleparty / Netflix Party, **every participant needs their
> own Netflix account and must open the same title.** Couch synchronizes everyone's
> *playback position* and adds the call layer - it never touches the video itself.

---

## No server to run - it's fully peer-to-peer

There is **nothing to host and no URL to manage.**

- **Calls and playback-sync travel directly browser-to-browser** over WebRTC (a full
  mesh) - the lowest-latency path there is, the same tech Discord and Meet use.
- A tiny bit of "matchmaking" (introducing peers to each other) runs over the **free
  PeerJS public cloud broker**, which is built into the extension. The broker is only
  touched during the few-message handshake when someone joins; after that it is
  completely out of the path, so it never affects sync speed.
- The **invite code is the rendezvous address** - the party creator registers the peer
  id `couch-<CODE>`, and joiners reach it with just the code.

> Why not Netlify / serverless functions? A signaling broker needs an always-on
> WebSocket connection, which Netlify Functions (short-lived, stateless) can't provide.
> The PeerJS cloud sidesteps the question entirely - but if you ever want your *own*
> private broker, host it on a platform that supports persistent WebSockets (Render,
> Railway, Fly.io) and put its address in the popup's **Advanced** field.

### Architecture at a glance

```
   Netflix tab (you)                         Netflix tab (friend)
 ┌────────────────────┐                    ┌────────────────────┐
 │ injected.js ⇄ Netflix player            │ injected.js ⇄ player │
 │     ⇅ postMessage  │                    │     ⇅                │
 │ content.js  ◄────── WebRTC mesh ───────►│ content.js           │
 │  (overlay · sync · │   data + media      │                     │
 │   PeerJS mesh)     │   (direct P2P)      │                     │
 └─────────┬──────────┘                    └──────────┬──────────┘
           └────────► PeerJS cloud broker ◄───────────┘
                      (peer introductions only)
```

- **`injected.js`** runs in Netflix's page context to read the current time and apply
  play/pause/seek via `netflix.appContext…videoPlayer`.
- **`content.js`** owns the PeerJS peer, forms the mesh, fans playback state out over
  per-peer data channels, runs the audio/video calls, and renders the overlay.
- **`vendor/peerjs.min.js`** is the bundled PeerJS client (no remote scripts loaded).

---

## Files

```
watch-party/
└── extension/                 # Manifest V3 Chrome/Edge extension (load unpacked)
    ├── manifest.json
    ├── icons/                 # Couch sofa mark @ 16/48/128
    └── src/
        ├── background.js      # service worker (absorbs status pings)
        ├── content.js         # PeerJS mesh, sync, call, overlay UI
        ├── injected.js        # page-context Netflix player driver
        ├── overlay/           # in-page call overlay styles
        ├── popup/             # toolbar UI: create / join / mic / cam / leave
        └── vendor/peerjs.min.js
```

---

## Install & use

### Option A - From the Chrome Web Store (no Developer mode)

To let anyone install with one click (no `chrome://extensions`, no Developer
mode), publish it to the store. Everything is prepared - the upload package, promo
images, privacy policy, and listing copy. See **[PUBLISHING.md](PUBLISHING.md)**
for the full step-by-step. Build/refresh the upload zip anytime with:

```bash
./build.sh        # -> store-assets/couch-<version>.zip  (manifest at the root)
```

### Option B - Load it yourself for testing (Developer mode)

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `watch-party/extension` folder.
4. Pin the **Couch** (teal sofa) icon to your toolbar.

### 2. Throw a party

1. Open a title on Netflix and **press play** (URL looks like `netflix.com/watch/123…`).
2. Click the **Couch** icon → enter your name → **Create a party**.
3. Allow the mic/camera prompt (or skip for listen-only).
4. **Copy the invite code** and send it to your friends.
5. Each friend opens the **same title**, clicks the icon, pastes the code, **Join party**.

That's it - no installs on a server, no accounts. Anyone's play / pause / seek syncs to
everyone, and the call overlay shows each participant. Use the overlay (or popup) to
mute, toggle camera, hit **⟳ resync** to pull everyone to your exact position, or leave.

---

## Controls

| Control            | Where            | Action                                              |
| ------------------ | ---------------- | --------------------------------------------------- |
| 🎤 Mic / 📷 Cam     | overlay & popup  | Toggle your microphone / camera                     |
| ⟳ Resync           | overlay          | Force everyone to your current playback position    |
| ⧉ Copy             | overlay & popup  | Copy the invite code                                |
| ⏻ Leave            | overlay & popup  | Leave the party and close your connections          |
| – Collapse / drag  | overlay header   | Minimize or reposition the overlay                  |

---

## Limitations & notes

- **Same title required per person** - DRM means we sync state, not pixels.
- **Mesh calls** are comfortable for ~4–6 people (each person uploads video to every
  other). For bigger parties you'd add an SFU media server - a future enhancement.
- **NAT traversal** uses public Google STUN. Some strict networks need a **TURN** server
  for the *call* to connect (sync still works); add its
  `{ urls, username, credential }` to `ICE_SERVERS` in `content.js`.
- **Free PeerJS cloud** is rate-limited and best-effort. For heavy/regular use, run your
  own PeerJS broker on Render/Railway/Fly and set it under **Advanced → Signaling broker**.
- **Ads / intros / "Are you still watching?"** can momentarily desync a viewer; the
  ⟳ resync button snaps everyone back together.
- Not affiliated with Netflix. Respect Netflix's Terms of Use.

## Roadmap ideas

- Text chat & emoji reactions in the overlay
- Host-only vs. shared-control mode toggle
- Active-speaker highlight + avatars
- Optional self-hosted PeerJS broker with a one-click deploy
- SFU backend for larger parties
- Firefox build (MV3 manifest variant)
