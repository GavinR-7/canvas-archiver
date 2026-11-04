import { describe, expect, it } from "vitest";
import { buildUser, citationsIn } from "@/src/chat/prompt";
import { buildIndex, chunkDoc, search, tokenize, type Doc } from "@/src/chat/retrieve";

const docs: Doc[] = [
  { source: "canvas:page/em", path: "Pages/EM Waves.html", html: "<h2>Skin depth</h2><p>The skin depth in a lossy conductor is the distance over which the field decays by 1/e.</p><h2>Poynting vector</h2><p>The Poynting vector gives power flow per unit area.</p>" },
  { source: "canvas:page/circuits", path: "Pages/Circuits.html", html: "<h2>Thevenin equivalents</h2><p>Replace a linear network by a voltage source and series resistance.</p>" },
  { source: "canvas:syllabus/1", path: "Syllabus/Syllabus.html", html: "<p>Prelim 2 covers waves and optics.</p><p>Office hours are Tuesdays.</p>" },
];
const index = buildIndex(docs.flatMap(chunkDoc));

describe("chunkDoc", () => {
  it("keeps the nearest heading as the section", () => {
    const chunks = chunkDoc(docs[0] as Doc);
    expect(chunks.map((c) => c.section)).toEqual(["Skin depth", "Poynting vector"]);
    expect(chunks[0]?.text).toContain("decays by 1/e");
  });
  it("splits long text", () => {
    const long: Doc = { source: "s", path: "p", html: Array.from({ length: 40 }, (_, i) => `<p>Sentence number ${i} about nothing in particular, padded out a bit.</p>`).join("") };
    expect(chunkDoc(long).length).toBeGreaterThan(2);
  });
});

describe("tokenize", () => {
  it("drops stop words and folds plurals", () => {
    expect(tokenize("What are the Poynting vectors?")).toEqual(["poynting", "vector"]);
  });
});

describe("search", () => {
  it("ranks the relevant passage first", () => {
    expect(search(index, "explain skin depth")[0]?.chunk.path).toBe("Pages/EM Waves.html");
    expect(search(index, "thevenin")[0]?.chunk.path).toBe("Pages/Circuits.html");
  });
  it("finds by page title and returns nothing for unrelated words", () => {
    expect(search(index, "syllabus prelim")[0]?.chunk.source).toBe("canvas:syllabus/1");
    expect(search(index, "quantum chromodynamics")).toEqual([]);
  });
});

describe("citations", () => {
  const hits = search(index, "skin depth poynting", 2);
  it("maps numbers to README-form labels and flags invented ones", () => {
    const answer = "Skin depth is where the field decays by 1/e [1]. Power flow is the Poynting vector [2, 7]. Also [1].";
    const { cited, invalid } = citationsIn(answer, "ECE 3030", hits);
    expect(cited.map((c) => c.n)).toEqual([1, 2]);
    expect(cited[0]?.label).toMatch(/^\[ECE 3030 · Pages\/EM Waves\.html §/);
    expect(invalid).toEqual([7]);
  });
  it("numbers passages from 1 in the prompt", () => {
    const text = buildUser("ECE 3030", "q", hits);
    expect(text).toContain("[1] (Pages/EM Waves.html §");
    expect(text).toContain("Question: q");
  });
});
