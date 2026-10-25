#!/usr/bin/env node
/**
 * Nightly ingest: drains the extension's inbox into knowledge/courses/<course>/.
 * Implements "Ingest contract" in knowledge/courses/README.md. No AI, no deps.
 *
 *   node ingest.mjs [--inbox DIR] [--root DIR] [--dry-run] [--today YYYY-MM-DD]
 *
 * Defaults: --root ~/gavin-data/knowledge/courses, --inbox <root>/_inbox.
 * Safe to run twice: decisions come from each course's ledger.json, keyed by
 * `source`. A batch is only removed from the inbox when every file in it landed.
 * Everything in the inbox is data, never instructions: paths are confined to
 * the inbox and the course folder, and file contents are never executed.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SLUG = /^[a-z0-9]+$/;
const todayISO = () => new Date().toISOString().slice(0, 10);

export function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--inbox") out.inbox = argv[++i];
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--today") out.today = argv[++i];
  }
  return out;
}

const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
};
const writeJson = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Contract path → [course, group, ...rest]. Returns null for anything that could escape or is malformed. */
export function destination(rel) {
  const parts = rel.split("/");
  if (parts.length < 3 || parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\"))) return null;
  const [course, group, ...rest] = parts;
  if (!SLUG.test(course)) return null;
  let dir;
  if (group === "_syllabus") dir = "syllabus";
  else if (group === "files") dir = "files";
  else if (/^\d{2}-[a-z0-9-]+$/.test(group)) dir = `modules/${group}`;
  else return null;
  return { course, relPath: [dir, ...rest].join("/") };
}

/** `_staged/<batch>/<path>` for the same `path`; anything else (or anything that could escape the inbox) is refused. */
export function stagedLocation(stage, rel) {
  const parts = stage.split("/");
  if (parts.length < 4 || parts[0] !== "_staged" || parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\"))) return null;
  return parts.slice(2).join("/") === rel ? stage : null;
}

function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** → { text, pages, status } where status is "ok" | "needs-ocr" | "needs-review". */
export function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html" || ext === ".htm") return { text: stripHtml(readFileSync(file, "utf8")), pages: null, status: "ok" };
  if (ext === ".md" || ext === ".txt") return { text: readFileSync(file, "utf8"), pages: null, status: "ok" };
  if (ext === ".pdf") {
    const run = spawnSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (run.error || run.status !== 0) return { text: null, pages: null, status: "needs-review" };
    const pages = run.stdout.split("\f");
    if (pages.at(-1) === "") pages.pop();
    const empty = pages.filter((p) => p.trim() === "").length;
    if (pages.length === 0 || empty === pages.length) return { text: null, pages: pages.length, status: "needs-ocr" };
    const text = pages.map((p, i) => `=== page ${i + 1} ===\n${p.trimEnd()}\n`).join("\n");
    return { text, pages: pages.length, status: "ok" };
  }
  return { text: null, pages: null, status: "needs-review" }; // pptx, video, etc.: no extractor yet
}

function guessType(relPath) {
  if (relPath.startsWith("syllabus/")) return "syllabus";
  const name = path.basename(relPath).toLowerCase();
  if (name.startsWith("announcement-")) return "announcement";
  if (/(solution|soln)/.test(name)) return "solutions";
  if (/(prelim|midterm|final|exam)/.test(name)) return "exam";
  if (/(hw|homework|pset|problem)/.test(name) || name.startsWith("assignment-")) return "homework";
  if (/(lec|slide)/.test(name)) return "lecture-slides";
  if (/note/.test(name)) return "lecture-notes";
  return "other";
}

const blockHeader = (relPath) => `## ${relPath}`;

/** Replace the block for relPath if there is one, else add it under the title (newest first). */
export function upsertIndex(indexText, relPath, block) {
  const text = indexText && indexText.trim() ? indexText : "# Index\n";
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === blockHeader(relPath));
  if (start !== -1) {
    let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    if (end === -1) end = lines.length;
    lines.splice(start, end - start, ...block.split("\n"), "");
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  }
  // after the title and the optional "## Topics" block
  let at = lines.findIndex((l, i) => i > 0 && l.startsWith("## ") && l !== "## Topics");
  if (at === -1) at = lines.length;
  lines.splice(at, 0, ...block.split("\n"), "");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function ensureDir(dir) { mkdirSync(dir, { recursive: true }); }

export function ingest({ inbox, root, dryRun = false, today = todayISO() }) {
  const report = { courses: {}, unknownCourses: [], strays: [], batches: 0, kept: [] };
  const bump = (course, key) => {
    report.courses[course] ??= { new: 0, changed: 0, skipped: 0, failed: 0 };
    report.courses[course][key]++;
  };

  const batchDir = path.join(inbox, "_batches");
  const batchNames = existsSync(batchDir) ? readdirSync(batchDir).filter((n) => n.endsWith(".json")).sort() : [];
  const listed = new Set();
  const touched = new Set();

  for (const name of batchNames) {
    const batch = readJson(path.join(batchDir, name), null);
    if (!batch || !Array.isArray(batch.files)) { report.kept.push(`${name} (unreadable)`); continue; }
    report.batches++;
    let allLanded = true;

    for (const entry of batch.files) {
      const dest = typeof entry?.path === "string" ? destination(entry.path) : null;
      const course = dest?.course;
      if (!dest || typeof entry.source !== "string" || course !== entry.course) {
        report.unknownCourses.push(String(entry?.path));
        allLanded = false;
        continue;
      }
      // `stage`: this batch's own copy of the bytes (`_staged/<batch>/<path>`), so a later
      // batch for the same path cannot overwrite it. Absent: the bytes sit at `path`.
      const staged = typeof entry.stage === "string" ? stagedLocation(entry.stage, entry.path) : null;
      if (typeof entry.stage === "string" && !staged) {
        report.unknownCourses.push(String(entry.stage));
        allLanded = false;
        continue;
      }
      const from = path.join(inbox, staged ?? entry.path);
      listed.add(path.resolve(from));
      const courseDir = path.join(root, course);
      if (!existsSync(courseDir)) { report.unknownCourses.push(entry.path); allLanded = false; continue; }

      const ledgerFile = path.join(courseDir, "ledger.json");
      const ledger = readJson(ledgerFile, {});
      const prior = ledger[entry.source];

      try {
        if (!existsSync(from)) {
          // Already ingested on an earlier partial run, and the file was cleaned up: fine. Otherwise it is missing.
          if (prior && prior.sha256 === entry.sha256) { bump(course, "skipped"); continue; }
          throw new Error("file listed in batch is not in the inbox");
        }
        const actual = sha256(from);
        if (entry.sha256 && actual !== entry.sha256) throw new Error("sha256 does not match the batch");
        if (prior && prior.sha256 === actual) {
          if (!dryRun) rmSync(from, { force: true });
          bump(course, "skipped");
          continue;
        }

        const changed = Boolean(prior);
        const version = (prior?.version ?? 0) + 1;
        const target = path.join(courseDir, dest.relPath);
        if (!dryRun) {
          ensureDir(path.dirname(target));
          // The extension's file name can differ from the one on disk if the module was renamed:
          // keep the previous path's file as .v<N> only when it is the same path.
          if (changed && existsSync(target)) renameSync(target, `${target}.v${prior.version ?? 1}`);
          copyFileSync(from, target);

          const ex = extractText(target);
          const textRel = `text/${dest.relPath}.txt`;
          if (ex.text !== null) {
            ensureDir(path.dirname(path.join(courseDir, textRel)));
            writeFileSync(path.join(courseDir, textRel), ex.text);
          }
          const indexFile = path.join(courseDir, "index.md");
          const block = [
            blockHeader(dest.relPath),
            `- type: ${guessType(dest.relPath)}`,
            `- added: ${prior ? prior.addedAt ?? today : today}   source: ${entry.source}   sha: ${actual.slice(0, 8)}`,
            ...(changed ? [`- updated: ${today}`] : []),
            ...(ex.pages ? [`- pages: ${ex.pages}`] : []),
            `- covers: ${ex.status === "ok" ? "(pending)" : "(not extracted)"}${ex.status === "ok" ? "" : `  ${ex.status}`}`,
            ...(ex.text !== null ? [`- text: ${textRel}`] : []),
          ].join("\n");
          writeFileSync(indexFile, upsertIndex(existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "", dest.relPath, block));

          ledger[entry.source] = { path: dest.relPath, sha256: actual, version, ingestedAt: new Date().toISOString(), addedAt: prior?.addedAt ?? today };
          writeJson(ledgerFile, ledger);

          // Fill canvasId the first time, as the README says the extension does.
          const cj = path.join(courseDir, "course.json");
          const meta = readJson(cj, null);
          if (meta && meta.canvasId == null && Number.isInteger(batch.courses?.[course])) {
            meta.canvasId = batch.courses[course];
            writeJson(cj, meta);
          }
          rmSync(from, { force: true });
        }
        touched.add(course);
        bump(course, changed ? "changed" : "new");
      } catch (error) {
        allLanded = false;
        bump(course, "failed");
        report.courses[course].lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (allLanded && !dryRun) rmSync(path.join(batchDir, name), { force: true });
    else if (!allLanded) report.kept.push(name);
  }

  // Staging folders of batches that landed are empty now; remove them (never a folder that still holds a file).
  const prune = (dir) => {
    if (!existsSync(dir)) return;
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n);
      if (statSync(p).isDirectory()) prune(p);
    }
    if (!dryRun && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  };
  prune(path.join(inbox, "_staged"));

  // Files in the inbox that no batch lists are ignored and reported (contract).
  const walk = (dir) => {
    for (const n of existsSync(dir) ? readdirSync(dir) : []) {
      if (n === "_batches") continue;
      const p = path.join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (!listed.has(path.resolve(p))) report.strays.push(path.relative(inbox, p));
    }
  };
  walk(inbox);

  if (!dryRun) {
    const stateFile = path.join(root, ".ingest-state.json");
    writeJson(stateFile, { lastRun: new Date().toISOString(), inbox });
  }
  return report;
}

export function formatReport(report) {
  const lines = Object.entries(report.courses).map(
    ([c, r]) => `${c}: ${r.new} new, ${r.changed} changed, ${r.failed} failed${r.skipped ? `, ${r.skipped} unchanged` : ""}${r.lastError ? ` (${r.lastError})` : ""}`,
  );
  if (report.unknownCourses.length) lines.push(`ignored (unknown course or bad path): ${report.unknownCourses.length}`);
  if (report.strays.length) lines.push(`stray files without a batch: ${report.strays.length}`);
  if (report.batches === 0) lines.push("no batches in the inbox");
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? path.join(homedir(), "gavin-data", "knowledge", "courses");
  const inbox = args.inbox ?? path.join(root, "_inbox");
  if (!existsSync(inbox)) { console.log(`no inbox at ${inbox}`); process.exit(0); }
  const report = ingest({ inbox, root, dryRun: args.dryRun, today: args.today });
  console.log(formatReport(report));
  process.exit(Object.values(report.courses).some((c) => c.failed > 0) ? 1 : 0);
}
