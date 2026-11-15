import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptConsent, CONSENT_VERSION, DISCLOSURE, hasConsent, isValidConsent, newConsent, revokeConsent } from "@/src/consent/consent";

function stubStorage() {
  const data: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
        set: async (items: Record<string, unknown>) => void Object.assign(data, items),
        remove: async (key: string) => void delete data[key],
      },
    },
  });
  return data;
}

afterEach(() => vi.unstubAllGlobals());

describe("consent record", () => {
  it("accepts only the current version with a real timestamp", () => {
    expect(isValidConsent(newConsent(new Date("2026-10-24T12:00:00Z")))).toBe(true);
    expect(isValidConsent({ version: CONSENT_VERSION + 1, acceptedAt: "2026-10-24T12:00:00Z" })).toBe(false);
    expect(isValidConsent({ version: CONSENT_VERSION, acceptedAt: "not a date" })).toBe(false);
    expect(isValidConsent(null)).toBe(false);
    expect(isValidConsent("yes")).toBe(false);
  });
});

describe("consent storage", () => {
  it("is absent until accepted, present after, absent again after withdrawing", async () => {
    stubStorage();
    expect(await hasConsent()).toBe(false);
    await acceptConsent(new Date("2026-10-24T12:00:00Z"));
    expect(await hasConsent()).toBe(true);
    await revokeConsent();
    expect(await hasConsent()).toBe(false);
  });

  it("treats an out-of-date record as no consent", async () => {
    const data = stubStorage();
    data["consent.v1"] = { version: 0, acceptedAt: "2026-01-01T00:00:00Z" };
    expect(await hasConsent()).toBe(false);
  });

  it("treats a storage failure as no consent", async () => {
    vi.stubGlobal("chrome", { storage: { local: { get: async () => { throw new Error("blocked"); } } } });
    expect(await hasConsent()).toBe(false);
  });
});

describe("disclosure text", () => {
  it("names each service read and says the optional features are off by default", () => {
    const reads = DISCLOSURE.reads.join(" ");
    for (const name of ["Canvas", "Gradescope", "Ed"]) expect(reads).toContain(name);
    expect(DISCLOSURE.optional.every((line) => line.startsWith("Off by default"))).toBe(true);
  });
});
