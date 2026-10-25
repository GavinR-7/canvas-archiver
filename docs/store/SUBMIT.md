# Submit to the Chrome Web Store: 10-minute runbook

Prerequisites (your part, nothing here creates them): a Chrome Web Store developer account (one-time registration fee), the two blanks below, and your answers on the question cards (ship free? where is the privacy policy hosted?).

## The two blanks only you fill

| Blank | Where it goes |
|---|---|
| **Contact email** | Replace `[CONTACT EMAIL: Gavin to fill before publishing]` in `docs/PRIVACY.md`, and the dashboard's Account tab contact email (it must be verified there). |
| **Privacy policy URL** | Dashboard, Privacy tab, "Privacy policy URL". Publish `docs/PRIVACY.md` first (GitHub Pages is the recommendation on the hosting card), then paste the URL. |

## Before you upload

1. Run `knowledge/docs/canvas-v2-test-10min.md` on the exact zip with your real accounts.
2. Confirm the zip: `sha256sum canvas-archiver-extension-0.1.0-chrome.zip` must match the `.sha256` file next to it (`deliverables/products/canvas-archiver/store-kit/`). To rebuild from this branch: `cd extension && npx wxt zip` (output `extension/.output/canvas-archiver-extension-0.1.0-chrome.zip`). Rebuilt zips may differ in hash; if you rebuild, test that one.

## Steps

1. Open https://chrome.google.com/webstore/devconsole and choose **New item**; upload the zip.
2. **Store listing tab**
   - Name: `Canvas Archiver` (from the manifest).
   - Summary (manifest description, 127 chars): `See everything due across your Canvas courses. Local-first: no account, no backend, and by default nothing leaves your browser.`
   - Description (paste):
     > Canvas Archiver puts everything due across your Canvas courses in one list, with a week schedule, and can save your course files to a folder on your computer.
     >
     > - Due dates from Canvas, plus Gradescope and Ed Discussion if you use them
     > - A week-at-a-glance schedule built from your classes and deadlines
     > - Save course files to a folder you choose
     > - Optional, off by default: due-date sync to a GitHub repo you own, AI file picking, and course chat that answers from your course materials. These use your own GitHub token or Anthropic API key, and course chat is switched on per course.
     >
     > Local-first: no account, no backend. Data stays in your browser unless you turn on an optional feature. First run shows exactly what is read and sent, and you can withdraw consent in Settings.
     >
     > Independent tool, not affiliated with or endorsed by Cornell University, Instructure (Canvas), Gradescope or Ed. Built for Cornell students' Canvas (canvas.cornell.edu).
   - Category: **Productivity**. Language: English.
   - Icon: `extension/public/icon/128.png` (already in the zip; the dashboard asks for it too).
   - Screenshots (1280x800, fictional data): `docs/store/1-first-run-consent.png`, `2-upcoming.png`, `3-week-schedule.png`, `4-settings.png`.
3. **Privacy tab**
   - **Single purpose:** `Show a student's due dates and course files from their own Canvas, Gradescope and Ed accounts in one place, on their own computer.`
   - **Permission justifications** (paste each):

     | Permission | Justification |
     |---|---|
     | `storage` | Cache of courses and due dates, settings, consent record and optional API key, all on the device. |
     | `downloads` | The "Save to Downloads instead" fallback for course files. |
     | `alarms` | Refresh due dates every 2 hours; optional nightly file run. |
     | `https://canvas.cornell.edu/*` | Read the signed-in user's own Canvas data. Read-only. |
     | `https://www.gradescope.com/*` | Read the user's assignment due dates from their signed-in Gradescope pages. |
     | `https://edstem.org/*`, `https://us.edstem.org/*` | Read the user's Ed course dates and announcements. |
     | optional `https://api.github.com/*`, `https://api.anthropic.com/*` | Requested only when the user turns on due-date sync or AI features. |

   - **Remote code:** No. All code ships in the package.
   - **Data usage** (tick what applies): *Personally identifiable information* (user's name from Canvas) and *Website content* (course text) and *Authentication information* (optional token or API key, stored on device). Certify: not sold, not used for unrelated purposes, not used for creditworthiness or lending.
   - **Privacy policy URL:** your blank above.
4. **Distribution tab:** visibility Public (or Unlisted for a first soft launch); regions as you prefer; pricing Free (recommended on the ship-free card).
5. **Test instructions** (paste into "Instructions for reviewers"):
   > The extension reads the signed-in user's own Canvas (canvas.cornell.edu), so a reviewer cannot exercise it without a Cornell login. On first run it shows a consent screen and fetches nothing until Accept is clicked. To review without signing in: open the extension's Upcoming page, which shows the consent screen; Settings has Withdraw consent and the optional features, all off by default. Screenshots of the full flow with fictional data are attached. No account or credentials are needed to install it, and no remote code is loaded.
   Attach `reviewer-walkthrough-1..4.png` from the kit folder if the form accepts files.
6. **Submit for review.** Choose manual publish after approval if you want to control the date.

## After submitting

- Expect review of the Cornell-only host permissions to be quick, because there is no `<all_urls>`. If the reviewer asks about scope, point to `docs/STORE_LISTING.md` ("Host permissions: why Cornell-only stays").
- If the policy host changes, update the Privacy tab and `docs/PRIVACY.md` together.
