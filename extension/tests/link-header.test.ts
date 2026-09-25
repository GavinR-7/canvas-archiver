import { describe, expect, it } from "vitest";
import { parseLinkHeader } from "@/src/canvas/link-header";

describe("parseLinkHeader", () => {
  it("extracts every rel from a real Canvas header", () => {
    const header =
      '<https://x/api/v1/courses?page=1&per_page=100>; rel="current",' +
      '<https://x/api/v1/courses?page=2&per_page=100>; rel="next",' +
      '<https://x/api/v1/courses?page=1&per_page=100>; rel="first",' +
      '<https://x/api/v1/courses?page=9&per_page=100>; rel="last"';

    const links = parseLinkHeader(header);

    expect(links.next).toBe("https://x/api/v1/courses?page=2&per_page=100");
    expect(Object.keys(links).sort()).toEqual(["current", "first", "last", "next"]);
  });

  it("returns nothing on the last page, which is how iteration stops", () => {
    const links = parseLinkHeader('<https://x/api/v1/courses?page=9>; rel="last"');
    expect(links.next).toBeUndefined();
  });

  it.each([null, "", "garbage", "<no-rel-here>"])("survives junk: %s", (header) => {
    expect(parseLinkHeader(header)).toEqual({});
  });

  it("is case-insensitive on rel", () => {
    expect(parseLinkHeader('<https://x/2>; rel="NEXT"')).toEqual({ next: "https://x/2" });
  });

  it("does not leak regex state between calls", () => {
    // A module-level global regex would give a different answer the second
    // time, because lastIndex would carry over.
    const header = '<https://x/2>; rel="next"';
    expect(parseLinkHeader(header)).toEqual(parseLinkHeader(header));
  });
});
