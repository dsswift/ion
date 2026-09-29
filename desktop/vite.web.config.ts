/**
 * Vite config for the browser Studio client (spec 18): builds `web.html` +
 * `web-main.tsx` — the SAME renderer source tree `electron.vite.config.ts`
 * builds for the Electron Studio window, just a different entry point and a
 * different `StudioHost` (`host-instance.ts` picks `BrowserStudioHost` at
 * runtime because `window.ion` is never defined in a real browser tab).
 *
 * Output goes to `server/web/` (child 11 serves it behind `web.enabled`),
 * pre-compressed with Brotli and gzip siblings for every hashed asset — the
 * server's static route (`server/src/http/static.ts`) picks whichever
 * encoding the request's `Accept-Encoding` header allows, favoring Brotli.
 *
 * `npm -w desktop run build:web` runs this directly with `vite build
 * --config vite.web.config.ts` — it is NOT part of `electron-vite build`
 * (which only knows the `main`/`preload`/`renderer` triad and has no config
 * shape for a fourth, non-Electron target).
 */
import { resolve } from "path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import viteCompression from "vite-plugin-compression";
import { serverBrowserStubsPlugin } from "./src/buildtools/renderer-server-stubs";

/**
 * Rollup names an HTML entry's emitted file after the entry's own basename —
 * `web.html` in, `web.html` out. `static.ts` hardcodes `index.html` as both
 * the root document and the SPA fallback (matching every other static-SPA
 * host's default), so the entry keeps its spec-18 name on disk
 * (`src/renderer/web.html`, alongside `studio.html`/`splash.html`) and this
 * plugin renames only the OUTPUT artifact — not a source rename, since the
 * source name is what spec 18's Relevant Files table and the sibling
 * Electron entries both expect.
 */
function renameEntryHtml(from: string, to: string): Plugin {
  return {
    name: "ion:rename-entry-html",
    // Vite's own core HTML-emitting plugin runs in the "post" enforce tier;
    // without this, this plugin's `generateBundle` runs first and the HTML
    // asset does not exist in `bundle` yet, so the rename silently no-ops.
    enforce: "post",
    generateBundle(_options, bundle) {
      const asset = bundle[from];
      if (!asset) return;
      delete bundle[from];
      asset.fileName = to;
      bundle[to] = asset;
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  plugins: [
    react(),
    tailwindcss(),
    serverBrowserStubsPlugin(__dirname),
    renameEntryHtml("web.html", "index.html"),
    // Brotli first: the static route prefers it when the request's
    // Accept-Encoding allows it (spec 18 acceptance: `curl` with
    // `Accept-Encoding: br` gets a `.br` sibling back). `threshold: 0`
    // overrides the plugin's 1025-byte default, which would otherwise skip
    // `index.html` itself (592 bytes) — exactly the file the acceptance
    // `curl` request hits at `/`.
    viteCompression({ algorithm: "brotliCompress", ext: ".br", threshold: 0 }),
    viteCompression({ algorithm: "gzip", ext: ".gz", threshold: 0 }),
  ],
  // Same worker-dependency carve-out as electron.vite.config.ts's renderer
  // block: the dev server's dependency scanner does not crawl into
  // `new Worker(new URL())` entries (studio/graph/graph-layout.worker.ts),
  // so those deps are named here or the worker's first import 404s in dev.
  optimizeDeps: {
    include: [
      "graphology-layout-forceatlas2/iterate",
      "graphology-layout-forceatlas2/defaults",
      "graphology-layout-forceatlas2/helpers",
    ],
  },
  build: {
    outDir: resolve(__dirname, "../server/web"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        web: resolve(__dirname, "src/renderer/web.html"),
      },
    },
  },
});
