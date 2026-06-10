# Publishing Couch to the Chrome Web Store

This guide gets Couch onto the **Chrome Web Store** so anyone can install it with
one click — **no Developer mode, no "Load unpacked."** It also works for the
**Microsoft Edge Add-ons** store (same package).

> I (the assistant) can prepare everything here, but the actual submission must be
> done by you: it requires your Google account, a one-time **$5 USD** developer
> registration fee, and accepting Google's terms. The review then takes anywhere
> from a few hours to a few days.

---

## What's already prepared

- ✅ **Upload package:** `store-assets/couch-<version>.zip` (rebuild anytime with
  `./build.sh`). `manifest.json` is at the zip root, as required.
- ✅ **Minimal permissions:** only `storage` + access to `netflix.com` — the
  smallest set that works, which speeds up review.
- ✅ **No remote code:** PeerJS is bundled locally (the store forbids loading
  remote scripts). Couch only makes network *connections*, not remote code.
- ✅ **Icons:** 16 / 48 / 128 px in `extension/icons/`.
- ✅ **Promo images:** `store-assets/promo-small-440x280.png` and
  `promo-marquee-1400x560.png`.
- ✅ **Privacy policy:** `PRIVACY.md` — you'll need to host this at a public URL
  (see step 2).

---

## Step 1 — Register as a Chrome Web Store developer (one time)

1. Go to the **Chrome Web Store Developer Dashboard**:
   https://chrome.google.com/webstore/devconsole
2. Sign in with the Google account you want to publish under.
3. Pay the **one-time $5 registration fee** and accept the developer agreement.
4. (Recommended) Set up the publisher's email and verify it.

## Step 2 — Host the privacy policy

The store requires a **public privacy policy URL** because Couch uses camera/mic.
Easiest options:

- Push this repo to GitHub and use the raw URL of `PRIVACY.md`, **or**
- Turn on **GitHub Pages** for the repo and link to the rendered page, **or**
- Paste the contents into any free page host and use that link.

Keep the URL handy for step 4.

## Step 3 — Create the listing & upload

1. In the dashboard, click **Add new item**.
2. Upload `store-assets/couch-<version>.zip`.
3. Wait for the upload to validate (it reads your manifest).

## Step 4 — Fill in the store listing

Use the copy in [`store-assets/listing.md`](store-assets/listing.md). Summary of fields:

- **Name:** Couch — Watch Party
- **Summary (132 char max):** see listing.md
- **Description:** see listing.md
- **Category:** Entertainment (alt: Social & Communication)
- **Language:** English
- **Icon:** auto-pulled from the package (128 px).
- **Screenshots (required, 1280×800 or 640×400):** capture **real** screenshots of
  a live party (the overlay with call tiles on a Netflix page). At least one is
  required; 3–5 is better. _Use real captures — Google may reject purely
  promotional graphics as screenshots._
- **Small promo tile (440×280):** `store-assets/promo-small-440x280.png`
- **Marquee (1400×560, optional):** `store-assets/promo-marquee-1400x560.png`
- **Privacy policy URL:** the link from step 2.

## Step 5 — Privacy & data-use declarations

In the **Privacy practices** tab:

- **Single purpose:** "Synchronize Netflix playback among friends and provide a
  group video/audio call while watching together."
- **Permission justifications:**
  - `storage` — "Remembers the user's display name and optional broker setting
    locally on their device."
  - **Host access to `netflix.com`** — "Runs the watch-party overlay and
    synchronizes the Netflix player; the extension is inactive on all other
    sites."
- **Remote code:** select **No**, it is not used (PeerJS is bundled).
- **Data usage:** Couch does **not** collect or transmit user data to the
  developer. Camera/mic/voice/video and playback data flow **peer-to-peer**
  between participants and are not stored. Declare data types honestly:
  - "Personally identifiable information" → the display name is shared with party
    members only, not collected by you.
  - Confirm you **do not sell** data and do **not** use it for unrelated purposes.

## Step 6 — Submit for review

Click **Submit for review**. You can choose **Public**, **Unlisted** (only people
with the link can install — great for friends/testing), or **Private** (specific
accounts). For a friends-only watch party, **Unlisted** is often ideal.

After approval, share the install link — recipients click **Add to Chrome** with
**no Developer mode required.** 🎉

---

## A few things to know before you submit

- **Netflix trademark:** the extension **name** does not contain "Netflix" (good —
  using a trademark in the name risks rejection). The description mentions Netflix
  only to state compatibility, which is normally acceptable (other watch-party
  extensions do the same), but a reviewer could still ask you to adjust wording.
- **Camera/mic extensions** sometimes get extra review scrutiny. The clear
  single-purpose description and hosted privacy policy address this.
- **Updates:** bump `version` in `manifest.json`, run `./build.sh`, and upload the
  new zip to the same item. Re-review is usually faster than the first time.

## Also want Edge / Firefox?

- **Microsoft Edge Add-ons** (https://partner.microsoft.com/dashboard/microsoftedge):
  free registration, upload the **same zip**. Same review concept.
- **Firefox (AMO):** needs a few manifest tweaks (MV3 background differs) and a
  separate submission at https://addons.mozilla.org. Ask and I'll prepare a
  Firefox variant.
