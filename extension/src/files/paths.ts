/**
 * Turning Canvas names into names a file system accepts.
 *
 * Canvas lets instructors name a module "Week 3: Interrupts / Timers?" and a
 * file "Lab 2 – final.v3.pdf ". Windows rejects `:`, `?`, `/`, trailing dots and
 * spaces, and device names like `CON`; macOS and Linux reject `/`. Chrome's
 * directory handles also reject `..` and empty segments. Everything that
 * becomes a path segment goes through here, so the layout is the same on every
 * OS and a folder moved between machines still opens.
 */

const MAX_SEGMENT = 100;
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** One path segment (a folder name). Never empty, never `.` or `..`. */
export function sanitizeSegment(name: string, fallback = "untitled"): string {
  let clean = name.normalize("NFC").replace(ILLEGAL, "-").replace(/\s+/g, " ").trim();
  clean = clean.replace(/[. ]+$/, "").replace(/^\.+/, "");
  if (clean.length > MAX_SEGMENT) clean = clean.slice(0, MAX_SEGMENT).trimEnd();
  clean = clean.replace(/[. ]+$/, "");
  if (!clean) return fallback;
  if (RESERVED.test(clean)) clean = `_${clean}`;
  return clean;
}

/** Split `name.ext` at the last dot, treating `.gitignore`-style names as having no extension. */
function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || name.length - dot > 12) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

/** A file name: sanitised like a segment, but truncation keeps the extension. */
export function sanitizeFilename(name: string, fallback = "file"): string {
  const [stem, ext] = splitExtension(name.normalize("NFC").trim());
  const cleanExt = ext.replace(ILLEGAL, "");
  const room = Math.max(1, MAX_SEGMENT - cleanExt.length);
  const cleanStem = sanitizeSegment(stem.slice(0, room), fallback);
  return sanitizeSegment(`${cleanStem}${cleanExt}`, fallback);
}

/**
 * Make `names` unique within one folder, case-insensitively (Windows and macOS
 * treat `A.pdf` and `a.pdf` as the same file). The second `Notes.pdf` becomes
 * `Notes (2).pdf`. Order is preserved, so the first claimant keeps its name.
 */
export function uniqueNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    if (taken.has(candidate.toLowerCase())) {
      const [stem, ext] = splitExtension(name);
      for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
        candidate = `${stem} (${n})${ext}`;
      }
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}
