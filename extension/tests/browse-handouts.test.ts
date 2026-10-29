import { describe, expect, it, vi } from "vitest";
import { buildTree, itemsUnder, savedSources, subsetPlan } from "@/src/files/browse";
import { emptyManifest } from "@/src/files/manifest";
import { planCourse } from "@/src/files/plan";
import { handoutsFor, listGradescopeFiles, type GradescopeListing } from "@/src/gradescope/files";

const canvas = [
  { id: 7, name: "Network Systems", courseCode: "CS 3700" },
  { id: 8, name: "Fields", courseCode: "ECE 3030" },
];
const listing: GradescopeListing = {
  errors: [],
  courses: [
    { course: { id: 90, shortName: "CS 3700", name: "Networks", termCode: "FA26" } as never, files: [{ source: "gradescope:file/3/a", gradescopeCourseId: 90, assignmentId: 3, assignmentTitle: "HW1", filename: "HW1.pdf", url: "https://www.gradescope.com/courses/90/assignments/3/files/HW1.pdf" }] },
    { course: { id: 91, shortName: "PE 1300", name: "Bowling", termCode: "FA26" } as never, files: [{ source: "gradescope:file/4/a", gradescopeCourseId: 91, assignmentId: 4, assignmentTitle: "X", filename: "X.pdf", url: "https://www.gradescope.com/courses/91/assignments/4/files/X.pdf" }] },
  ],
};
const plan = () => planCourse(canvas[0] as never, { modules: [], files: [], folders: [], documents: [], external: handoutsFor(listing, canvas[0] as never, canvas) });

describe("Gradescope handouts in the course browser", () => {
  it("picks only the handouts of the Gradescope class that matches this Canvas course", () => {
    expect(handoutsFor(listing, canvas[0] as never, canvas).map((f) => f.source)).toEqual(["gradescope:file/3/a"]);
    expect(handoutsFor(listing, canvas[1] as never, canvas)).toEqual([]);
  });
  it("shows them in a Gradescope folder that ticking and subsetting treats like any file", () => {
    const tree = buildTree(plan());
    expect(tree.folders.map((f) => f.name)).toEqual(["Gradescope"]);
    const item = itemsUnder(tree)[0]!;
    expect(item).toMatchObject({ session: "gradescope", source: "gradescope:file/3/a" });
    expect(subsetPlan(plan(), new Set([item.source])).items).toHaveLength(1);
  });
  it("marks a handout already saved at its path, so a re-run skips it after the host check", () => {
    const p = plan();
    const item = p.items[0]!;
    const manifest = emptyManifest(7);
    manifest.entries[item.source] = { path: item.path, size: 5, modifiedAt: null, sha256: "x", method: "fetch-session" } as never;
    expect([...savedSources(p, manifest)]).toEqual([item.source]);
    expect([...savedSources(p, emptyManifest(7))]).toEqual([]);
  });
  it("one failing page does not stop the listing", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/courses/90") throw new Error("boom");
      return "";
    });
    const out = await listGradescopeFiles([{ id: 90, shortName: "CS 3700", name: "N", termCode: "FA26" } as never], get);
    expect(out.errors[0]).toMatch(/boom/);
  });
});
