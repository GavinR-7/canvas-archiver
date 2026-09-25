import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Tests cover the pure logic only — term parsing, Link-header parsing, status
 * derivation, normalisation. Network code is not chased for coverage; that is
 * what the auth spike and a real Canvas account are for.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
