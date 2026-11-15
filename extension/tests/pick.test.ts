import { describe, expect, it } from "vitest";
import { buildPrompt, parseReply } from "@/src/ai/model";
import {
  candidatesFromPlan, coverageFromSyllabus, leadingNumber, namesExam, namesOtherExam, parseRequest, pickFiles, type Candidate,
} from "@/src/ai/pick";

const c = (id: string, group: string, title: string, modifiedAt: string | null = null): Candidate => ({ id, group, title, modifiedAt });

describe("parseRequest", () => {
  it("reads the exam and ranges", () => {
    expect(parseRequest("get everything for prelim 2").exam).toEqual({ word: "prelim", n: 2 });
    expect(parseRequest("the final").exam).toEqual({ word: "final", n: null });
    expect(parseRequest("Midterm #1 and lectures 4 to 8").ranges).toEqual([{ unit: "lecture", from: 4, to: 8 }]);
    expect(parseRequest("weeks 3-6").ranges).toEqual([{ unit: "week", from: 3, to: 6 }]);
    expect(parseRequest("hello").exam).toBeNull();
  });
});

describe("exam naming", () => {
  const exam = { word: "prelim" as const, n: 2 };
  it("matches the right number only", () => {
    expect(namesExam("Prelim 2 Review", exam)).toBe(true);
    expect(namesExam("prelim2-solutions.pdf", exam)).toBe(true);
    expect(namesExam("Prelim II", exam)).toBe(true);
    expect(namesExam("Prelim 1 Review", exam)).toBe(false);
    expect(namesOtherExam("Prelim 1 Review", exam)).toBe(true);
    expect(namesOtherExam("Prelim 2 Review", exam)).toBe(false);
  });
  it("any mention counts for an unnumbered exam", () => {
    expect(namesExam("Final Exam Info", { word: "final", n: null })).toBe(true);
  });
});

describe("leadingNumber", () => {
  it("finds module and week numbers", () => {
    expect(leadingNumber("05 EM Waves")).toBe(5);
    expect(leadingNumber("Week 3")).toBe(3);
    expect(leadingNumber("lec12-notes.pdf")).toBe(12);
    expect(leadingNumber("Syllabus")).toBe(null);
  });
});

describe("coverageFromSyllabus", () => {
  it("reads what a prelim covers", () => {
    const html = "<p>Prelim 2 covers lectures 10-18.</p><p>Prelim 1 covers lectures 1-9.</p>";
    expect(coverageFromSyllabus(html, { word: "prelim", n: 2 })).toEqual([{ unit: "lecture", from: 10, to: 18 }]);
  });
  it("reads a schedule row", () => {
    const html = "<table><tr><td>Oct 21</td><td>Prelim 2 (weeks 6-9)</td></tr></table>";
    expect(coverageFromSyllabus(html, { word: "prelim", n: 2 })).toEqual([{ unit: "week", from: 6, to: 9 }]);
  });
  it("is empty when the syllabus says nothing", () => {
    expect(coverageFromSyllabus("<p>Prelim 2 is on Oct 21.</p>", { word: "prelim", n: 2 })).toEqual([]);
  });
});

describe("pickFiles", () => {
  const files = [
    c("a", "05 Prelim 2 Review", "review.pdf"),
    c("b", "06 EM Waves", "prelim2-practice.pdf"),
    c("c", "03 Circuits", "prelim1-solutions.pdf"),
    c("d", "07 Optics", "lec07.pdf"),
    c("e", "", "syllabus.html"),
  ];
  it("picks by exam name in folder and file name, drops other exams", () => {
    const r = pickFiles({ request: "everything for prelim 2", candidates: files });
    expect(r.picked.map((p) => p.id)).toEqual(["a", "b"]);
    expect(r.needsModel).toBe(false);
    expect(r.picked[0]?.reasons[0]).toMatch(/named for the exam/);
  });
  it("uses syllabus coverage ranges for module folders", () => {
    const r = pickFiles({
      request: "prelim 2",
      candidates: [c("x", "06 EM Waves", "lec06.pdf"), c("y", "07 Optics", "lec07.pdf"), c("z", "02 Intro", "lec02.pdf")],
      syllabusRanges: [{ unit: "module", from: 6, to: 8 }],
    });
    expect(r.picked.map((p) => p.id).sort()).toEqual(["x", "y"]);
    expect(r.picked[0]?.reasons.join(" ")).toMatch(/syllabus/);
  });
  it("asks for the model when nothing is solid, and dates alone never pick", () => {
    const r = pickFiles({
      request: "prelim 2",
      candidates: [c("x", "Stuff", "notes.pdf", "2026-10-10T00:00:00Z")],
      window: { after: "2026-09-30T00:00:00Z", until: "2026-10-21T00:00:00Z" },
    });
    expect(r.picked).toEqual([]);
    expect(r.needsModel).toBe(true);
  });
  it("handles a direct range request", () => {
    const r = pickFiles({ request: "weeks 2-3", candidates: [c("w2", "Week 2", "slides.pdf"), c("w5", "Week 5", "slides.pdf")] });
    expect(r.picked.map((p) => p.id)).toEqual(["w2"]);
  });
});

describe("candidatesFromPlan", () => {
  it("uses the folder under the course as the group", () => {
    const plan = {
      dir: ["Cornell", "ECE 3030"],
      items: [
        { source: "canvas:file/1", courseId: 1, path: ["Cornell", "ECE 3030", "05 EM Waves", "lec05.pdf"], size: 1, modifiedAt: null, url: "x", content: null },
        { source: "canvas:page/a", courseId: 1, path: ["Cornell", "ECE 3030", "Pages", "a.html"], size: 1, modifiedAt: null, url: null, content: "" },
      ],
    };
    expect(candidatesFromPlan(plan).map((x) => [x.group, x.title])).toEqual([["05 EM Waves", "lec05.pdf"], ["", "a.html"]]);
  });
});

describe("model prompt and reply", () => {
  const cands = [c("canvas:file/1", "05 EM", "lec05.pdf", "2026-10-01T00:00:00Z"), c("canvas:file/2", "", "hw.pdf")];
  it("sends names by index, no ids or urls", () => {
    const p = buildPrompt({ request: "prelim 2", course: "ECE 3030", exams: ["Prelim 2: 2026-10-21"] }, cands);
    expect(p).toContain("0\t05 EM\tlec05.pdf\t2026-10-01");
    expect(p).not.toContain("canvas:file");
  });
  it("keeps only valid unique indexes from a fenced reply", () => {
    const reply = '```json\n{"picks":[{"i":1,"why":"homework"},{"i":1},{"i":9},{"i":"0"},{"i":0}]}\n```';
    expect(parseReply(reply, cands)).toEqual([{ id: "canvas:file/2", reason: "homework" }, { id: "canvas:file/1", reason: "chosen by the model" }]);
  });
  it("returns nothing for junk", () => {
    expect(parseReply("sorry", cands)).toEqual([]);
    expect(parseReply('{"picks":"x"}', cands)).toEqual([]);
  });
});
