# Canvas v2 release candidate

`codex/canvas-v2-rc` starts at fresh `main` (`8952c1c70c27088614c20bae29b3cce43100d338`). PRs #13 through #26 were integrated in numerical order using their frozen heads below. The original PRs remain open. #13 also carries the prerequisite #2–#12 stack; #15 is already present by ancestry when its turn is reached.

## Included PR heads

| PR | Intent | Exact included head |
| --- | --- | --- |
| [#13](https://github.com/GavinR-7/canvas-archiver/pull/13) | fix(extension): align scheduler refreshes with the due.json window | `d835e6f514b2bdf08e62b9fd0e7b6c9aa6d2b9b9` |
| [#14](https://github.com/GavinR-7/canvas-archiver/pull/14) | fix(hq-ingest): symlink confinement, port of gavin-data #186 (T-484) | `e747a834554eb8b2df59c2682b82b3b508a20b82` |
| [#15](https://github.com/GavinR-7/canvas-archiver/pull/15) | canvas v2 stack: #2-#11 into main (already merged into each other; Anvil-reviewed per PR) | `5ba8b2d8aa36f3b7271de77534a6bedb8f964406` |
| [#16](https://github.com/GavinR-7/canvas-archiver/pull/16) | feat(extension): current-term courses by default, Show all for old and admin (T-492) | `ceb3b6adfeaffa416afb034ed99be377ec1e8a27` |
| [#17](https://github.com/GavinR-7/canvas-archiver/pull/17) | feat(extension): All exams area in Upcoming (T-498) | `85a2bb470935f51101e2c9e4b6af99e9d9d9b40a` |
| [#18](https://github.com/GavinR-7/canvas-archiver/pull/18) | docs(extension): Windows feed folder, Ed and due.json setup notes (T-500) | `6aab55eb3ea0f28ff37d3eb6e0369b7f57a4b45a` |
| [#19](https://github.com/GavinR-7/canvas-archiver/pull/19) | feat(extension): no-key Find mode for course chat (T-501) | `e03e424fcee88cf842b11bbfba33c1d682f70816` |
| [#20](https://github.com/GavinR-7/canvas-archiver/pull/20) | feat(extension): course browser, tick files and download (T-503) | `5ee5b3cdb443b68fcd233b7ff527814d558943fd` |
| [#21](https://github.com/GavinR-7/canvas-archiver/pull/21) | feat(extension): save page attachments beside their pages, link the stubs to them (T-508) | `c5907f6a8d401f454537335fe6558d0e19d0d7a9` |
| [#22](https://github.com/GavinR-7/canvas-archiver/pull/22) | feat(extension): blocked file saves retry and fall back to Downloads (T-510) | `71f9ff856220b18beafae104326a3522e4d62009` |
| [#23](https://github.com/GavinR-7/canvas-archiver/pull/23) | feat(extension): exam dates from syllabus files, one Ed notice (T-512) | `805f7f7f6ae55c79e6cee814a7dba4e21b2b158c` |
| [#24](https://github.com/GavinR-7/canvas-archiver/pull/24) | feat(extension): manual per-course exam dates (T-519) | `a0362a004670ca6c05be15a54a663611ede7e1cf` |
| [#25](https://github.com/GavinR-7/canvas-archiver/pull/25) | feat(extension): Gradescope handouts in the browser, embedded images archived (T-525) | `4e371ea250621a56c79ce98bff4cee01f05c627e` |
| [#26](https://github.com/GavinR-7/canvas-archiver/pull/26) | Extension errors, popup prompt, honest Done line (T-535) | `4756f76b0155f16f80735a04a5842e74721122bb` |

## Integration decisions

- Retain affirmative source recognition, incomplete-read retention, bounded pagination, serialized sync, request timeouts and safe GitHub SHA/path handling from the scheduler work.
- Fetch source dates once out to the 240-day exam horizon using a shared clock; retain seven days overdue through sixty days ahead in the deadline snapshot and due.json. Popup and Upcoming use their shared fourteen-day UTC filter; All exams has a separate exam list.
- Retain cached far-future exams when their source fails. A per-course Ed failure reports one summary, continues the other courses and marks the source incomplete. Unknown Ed responses and saturated or continuing pages still cannot replace remote deadlines.
- Include syllabus-file and manually entered exams without dropping the completeness guard. Known unreadable syllabus files keep cached dates and prevent whole-list replacement. Completeness describes remote sources; manual dates remain local.
- Retain setup notes, current-term visibility and Show all, Find without an AI key, the file browser, attachments/images, Gradescope handouts, download fallback/retries and the honest archive summary.
- Preserve both popup imports and worker helpers so off-Canvas guidance and quiet signed-out logging coexist with the scheduler logic.

## Build from this branch

Run in WSL:

```bash
cd ~/hq/repos/canvas-archiver-wt-canvas-v2-rc
git switch codex/canvas-v2-rc
cd extension
npm ci
npm run compile
npm test
npm run build
cd ..
node --test tools/hq-ingest/ingest.test.mjs
```

The unpacked result is `extension/.output/chrome-mv3/`. The build uses the committed lockfile. The RC also includes a Windows copy of that directory at:

```text
C:\Users\gavin\.codex\visualizations\2026\10\25\01a173c6-dcb9-7e53-9ddd-aea080752e16\canvas-v2-rc\unpacked
```

## Load this exact build in Chrome on Windows

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** in the upper-right corner.
3. Click **Load unpacked**.
4. Select the exact Windows `unpacked` folder above. Select the directory that directly contains `manifest.json`, not the repository or the parent artifact directory.
5. Confirm the **Canvas Archiver** card appears. Pin it from Chrome's Extensions menu if desired.
6. Open Canvas in the same Chrome profile and sign in yourself. Open the extension, accept its first-run disclosure, then refresh. Ed and Gradescope also use your own signed-in browser sessions.
7. Leave GitHub deadline sync, AI content sharing and the nightly feed off unless you intentionally configure them. The existing setup instructions are in [SETUP.md](SETUP.md).
8. For a rebuilt copy at the same folder, click the reload icon on the Canvas Archiver card at `chrome://extensions`, then reopen its pages. A copy loaded from a different folder is a separate installation; Chrome storage from an older installation is not automatically migrated.

Chrome's official [unpacked-extension instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) describe the Developer mode, Load unpacked and reload controls.

## Validation and scope

The PR description records the exact tested RC head and final test counts. The generated Windows artifact has a separate file-hash manifest and build receipt. Automated checks use synthetic data; Gavin's signed-in account acceptance remains a manual step. This candidate is an unpacked build; no Chrome Web Store publication is part of the work.
