/**
 * Regressions for Anvil's T-461 findings on the stack: a course's folder follows its
 * Canvas id (not the selection), a folder owned by another course is refused, a later
 * feed cannot overwrite an unconsumed batch, and tokens/keys do not outlive their feature.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAi, saveAi } from "@/src/ai/model";
import { loadDirBindings, rememberDirBindings } from "@/src/files/dirs";
import { archiveLayout, ingestLayout } from "@/src/files/layout";
import { emptyManifest, ForeignCourseError, hashText, type CourseManifest } from "@/src/files/manifest";
import { allocateCourseNames, bindingsOf, planCourses, type CourseSources } from "@/src/files/plan";
import { runArchive, type FileSink, type ManifestStore } from "@/src/files/runner";
import { folderManifestStore } from "@/src/files/sinks";
import { loadSettings, saveSettings } from "@/src/sync/settings";

function stubStorage() {
  const data: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: { local: { get: async (k: string) => (k in data ? { [k]: data[k] } : {}), set: async (o: Record<string, unknown>) => void Object.assign(data, o) } },
  });
  return data;
}
afterEach(() => vi.unstubAllGlobals());

const sourcesWith = (html: string): CourseSources => ({
  modules: [],
  folders: [],
  files: [],
  documents: [{ kind: "page", key: "notes", title: "Notes", html, modifiedAt: null, htmlUrl: null }],
});
const input = (id: number, html: string, code = "CS 1234") => ({
  course: { id, name: "Synthetic Course", courseCode: code },
  sources: sourcesWith(html),
});

function disk() {
  const files = new Map<string, string>();
  const sink: FileSink = {
    keepsRecords: true,
    size: async (p) => (files.has(p.join("/")) ? (files.get(p.join("/")) as string).length : null),
    readText: async (p) => files.get(p.join("/")) ?? null,
    writeText: async (p, t) => void files.set(p.join("/"), t),
    save: async (item) => {
      const text = item.content ?? `bytes of ${item.source}`;
      files.set(item.path.join("/"), text);
      return { size: text.length, sha256: hashText(text) };
    },
  };
  return { files, sink };
}

describe("course folders follow the Canvas course id", () => {
  const a = input(1, "COURSE_A_ORIGINAL");
  const b = input(2, "COURSE_B_CONTENT");

  it("allocates the second same-named course ' (2)', the ingest slug '-2'", () => {
    expect(allocateCourseNames([a.course, b.course], archiveLayout)).toEqual(["CS 1234 Synthetic Course", "CS 1234 Synthetic Course (2)"]);
    expect(allocateCourseNames([a.course, b.course], ingestLayout)).toEqual(["cs1234", "cs1234-2"]);
  });

  it("keeps B out of A's folder when only B is selected later (Anvil probe)", async () => {
    stubStorage();
    const { files, sink } = disk();

    const both = planCourses([a, b], archiveLayout, await loadDirBindings("archive"));
    await rememberDirBindings("archive", both);
    await runArchive(both, archiveLayout, sink, folderManifestStore(sink));
    const aPath = both[0]?.items[0]?.path.join("/") as string;
    expect(files.get(aPath)).toContain("COURSE_A_ORIGINAL");

    const onlyB = planCourses([b], archiveLayout, await loadDirBindings("archive"));
    expect(onlyB[0]?.folder).toBe("CS 1234 Synthetic Course (2)");
    await rememberDirBindings("archive", onlyB);
    await runArchive(onlyB, archiveLayout, sink, folderManifestStore(sink));

    expect(files.get(aPath)).toContain("COURSE_A_ORIGINAL");
    expect(files.get(aPath)).not.toContain("COURSE_B_CONTENT");
  });

  it("a course renamed in Canvas keeps its folder, and a new same-named course cannot take an unselected course's", async () => {
    stubStorage();
    const first = planCourses([a], archiveLayout, {});
    await rememberDirBindings("archive", first);
    const bound = await loadDirBindings("archive");
    const renamed = planCourses([{ ...a, course: { ...a.course, name: "Retitled" } }], archiveLayout, bound);
    expect(renamed[0]?.folder).toBe(first[0]?.folder);
    // B alone, A not selected: still not A's folder.
    expect(planCourses([b], archiveLayout, bound)[0]?.folder).toBe("CS 1234 Synthetic Course (2)");
  });

  it("refuses to bind a folder that another course already holds", async () => {
    stubStorage();
    await rememberDirBindings("archive", planCourses([a], archiveLayout, {}));
    const stale = planCourses([b], archiveLayout, {}); // planned without the bindings: also wants A's folder
    await expect(rememberDirBindings("archive", stale)).rejects.toThrow(/belongs to another course/);
    expect(bindingsOf(stale)[2]).toBe("CS 1234 Synthetic Course");
  });

  it("refuses to write into a folder whose manifest belongs to another course, and still archives the others", async () => {
    const { files, sink } = disk();
    const [planA, planB] = planCourses([a, input(3, "COURSE_C")], archiveLayout, { 3: "CS 1234 Synthetic Course (2)" });
    // The first plan's folder was written earlier by course 99.
    files.set(`${planA?.dir.join("/")}/.canvas-archive.json`, JSON.stringify(emptyManifest(99)));
    files.set(`${planA?.dir.join("/")}/Pages/Notes.html`, "COURSE_99_DATA");

    const store = folderManifestStore(sink);
    await expect(store.load(planA as never)).rejects.toBeInstanceOf(ForeignCourseError);

    const result = await runArchive([planA, planB] as never, archiveLayout, sink, store);
    expect(files.get(`${planA?.dir.join("/")}/Pages/Notes.html`)).toBe("COURSE_99_DATA");
    expect(result.failed).toBe(1);
    expect(result.saved).toBe(1);
    const failure = result.outcomes.find((o) => o.status === "failed");
    expect(failure && failure.status === "failed" && failure.message).toMatch(/another course's archive/);
    expect(files.get(`${planB?.dir.join("/")}/Pages/Notes.html`)).toContain("COURSE_C");
  });
});

describe("a later feed cannot overwrite an unconsumed batch", () => {
  function memoryStore(): ManifestStore {
    const data = new Map<number, CourseManifest>();
    return { load: async (p) => data.get(p.courseId) ?? emptyManifest(p.courseId), save: async (p, m) => void data.set(p.courseId, structuredClone(m)) };
  }

  it("stages each run under its own folder; the first batch's bytes survive the second run (Anvil probe)", async () => {
    const { files, sink } = disk();
    const store = memoryStore();
    const run = (html: string, at: string) =>
      runArchive(planCourses([input(1, html)], ingestLayout), ingestLayout, sink, store, { now: () => new Date(at) });

    const one = await run("VERSION_ONE", "2026-10-24T02:00:00Z");
    const two = await run("VERSION_TWO", "2026-10-25T02:00:00Z");
    expect(one.batch).not.toBe(two.batch);

    const batchOne = JSON.parse(files.get(`_batches/${one.batch}`) as string);
    const batchTwo = JSON.parse(files.get(`_batches/${two.batch}`) as string);
    const entryOne = batchOne.files[0];
    const entryTwo = batchTwo.files[0];
    expect(entryOne.path).toBe(entryTwo.path); // same destination in the knowledge base
    expect(entryOne.stage).not.toBe(entryTwo.stage); // different bytes on disk
    expect(entryOne.stage).toMatch(/^_staged\/2026-10-24T020000-[0-9a-f]{8}\/cs1234\//);
    expect(files.get(entryOne.stage)).toContain("VERSION_ONE");
    expect(files.get(entryTwo.stage)).toContain("VERSION_TWO");
    expect(hashText(files.get(entryOne.stage) as string)).toBe(entryOne.sha256);
  });

  it("two runs starting in the same UTC second keep separate batches and staged bytes (Anvil T-465 P2)", async () => {
    const { files, sink } = disk();
    const store = memoryStore();
    const at = () => new Date("2026-10-25T02:00:00.100Z");
    const one = await runArchive(planCourses([input(1, "RUN_ONE")], ingestLayout), ingestLayout, sink, store, { now: at });
    const two = await runArchive(planCourses([input(1, "RUN_TWO")], ingestLayout), ingestLayout, sink, store, { now: at });
    expect(one.batch).not.toBe(two.batch);
    expect(one.batch).toMatch(/^2026-10-25T020000-[0-9a-f]{8}\.json$/);
    const entryOne = JSON.parse(files.get(`_batches/${one.batch}`) as string).files[0];
    const entryTwo = JSON.parse(files.get(`_batches/${two.batch}`) as string).files[0];
    expect(entryOne.stage).not.toBe(entryTwo.stage);
    expect(files.get(entryOne.stage)).toContain("RUN_ONE");
    expect(files.get(entryTwo.stage)).toContain("RUN_TWO");
  });

  it("the archive layout is untouched: files go straight to their path, no stage", async () => {
    const { files, sink } = disk();
    const plans = planCourses([input(1, "X")], archiveLayout);
    const result = await runArchive(plans, archiveLayout, sink, memoryStore());
    expect(result.batch).toBeNull();
    expect([...files.keys()].some((p) => p.startsWith("_staged"))).toBe(false);
  });
});

describe("tokens and keys do not outlive the feature", () => {
  const sync = { enabled: false, repo: "me/due", path: "due.json", token: "SYNTHETIC_GITHUB_TOKEN" };

  it("GitHub token: kept while sync is on, gone from storage once it is off (Anvil probe)", async () => {
    const data = stubStorage();
    await saveSettings({ ...sync, enabled: true });
    expect((await loadSettings()).token).toBe("SYNTHETIC_GITHUB_TOKEN");
    await saveSettings(sync);
    expect(JSON.stringify(data)).not.toContain("SYNTHETIC_GITHUB_TOKEN");
    expect((await loadSettings()).token).toBe("");
  });

  it("GitHub token: clearing the field while on removes it too, and a token left by an older version goes on load", async () => {
    const data = stubStorage();
    await saveSettings({ ...sync, enabled: true, token: "" });
    expect(JSON.stringify(data)).not.toContain("TOKEN");
    data["sync.settings"] = { ...sync, enabled: false }; // as written by the earlier version
    expect((await loadSettings()).token).toBe("");
    expect(JSON.stringify(data)).not.toContain("SYNTHETIC_GITHUB_TOKEN");
  });

  it("Anthropic key: kept while on, gone once off, and an old leftover goes on load", async () => {
    const data = stubStorage();
    await saveAi({ enabled: true, apiKey: "SYNTHETIC_AI_KEY", allowContent: true });
    expect((await loadAi()).apiKey).toBe("SYNTHETIC_AI_KEY");
    await saveAi({ enabled: false, apiKey: "SYNTHETIC_AI_KEY", allowContent: false });
    expect(JSON.stringify(data)).not.toContain("SYNTHETIC_AI_KEY");
    data["ai.settings"] = { enabled: false, apiKey: "SYNTHETIC_AI_KEY", allowContent: false };
    expect((await loadAi()).apiKey).toBe("");
    expect(JSON.stringify(data)).not.toContain("SYNTHETIC_AI_KEY");
  });
});
