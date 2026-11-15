import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkDoc, buildIndex, type Doc } from "@/src/chat/retrieve";
import { chatMode, findPassages, markDates } from "@/src/chat/find";
import { DEFAULT_AI } from "@/src/ai/model";

const docs: Doc[] = [
  { source: "canvas:syllabus/1", path: "Pages/Syllabus.html", html: "<h2>Exams</h2><p>Prelim 2 is on Tuesday, Oct 28 at 7:30 PM in Phillips 101.</p><h2>Grading</h2><p>Homework counts 30 percent.</p>" },
  { source: "canvas:page/em", path: "Pages/EM Waves.html", html: "<h2>Skin depth</h2><p>Skin depth falls as frequency rises.</p>" },
];
const index = buildIndex(docs.flatMap(chunkDoc));

afterEach(() => vi.unstubAllGlobals());

describe("markDates", () => {
  it("bolds month-day, numeric dates, weekdays and times, and loses no text", () => {
    const text = "Due Oct 28, 2026 or 10/30 by 11:59 PM; see Friday.";
    const segs = markDates(text);
    expect(segs.map((s) => s.text).join("")).toBe(text);
    expect(segs.filter((s) => s.date).map((s) => s.text)).toEqual(["Oct 28, 2026", "10/30", "11:59 PM", "Friday"]);
  });
  it("leaves text without dates alone", () => {
    expect(markDates("Skin depth falls.")).toEqual([{ text: "Skin depth falls.", date: false }]);
  });
});

describe("find mode", () => {
  it("is used unless the key and both opt-ins are on", () => {
    expect(chatMode(DEFAULT_AI)).toBe("find");
    expect(chatMode({ ...DEFAULT_AI, enabled: true, apiKey: "k" })).toBe("find");
    expect(chatMode({ ...DEFAULT_AI, enabled: true, apiKey: "k", allowContent: true })).toBe("ai");
  });

  it("returns passages with citations and bolded dates, with zero network calls", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const found = findPassages(index, "when is prelim 2", "ECE 3030");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.label).toMatch(/^\[ECE 3030 · Pages\/Syllabus\.html/);
    expect(found[0]!.segments.some((s) => s.date && s.text.includes("Oct 28"))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns nothing when no passage matches", () => {
    expect(findPassages(index, "zzzqqq", "ECE 3030")).toEqual([]);
  });
});
