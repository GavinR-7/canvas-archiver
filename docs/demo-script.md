# Demo script: five captures

Goal: five images (or one short GIF made from them) that show the problem, the
product and the safety story in under a minute. Take them in this order. Use
your real signed-in accounts, then **blur or crop names, grades and course
content you would not post** before publishing anything.

## Setup (once)

1. Build and load the RC: in a terminal, `cd extension && npm ci && npm run build`,
   then at `chrome://extensions` turn on Developer mode, choose **Load unpacked**
   and pick `extension/.output/chrome-mv3/`. Windows steps: `docs/CANVAS_V2_RC.md`.
2. Pin the extension: puzzle icon, then the pin beside **Canvas Archiver**.
3. Sign in to Canvas (`canvas.cornell.edu`), and to Gradescope and Ed if you use
   them, in the same Chrome profile. Accept the first-run consent screen.
4. Browser window about 1280 px wide, light theme, extra toolbars hidden.
   Save PNGs as `docs/demo/1-popup.png` ... `5-chat.png`.

## Capture 1: the popup, signed in (the hook)

1. Open any tab on `https://canvas.cornell.edu`.
2. Click the extension icon.
3. Wait for your name, current-term courses and the Upcoming count to load.
4. Capture the popup. It shows the product works from the session you already
   have, with no token or login.

## Capture 2: one Upcoming list from three sources

1. In the popup click **Upcoming**.
2. Wait for items to load. Confirm you see source badges for Canvas and at least
   Gradescope or Ed.
3. Open **All exams** if present so exam dates show.
4. Capture the whole page. Caption: "Canvas, Gradescope and Ed in one list."

## Capture 3: archive a course to a folder you chose

1. Popup, then **Files**. Under **1. Folder** click **Choose folder** and pick or
   create `Documents/School`.
2. Under **2. Courses** tick one course with a lot of files. Click
   **Preview what will be saved** and wait for **3. Review** (counts and total size).
3. Click **Save to <folder name>**. Capture while it runs, showing progress.
4. When **Done** appears, capture a second image of that line.
5. Open the folder in your file manager and capture the tree
   (`Cornell/<course>/<module>/...`). Cropping to the Done line plus the folder
   tree makes one composite image.

## Capture 4: the second run downloads nothing new

1. On the same Files page preview and save the same course again.
2. Capture the Done line. It should read `0 new, N unchanged skipped, 0 failed`. This is the
   incremental manifest (changed files only), and it is the most convincing
   evidence of engineering.

## Capture 5: safety and the optional chat

1. Go to a non-Canvas tab (for example `https://example.com`) and click the icon.
   Capture the popup showing "open Canvas" guidance and the disabled refresh.
   This is the T-548 choice: off Canvas it makes no network request.
2. Popup, then **Course chat...**. Pick a course, tick that course's opt-in box
   (or use the no-key Find mode), ask "when is the first prelim?" and capture the
   answer with its numbered citation.

## Optional GIF

Record captures 3 and 4 as one screen recording (Windows: Win+G, or ScreenToGif),
under 25 seconds, trimmed to the first click and the Done line.

## Before you post

- Blur names, student IDs, grades and any course content under Cornell's
  materials rules. Do not publish files from the archive itself.
- If a source shows an error (Gradescope or Ed are not verified on a live
  account), do not hide it: note it in the caption. The README says so already.
- Put the PNGs in `docs/demo/` and link them from the README only after you have
  checked them.
