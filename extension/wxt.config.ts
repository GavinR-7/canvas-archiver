import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
import { hostPermissions } from "./src/config/canvas";

/**
 * WXT generates `manifest.json` from this object plus the files in
 * `entrypoints/`. The generated result is readable at
 * `.output/chrome-mv3/manifest.json` — worth looking at while learning MV3,
 * since it is the file Chrome actually reads.
 */
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: "Canvas Archiver",
    description:
      "See everything due across your Canvas courses. Local-first: no account, no backend, nothing leaves your browser.",
    // `storage` is the only capability API needed so far. Note what is absent:
    // no `tabs`, no `<all_urls>`, no `webRequest`.
    permissions: ["storage"],
    host_permissions: hostPermissions,
    action: {
      default_title: "Canvas Archiver",
    },
  },
});
