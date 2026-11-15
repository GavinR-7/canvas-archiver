# Chrome Web Store: what this repo now ships, and what is left

Built on top of the v2 stack. Review PR: see the PR description.

## In the repo

- Icons: `extension/public/icon/{16,32,48,96,128}.png` (128 has 16 px transparent padding around 96 px art). Source: `docs/store/icon.svg` (render it at each size on a transparent background).
- Screenshots (1280x800, taken from the built extension with fictional data, no mockups): `docs/store/1-first-run-consent.png`, `2-upcoming.png`, `3-week-schedule.png`, `4-settings.png`.
- First-run consent: `extension/src/consent/consent.ts` and `src/ui/ConsentGate.tsx`. Every page shows the disclosure until you click accept; the service worker does no fetching, no alarm refresh and no feed run without it. Settings has "Withdraw consent".
- Course chat opt-in: per course, off by default (checkbox on the chat page, `src/chat/optin.ts`); the first-run screen says so. Courses cannot be listed on first run because nothing may be read before consent, so the per-course choice lives where the course is picked.
- Privacy policy: `docs/PRIVACY.md`.
- Manifest description now says "by default" (the opt-in features are real).

## Permissions, one line each (paste into the dashboard)

| Permission | Used for |
|---|---|
| `storage` | Cache of courses and due dates, settings, consent record, optional API key, all on the device. |
| `downloads` | The "Save to Downloads instead" fallback for course files. |
| `alarms` | Refresh due dates every 2 hours; optional nightly file run. |
| `https://canvas.cornell.edu/*` | Read the signed-in user's own Canvas data. Read-only. |
| `https://www.gradescope.com/*` | Read the user's assignment due dates from their signed-in Gradescope pages. |
| `https://edstem.org/*`, `https://us.edstem.org/*` | Read the user's Ed course dates and announcements. |
| optional `api.github.com`, `api.anthropic.com` | Asked only when the user turns on due-date sync or AI features. |

No `tabs`, `cookies`, `webRequest` or `<all_urls>`.

## Host permissions: why Cornell-only stays

The checklist asked to widen or explain. Recommendation: **explain, do not widen.** Widening to other schools means either `<all_urls>` or a list of every Canvas host; both lengthen review and trigger the excessive-permissions rejection. The Canvas origin is a one-line array (`src/config/canvas.ts`), so a second school is a one-line change plus a new listing note, and Chrome's optional host permissions could later let a user grant their own school at runtime. Until then the listing says "for Cornell students" and the store description already does.

## Left for Gavin (not done here, by design)

1. Where the privacy policy is hosted (question card).
2. Contact email in `docs/PRIVACY.md`, category, and the decision to publish at all (README still lists the store as out of scope).
3. Developer account and fee, `wxt zip`, upload and submit.
4. Reviewer test instructions: reviewers cannot sign in to Cornell Canvas. Use the screenshots plus a short screen recording.
5. Real-account run of `knowledge/docs/canvas-v2-test-10min.md` on the exact zip before upload.
