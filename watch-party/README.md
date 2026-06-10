# Livance — Netflix Watch Party (Browser Extension)

Host **synchronized Netflix watch parties** with a built-in **group video & audio call**.
Everyone in the party shares the playback controls — when anyone plays, pauses, or
seeks, everyone's player follows along, and you see and hear each other in a floating
call overlay on top of Netflix.

> **How it works (and the one rule):** Netflix video is DRM-protected and cannot be
> streamed from one person to the group. Like Teleparty / Netflix Party, **every
> participant needs their own Netflix account and must open the same title.** Livance
> synchronizes everyone's *playback position* and adds the call layer — it never
> touches or rebroadcasts the video itself.

---

## What's in here

```
watch-party/
├── extension/            # Manifest V3 Chrome/Edge extension (load unpacked)
│   ├── manifest.json
│   ├── icons/            # Livance mark, generated at 16/48/128
│   └── src/
│       ├── background.js     # service worker (defaults + status relay)
│       ├── content.js        # the brain: WS connection, sync, WebRTC mesh, overlay UI
│       ├── injected.js       # page-context script that drives the Netflix player API
│       ├── overlay/          # in-page call overlay styles
│       └── popup/            # toolbar popup: create / join / mic / cam / leave
└── server/               # Node.js WebSocket signaling + playback-sync relay
    ├── server.js
    └── package.json
```

### Architecture at a glance

```
   Netflix tab (you)                         Netflix tab (friend)
 ┌────────────────────┐                    ┌────────────────────┐
 │ injected.js  ⇄ Netflix player           │ injected.js  ⇄ player│
 │     ⇅ postMessage  │                    │     ⇅                │
 │ content.js (overlay, sync, WebRTC) ◄────┼─ WebRTC mesh (A/V) ─►│ content.js
 │     ⇅ WebSocket    │                    │     ⇅                │
 └─────────┬──────────┘                    └─────────┬──────────┘
           └──────────────► server.js ◄──────────────┘
                  (rooms · presence · signaling · sync fan-out)
```

- **`injected.js`** runs in Netflix's page context so it can reach
  `netflix.appContext…videoPlayer` to read the current time and apply
  play/pause/seek. It echoes local user actions back to `content.js`.
- **`content.js`** owns the WebSocket connection, fans playback state out to
  peers, and runs a **WebRTC mesh** (each participant connects directly to every
  other) for the audio/video call. It renders the draggable overlay.
- **`server.js`** is a thin relay. It only routes JSON: room membership,
  WebRTC offer/answer/ICE, and playback-sync messages. It never sees video.

---

## Quick start

### 1. Run the sync server

```bash
cd watch-party/server
npm install
npm start            # listens on ws://localhost:8080  (override with PORT=...)
```

Health check: `curl http://localhost:8080/health` → `{"ok":true,...}`

For friends on other machines, host this somewhere reachable and use a `wss://`
URL (any Node host works; put it behind TLS). Then set that URL in the popup's
**Advanced → Sync server** field. For groups behind strict NATs you'll also want
a TURN server (see *Limitations* below).

### 2. Load the extension (Chrome or Edge)

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `watch-party/extension` folder.
4. Pin the **Livance** icon to your toolbar.

### 3. Throw a party

1. Open a title on Netflix and press play (URL looks like `netflix.com/watch/123…`).
2. Click the **Livance** toolbar icon → enter your name → **Create a party**.
3. Allow the mic/camera prompt (or skip for listen-only).
4. Copy the **invite code** and send it to your friends.
5. Each friend opens the **same title**, clicks the icon, pastes the code, and
   **Join party**.

Now anyone's play / pause / seek syncs to everyone, and the call overlay shows
each participant. Use the overlay (or the popup) to mute, toggle camera, hit
**⟳ resync** to pull everyone to your exact position, or leave.

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

- **Same title required per person** — DRM means we sync state, not pixels.
- **Mesh calls** scale comfortably to ~4–6 people. Beyond that, an SFU
  (e.g. mediasoup / LiveKit) would replace the mesh — a natural next step.
- **NAT traversal** uses public STUN. Some networks need a **TURN** server for
  the call to connect; add its `{ urls, username, credential }` to
  `ICE_SERVERS` in `content.js`.
- **Ads / intros / "Are you still watching?"** can momentarily desync a viewer;
  the ⟳ resync button snaps everyone back together.
- This is an MVP for personal/educational use and is **not affiliated with
  Netflix**. Respect Netflix's Terms of Use.

## Roadmap ideas

- Text chat & emoji reactions in the overlay
- Host-only vs. shared-control mode toggle
- Screen-name avatars + active-speaker highlight
- SFU backend for larger parties
- Firefox build (MV3 manifest variant)
