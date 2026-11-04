# Canvas Archiver privacy policy

Last updated: 2026-10-24. Contact: [CONTACT EMAIL: Gavin to fill before publishing]. Publisher: Gavin Reis.

Canvas Archiver is a browser extension that shows a student's due dates and course files from their own Canvas, Gradescope and Ed Discussion accounts in one place, on their own computer.

## What it reads

Using the sessions you are already signed in to, and only from sites you have used:

- Canvas (canvas.cornell.edu): your name, courses, assignments, quizzes, discussions, due dates, announcements, syllabi and course pages. Course files, only when you ask to save them.
- Gradescope: your assignment names and due dates.
- Ed Discussion: your course dates and staff announcements.

It is read-only. It never submits, edits or deletes anything on those sites. It does not collect your password or a Canvas access token; it relies on your browser's existing sign-in.

## Where data goes

- **Stored on your device:** a cache of the above in the extension's local storage, and course files in the folder you choose (or your Downloads folder if you pick that). No data is stored on any server, because there is no server.
- **Sent anywhere else:** only when you turn on an optional feature, and each is off by default. The browser asks you for the extra site permission when you do.
  - *Due-date sync to GitHub:* a file listing your upcoming deadlines (course, title, due time, link, done or not) is written to the GitHub repository you name, using a token you create and enter. Nothing else is sent.
  - *File picking:* file and folder names are sent to the AI provider (Anthropic) using your own API key.
  - *Course chat:* asked **per course** and off for every course until you tick that course's box. Only then are the few passages found for your question sent to Anthropic using your own API key. The key is stored only on your device. The provider's own terms govern what it does with that text; we never see it.
- **Tokens and keys, retention:** the GitHub token and the Anthropic API key you enter are stored on your device in the extension's local storage (not synced, not sent anywhere except to GitHub or Anthropic respectively) for as long as the feature that uses them is on. Turning the feature off, or clearing the field, deletes the token or key from storage. They are tokens you can revoke, not passwords.
- **Never:** no analytics or telemetry, no advertising, no sale or transfer of your data, no human reads your data, no use for anything except showing it to you.

## Your controls

Withdraw consent in Settings (all reading stops). Turn off the optional features in Settings. Revoke the GitHub token or API key at the provider. Remove the extension to delete everything it stored; files it saved in your folder are yours and stay until you delete them.

## Students and education records

Course materials and grades belong to you and your school. This extension runs entirely under your own login and keeps the result on your machine. It is an independent tool, not affiliated with or endorsed by Cornell University, Instructure (Canvas), Gradescope or Ed. Check your school's rules on third-party tools and on AI services before using the optional AI features.

## Limited Use

The use of information received from Google APIs and the Chrome Web Store will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide the features described above.

## Security

Every network request uses HTTPS. Credentials are sent only to the site they belong to.

## Changes

If the extension starts sending data anywhere new, this page changes first and the extension asks for consent again. The date above shows the latest version.
