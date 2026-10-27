# POA project site

A password-protected project site for the Physique Optimization Agent (POA).

- Every page's content is encrypted. The site shows a password screen and decrypts the content in the browser.
- `data/` holds only encrypted files: `key.json`, `data.enc` (project data), and read-only copies of the project documents (`docs.enc` lists them with the diagrams, `docs/<key>.enc` holds each copy, `img/<id>.bin` each image). The copies let the documents be read on any computer without a Google sign-in. The **Update site data** workflow writes them every 15 minutes, and only when something changed.
- The workflow reads a read-only feed of allowlisted project fields and encrypts them with the site password. The password and the feed address are GitHub Actions secrets (`SITE_PASSWORD`, `FEED_URL`), never files in this repository.

## Changing the password

1. Repository **Settings → Secrets and variables → Actions → SITE_PASSWORD → Update secret**.
2. **Actions → Update site data → Run workflow**, or wait up to 15 minutes.

The old password stops working once the workflow finishes.

## Files

- `index.html`, `assets/site.css`, `assets/app.js`: the site (plain HTML, CSS and JavaScript; no build step).
- `tools/build.mjs`: reads the feed and encrypts it (Node 22, no dependencies). The documents it copies are listed in the feed (`COPIES`).
- `.github/workflows/build.yml`: the schedule.
