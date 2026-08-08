# Couch - Privacy Policy

_Last updated: 2026-07-07_

Couch ("the extension") is a browser extension that lets friends watch Netflix,
YouTube, Prime Video, JioHotstar, Disney+, ZEE5 or Apple TV in sync, with a group chat,
voice, and video call. This policy explains what data the extension touches and
what it does not.

## The short version

- **We do not run servers that collect or store your data.**
- **We do not have analytics, tracking, ads, or accounts.**
- Your **camera, microphone, voice, video, and chat messages** are sent
  **directly to the other people in your party** (peer-to-peer) and are
  **never** recorded or routed to us.
- Couch **does not access, collect, or transmit your account, viewing
  history, or any video content** on any supported site.

## What the extension handles

| Data | Purpose | Where it goes | Stored? |
| --- | --- | --- | --- |
| Camera & microphone | The group video/audio call | Directly to other party members via WebRTC (peer-to-peer) | No |
| Chat messages | Group text chat | Directly to party members over the peer connection | No |
| Display name you type | Shown to others in the party | Sent to party members over the peer connection | Saved only in your browser's local storage so you don't retype it |
| Invite code & temporary peer IDs | Letting party members find each other | Exchanged via the signaling broker during connection setup only | No |
| Playback events & title ID | Keeping everyone's player in sync and on the same title | Sent to party members over the peer connection | No |
| Optional broker address you enter | Connecting to a different signaling broker | Your browser's local storage | Local only |

## Signaling broker

To introduce party members to each other, Couch uses a **signaling broker** -
a small server operated by Couch. The broker only relays the small
connection-setup messages (temporary peer IDs and WebRTC negotiation) needed
to establish a direct connection. **It does not carry your audio, video, chat,
playback data, or any streaming content** - those flow directly between
participants. You may point Couch at a different broker in the extension's
Advanced settings.

## STUN/TURN servers

To establish direct connections across networks, Couch uses public STUN
servers and, as a fallback, a TURN relay operated by Couch (on the same
server as the signaling broker). If the TURN relay is used, your call media
passes through it only to relay packets between participants - it is not
recorded, inspected, or stored.

## Permissions

- **`storage`** - to remember your display name and optional broker setting on
  your own device.
- **Access to the supported streaming sites** (Netflix, YouTube, Prime Video,
  JioHotstar, Disney+, ZEE5, Apple TV) - so the extension can run on their watch pages,
  show the call/chat overlay, and synchronize the player. It is not active on
  any other website.

## Third parties

The only third-party services are the signaling broker and TURN relay
described above, both operated by Couch. Couch shares no data with any other
third party and does not sell data.

## Children's privacy

Couch is not directed to children under 13 and collects no personal information.

## Changes

If this policy changes, the "Last updated" date above will change. Material
changes will be noted in the extension's store listing.

## Contact

For privacy questions, contact the publisher at the email listed on the
extension's Chrome Web Store page.
