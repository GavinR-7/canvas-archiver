import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { destination, ingest, upsertIndex } from "./ingest.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "ingest-"));
  const inbox = path.join(root, "_inbox");
  mkdirSync(path.join(root, "ece3030"), { recursive: true });
  writeFileSync(path.join(root, "ece3030", "course.json"), JSON.stringify({ code: "ECE 3030", canvasId: null }));
  mkdirSync(path.join(inbox, "_batches"), { recursive: true });
  return { root, inbox };
}
function drop(inbox, rel, content) {
  mkdirSync(path.dirname(path.join(inbox, rel)), { recursive: true });
  writeFileSync(path.join(inbox, rel), content);
}
function batch(inbox, name, files) {
  writeFileSync(path.join(inbox, "_batches", name), JSON.stringify({
    createdAt: "2026-10-15T00:00:00Z", courses: { ece3030: 123456 },
    files: files.map(([rel, source, content]) => ({ course: rel.split("/")[0], path: rel, source, canvasModifiedAt: null, size: content.length, sha256: sha(content) })),
  }));
}

test("destination maps contract paths and rejects traversal", () => {
  assert.deepEqual(destination("ece3030/05-em-waves/lec05.pdf"), { course: "ece3030", relPath: "modules/05-em-waves/lec05.pdf" });
  assert.deepEqual(destination("ece3030/_syllabus/syllabus.html"), { course: "ece3030", relPath: "syllabus/syllabus.html" });
  assert.deepEqual(destination("ece3030/files/a.txt"), { course: "ece3030", relPath: "files/a.txt" });
  assert.equal(destination("ece3030/../x/a.txt"), null);
  assert.equal(destination("ECE 3030/files/a.txt"), null);
  assert.equal(destination("ece3030/random/a.txt"), null);
});

test("new file lands, is indexed, ledgered; inbox drained; rerun is a no-op", () => {
  const { root, inbox } = setup();
  drop(inbox, "ece3030/05-em-waves/notes.txt", "skin depth");
  batch(inbox, "2026-10-15T000000.json", [["ece3030/05-em-waves/notes.txt", "canvas:file/1", "skin depth"]]);
  const r = ingest({ inbox, root, today: "2026-10-15" });
  assert.equal(r.courses.ece3030.new, 1);
  assert.equal(readFileSync(path.join(root, "ece3030/modules/05-em-waves/notes.txt"), "utf8"), "skin depth");
  assert.equal(readFileSync(path.join(root, "ece3030/text/modules/05-em-waves/notes.txt.txt"), "utf8"), "skin depth");
  const index = readFileSync(path.join(root, "ece3030/index.md"), "utf8");
  assert.match(index, /## modules\/05-em-waves\/notes.txt/);
  assert.match(index, /source: canvas:file\/1/);
  assert.equal(JSON.parse(readFileSync(path.join(root, "ece3030/course.json"), "utf8")).canvasId, 123456);
  assert.ok(!existsSync(path.join(inbox, "_batches", "2026-10-15T000000.json")));
  assert.ok(!existsSync(path.join(inbox, "ece3030/05-em-waves/notes.txt")));
  const again = ingest({ inbox, root });
  assert.equal(again.batches, 0);
});

test("changed content keeps the old version as .v1 and marks updated", () => {
  const { root, inbox } = setup();
  drop(inbox, "ece3030/files/a.txt", "one");
  batch(inbox, "a.json", [["ece3030/files/a.txt", "canvas:file/9", "one"]]);
  ingest({ inbox, root, today: "2026-10-14" });
  drop(inbox, "ece3030/files/a.txt", "two");
  batch(inbox, "b.json", [["ece3030/files/a.txt", "canvas:file/9", "two"]]);
  const r = ingest({ inbox, root, today: "2026-10-15" });
  assert.equal(r.courses.ece3030.changed, 1);
  assert.equal(readFileSync(path.join(root, "ece3030/files/a.txt"), "utf8"), "two");
  assert.equal(readFileSync(path.join(root, "ece3030/files/a.txt.v1"), "utf8"), "one");
  const index = readFileSync(path.join(root, "ece3030/index.md"), "utf8");
  assert.equal(index.match(/## files\/a.txt/g).length, 1);
  assert.match(index, /added: 2026-10-14/);
  assert.match(index, /updated: 2026-10-15/);
});

test("two staged batches for one path both land, in order, and the staging folders are cleaned (T-461 stranded batch)", () => {
  const { root, inbox } = setup();
  const staged = (name, content) => {
    const stage = `_staged/${name}/ece3030/files/a.txt`;
    drop(inbox, stage, content);
    const entry = { course: "ece3030", path: "ece3030/files/a.txt", stage, source: "canvas:file/9", canvasModifiedAt: null, size: content.length, sha256: sha(content) };
    writeFileSync(path.join(inbox, "_batches", `${name}.json`), JSON.stringify({ createdAt: "2026-10-24T00:00:00Z", courses: { ece3030: 1 }, files: [entry] }));
  };
  staged("2026-10-24T020000", "one");
  staged("2026-10-25T020000", "two"); // the nightly ingest missed a night
  const r = ingest({ inbox, root, today: "2026-10-25" });
  assert.equal(r.courses.ece3030.failed ?? 0, 0);
  assert.deepEqual(r.kept, []);
  assert.equal(readFileSync(path.join(root, "ece3030/files/a.txt"), "utf8"), "two");
  assert.equal(readFileSync(path.join(root, "ece3030/files/a.txt.v1"), "utf8"), "one");
  assert.equal(existsSync(path.join(inbox, "_staged")), false);
});

test("a stage that is not this entry's own _staged copy is refused", () => {
  const { root, inbox } = setup();
  drop(inbox, "ece3030/files/other.txt", "x");
  writeFileSync(path.join(inbox, "_batches", "a.json"), JSON.stringify({
    createdAt: "t", courses: {},
    files: [{ course: "ece3030", path: "ece3030/files/a.txt", stage: "ece3030/files/other.txt", source: "canvas:file/1", size: 1, sha256: sha("x") }],
  }));
  const r = ingest({ inbox, root, today: "2026-10-25" });
  assert.deepEqual(r.kept, ["a.json"]);
  assert.equal(existsSync(path.join(root, "ece3030/files/a.txt")), false);
});

test("hash mismatch fails, keeps file and batch in the inbox", () => {
  const { root, inbox } = setup();
  drop(inbox, "ece3030/files/a.txt", "tampered");
  batch(inbox, "a.json", [["ece3030/files/a.txt", "canvas:file/1", "original"]]);
  const r = ingest({ inbox, root });
  assert.equal(r.courses.ece3030.failed, 1);
  assert.ok(existsSync(path.join(inbox, "_batches/a.json")));
  assert.ok(!existsSync(path.join(root, "ece3030/files/a.txt")));
});

test("unknown course and stray files are reported, not ingested", () => {
  const { root, inbox } = setup();
  drop(inbox, "zzz9999/files/a.txt", "x");
  drop(inbox, "ece3030/files/stray.txt", "y");
  batch(inbox, "a.json", [["zzz9999/files/a.txt", "canvas:file/1", "x"]]);
  const r = ingest({ inbox, root });
  assert.equal(r.unknownCourses.length, 1);
  assert.deepEqual(r.strays, ["ece3030/files/stray.txt"]);
  assert.ok(!existsSync(path.join(root, "zzz9999")));
});

test("upsertIndex keeps Topics on top and replaces blocks in place", () => {
  const start = "# Index\n\n## Topics\n- skin depth\n\n## files/a\n- old\n\n";
  const out = upsertIndex(start, "files/b", "## files/b\n- new");
  assert.ok(out.indexOf("## Topics") < out.indexOf("## files/b"));
  assert.ok(out.indexOf("## files/b") < out.indexOf("## files/a"));
  const replaced = upsertIndex(out, "files/a", "## files/a\n- fresh");
  assert.match(replaced, /- fresh/);
  assert.doesNotMatch(replaced, /- old/);
});
