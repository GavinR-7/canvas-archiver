# Setup: nightly feed folder, Ed, and due.json

The extension works with no setup. These three things are optional and off by default.

## Nightly feed folder (Windows folder, not a WSL path)

The feed saves new or changed course files into a folder, and HQ's nightly job files them into the course knowledge base.

1. In Windows, create the folder `C:\Users\gavin\hq-course-inbox` (any empty folder works; this is the one HQ reads).
2. Extension Settings > Nightly feed > **Choose folder** > pick that folder > Allow. If Chrome asks again later, choose "Allow on every visit".
3. Turn on "Send new course files to HQ every night". Chrome has to be open at the time.

**Do not pick the `\\wsl.localhost\...` path.** Chrome refuses it ("contains system files"). The WSL side of the same folder is `/mnt/c/Users/gavin/hq-course-inbox`; HQ's ingest job reads it there. Nothing is uploaded anywhere; the files only move to that folder.

## Ed Discussion

Sign in to Ed yourself in the same Chrome, then press Refresh in Upcoming. The extension never stores an Ed password or token and never signs in for you; it reads with your existing session. If Ed shows an error banner, sign in again and refresh.

## due.json sync stays OFF

The "sync deadlines to GitHub" switch (`docs/DUE_JSON.md`) needs a GitHub token. Leave it off. Setting up that token is a separate step with its own card; until then nothing is written to GitHub, and Upcoming and the week schedule work without it.
