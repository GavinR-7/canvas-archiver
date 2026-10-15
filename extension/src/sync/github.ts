/**
 * Writing one file to one GitHub repo through the contents API.
 *
 * This is the first place the extension sends data off the machine, so it is
 * narrow on purpose: one fixed host, one repo and path the person typed, a
 * token they created with contents:write on that repo only, sent only in the
 * Authorization header and never logged or put in an error message.
 */

export interface SyncSettings {
  enabled: boolean;
  /** `owner/name` */
  repo: string;
  path: string;
  token: string;
}

export const DEFAULT_SETTINGS: SyncSettings = { enabled: false, repo: "GavinR-7/gavin-data", path: "due.json", token: "" };

export const API = "https://api.github.com";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_.\/-]+$/;

export function validate(settings: SyncSettings): string | null {
  if (!REPO.test(settings.repo)) return "Repository must look like owner/name.";
  if (!PATH.test(settings.path)) return "File path must be relative, with no '..'.";
  if (!settings.token) return "Paste a fine-grained token with contents: read and write on that one repository.";
  return null;
}

export type SyncOutcome =
  | { status: "unchanged" }
  | { status: "updated"; created: boolean }
  | { status: "failed"; message: string };

type Fetch = typeof fetch;

const toBase64 = (text: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const fromBase64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function explain(status: number): string {
  if (status === 401) return "GitHub rejected the token (expired or mistyped).";
  if (status === 403) return "GitHub refused: the token lacks contents write on this repo, or you are rate limited.";
  if (status === 404) return "Repository not found, or the token cannot see it.";
  if (status === 409 || status === 422) return "The file changed while syncing; it will retry on the next run.";
  return `GitHub answered ${status}.`;
}

/**
 * Create or update `settings.path` with `content`, unless identical per `same`.
 * One retry when the file's sha went stale between read and write.
 */
export async function putFile(
  settings: SyncSettings,
  content: string,
  same: (existing: string) => boolean,
  commitMessage: string,
  doFetch: Fetch = fetch,
): Promise<SyncOutcome> {
  const problem = validate(settings);
  if (problem) return { status: "failed", message: problem };
  const url = `${API}/repos/${settings.repo}/contents/${settings.path}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    let sha: string | undefined;
    try {
      const read = await doFetch(url, { headers: headers(settings.token), cache: "no-store" });
      if (read.ok) {
        const body = (await read.json()) as { sha?: string; content?: string };
        sha = body.sha;
        if (body.content && same(fromBase64(body.content))) return { status: "unchanged" };
      } else if (read.status !== 404) {
        return { status: "failed", message: explain(read.status) };
      }

      const write = await doFetch(url, {
        method: "PUT",
        headers: headers(settings.token),
        body: JSON.stringify({ message: commitMessage, content: toBase64(content), ...(sha ? { sha } : {}) }),
      });
      if (write.ok) return { status: "updated", created: sha === undefined };
      if ((write.status === 409 || write.status === 422) && attempt === 0) continue;
      return { status: "failed", message: explain(write.status) };
    } catch {
      // Never include the error text: some runtimes echo request headers.
      return { status: "failed", message: "Could not reach GitHub. Check your connection." };
    }
  }
  return { status: "failed", message: explain(409) };
}
