# Couch website

A small static site for the Couch extension: landing page, **privacy policy**,
terms, and support/FAQ. Its main job is to provide the **public privacy-policy
URL** the Chrome Web Store requires.

```
website/
├── index.html      # landing page (features, how it works)
├── privacy.html    # Privacy Policy  ← use this URL in the store listing
├── terms.html      # Terms of Use
├── support.html    # Support / FAQ
├── styles.css
├── netlify.toml    # Netlify config (static, no build)
└── assets/         # logo + hero image
```

## Deploy to Netlify (no build step)

### Option A - connect this Git repo (recommended)
1. Sign in at <https://app.netlify.com> → **Add new site → Import an existing project**.
2. Pick this repository and branch.
3. Set **Base directory** to `watch-party/website`.
4. Leave **Build command** empty and **Publish directory** as `.` (the
   included `netlify.toml` already sets this).
5. Deploy. You'll get a URL like `https://couch-watchparty.netlify.app`.
6. (Optional) Rename the site under **Site settings → Site name** to get a nicer
   subdomain.

### Option B - drag-and-drop (fastest, no Git)
1. Download/zip the contents of this `website/` folder.
2. Go to <https://app.netlify.com/drop> and drop the folder in.
3. Done - you get an instant URL.

## Use it for the Chrome Web Store

In the store listing, set the **Privacy policy URL** to:

```
https://YOUR-SITE.netlify.app/privacy
```

(`/privacy`, `/terms`, and `/support` all work without the `.html` extension.)

## Notes
- Update the contact email in `privacy.html`, `terms.html`, and `support.html`
  if you want a different address (currently `saurabhsocialowl@gmail.com`).
- Once the extension is live, add the Chrome Web Store link in the
  `#install` section of `index.html`.
