import { describe, expect, it } from "vitest";
import { assertCanvasOrigin, CredentialScopeError } from "@/src/canvas/url-guard";

const CANVAS = "https://canvas.cornell.edu";

describe("assertCanvasOrigin", () => {
  it.each([
    "https://canvas.cornell.edu/api/v1/users/self",
    "https://canvas.cornell.edu:443/api/v1/users/self", // explicit default port
    "https://CANVAS.CORNELL.EDU/api/v1/users/self", // DNS is case-insensitive
    "https://canvas.cornell.edu/api/v1/courses?page=2&per_page=100",
  ])("accepts the configured host: %s", (url) => {
    expect(assertCanvasOrigin(url, CANVAS)).toBe(url);
  });

  it.each([
    ["https://evil.example.com/api/v1/users/self", "a different host"],
    ["https://canvas.cornell.edu.evil.com/api/v1", "a suffix-matching host"],
    ["https://evil.canvas.cornell.edu/api/v1", "a subdomain"],
    ["https://canvas.cornell.edu:8443/api/v1", "a different port"],
    ["http://canvas.cornell.edu/api/v1", "plain HTTP"],
    ["not-a-url", "a malformed URL"],
  ])("refuses %s (%s)", (url) => {
    expect(() => assertCanvasOrigin(url, CANVAS)).toThrow(CredentialScopeError);
  });

  it("rejects subdomains, because a parent-domain cookie would reach them", () => {
    expect(() => assertCanvasOrigin("https://evil.canvas.cornell.edu/api", CANVAS))
      .toThrow(/Refusing to send Canvas credentials/);
  });

  it("allows plain HTTP on loopback so tests can use a local stub", () => {
    const base = "http://localhost:8080";
    expect(assertCanvasOrigin(`${base}/api/v1/users/self`, base)).toBeTruthy();
  });

  it("does not turn the loopback exemption into a global allow-http switch", () => {
    expect(() => assertCanvasOrigin("http://canvas.cornell.edu/api", "http://localhost:8080"))
      .toThrow(/Refusing to send credentials over http/);
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"])(
    "refuses the non-HTTP scheme %s", (url) => {
      expect(() => assertCanvasOrigin(url, CANVAS)).toThrow(CredentialScopeError);
    },
  );
});
