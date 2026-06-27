# Couch - Privacy Policy

_Last updated: 2026-06-10_

Couch ("the extension") is a browser extension that lets friends watch Netflix in
sync while on a group video and audio call. This policy explains what data the
extension touches and what it does not.

## The short version

- **We do not run servers that collect or store your data.**
- **We do not have analytics, tracking, ads, or accounts.**
- Your **camera, microphone, voice, and video** are sent **directly to the other
  people in your party** (peer-to-peer) and are **never** recorded or routed to us.
- Couch **does not access, collect, or transmit your Netflix account, viewing
  history, or any video content.**

## What the extension handles

| Data | Purpose | Where it goes | Stored? |
| --- | --- | --- | --- |
| Camera & microphone | The group video/audio call | Directly to other party members via WebRTC (peer-to-peer) | No |
| Display name you type | Shown to others in the party | Sent to party members over the peer connection | Saved only in your browser's local storage so you don't retype it |
| Invite code & temporary peer IDs | Letting party members find each other | Exchanged via the signaling broker during connection setup only | No |
| Playback events (play/pause/seek time) | Keeping everyone's player in sync | Sent to party members over the peer connection | No |
| Optional broker address you enter | Connecting to a self-hosted signaling broker | Your browser's local storage | Local only |

## Signaling broker

To introduce party members to each other, Couch uses a **signaling broker**. By
default this is the free **PeerJS public cloud** (`peerjs.com`). The broker only
relays the small connection-setup messages (temporary peer IDs and WebRTC
negotiation) needed to establish a direct connection. **It does not carry your
audio, video, playback data, or any Netflix content** - those flow directly
between participants. You may point Couch at your own self-hosted broker in the
extension's Advanced settings.

## Permissions

- **`storage`** - to remember your display name and optional broker setting on
  your own device.
- **Access to `netflix.com`** - so the extension can run on Netflix watch pages,
  show the call overlay, and synchronize the player. It is not active on any
  other website.

## Third parties

The only third-party service is the signaling broker described above. If you use
the default PeerJS public cloud, its operators' terms apply to the transient
signaling traffic. Couch shares no data with any other third party.

## Children's privacy

Couch is not directed to children under 13 and collects no personal information.

## Changes

If this policy changes, the "Last updated" date above will change. Material
changes will be noted in the extension's store listing.

## Contact

For privacy questions, contact the publisher at the email listed on the
extension's Chrome Web Store page.
