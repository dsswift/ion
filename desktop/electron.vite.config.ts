import { execFileSync } from "child_process";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import { defineConfig } from "electron-vite";
import { build as viteBuild, type Plugin, type ResolvedConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { assertSelfContainedPreloads } from "./src/buildtools/preload-bundle-guard";
import {
  WORKSPACE_SOURCE_PACKAGES,
  assertNoWorkspaceSourceLoads,
  type EmittedBundleFile,
} from "./src/buildtools/workspace-bundle-guard";
import { serverBrowserStubsPlugin, mainServerLoggerPlugin } from "./src/buildtools/renderer-server-stubs";

function localDevelopmentVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../release-please-manifest.json"), "utf8")) as { desktop: string };
  const [major, minor] = manifest.desktop.split(".").map(Number);
  const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: __dirname, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: __dirname, encoding: "utf8" }).trim();
  return `${major}.${minor + 1}.0-dev.${sha}${dirty ? ".dirty" : ""}`;
}

const desktopVersion = process.env.ION_DESKTOP_VERSION || localDevelopmentVersion();

/**
 * Every emitted JavaScript artifact under an out dir, with its source text,
 * for the build guards that scan bundle output.
 */
function emittedBundleFiles(outDir: string): EmittedBundleFile[] {
  return readdirSync(outDir, { recursive: true, withFileTypes: true })
    .filter((dirent) => dirent.isFile() && /\.(js|mjs|cjs)$/.test(dirent.name))
    .map((dirent) => {
      const full = join(dirent.parentPath, dirent.name);
      return { file: relative(outDir, full), code: readFileSync(full, "utf8") };
    });
}

/**
 * Runtime dependencies that must be inlined rather than left external.
 *
 * `zustand`: the server-owned stores call `create` from zustand's root entry,
 * because the Studio renderer consumes the very same stores as React hooks.
 * That root entry requires `react`, which is a renderer-only devDependency and
 * is never packaged, so an external `require("zustand")` in the main bundle
 * dies at launch with "Cannot find module 'react'". Inlining zustand lets
 * rollup bundle the react binding it reaches for, at build time, from the
 * workspace's node_modules.
 */
const INLINED_RUNTIME_DEPS: readonly string[] = ["zustand"];

/**
 * Workspace packages that exist only as TypeScript source (`@ion/server`,
 * `@ion/shared`) must be bundled into the main and preload artifacts.
 * electron-vite externalizes every `dependencies` entry by default, and both
 * are dependencies so npm links them, so without this exclusion the emitted
 * bundle keeps `require("@ion/server/state")` and the packaged app resolves
 * that to a `.ts` file it cannot load: the main process dies on
 * `SyntaxError: Unexpected token ':'` before its first log line, and a
 * sandboxed preload cannot require it at all. The guard below fails the build
 * if any emitted artifact still carries such a load.
 */
const externalizeDeps = {
  exclude: [...WORKSPACE_SOURCE_PACKAGES, ...INLINED_RUNTIME_DEPS],
};

/** Fails the main build if an emitted artifact loads a workspace package at runtime. */
function workspaceBundleGuard(): Plugin {
  let outDir: string;
  return {
    name: "ion:workspace-bundle-guard",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      assertNoWorkspaceSourceLoads(emittedBundleFiles(outDir));
    },
  };
}

/**
 * Builds one extra preload entry as its own single-entry bundle, then asserts
 * every emitted preload artifact is self-contained.
 *
 * A sandboxed preload cannot `require` a sibling file, so preload artifacts
 * must have no cross-file loads at all. Rollup guarantees the opposite as soon
 * as one build has two entries that share a module: the shared module is
 * hoisted into `chunks/` and both entries require it. That is what broke the
 * splash release — `index.js` and `splash.js` both required
 * `./chunks/types-ipc-*.js`, neither preload loaded, so the main window's
 * `window.ionapi` was undefined (`Cannot read properties of undefined (reading
 * 'saveTabs')`) and the splash window painted nothing while still capturing
 * clicks.
 *
 * The fix is structural rather than a rule about what preloads may import:
 * each entry gets its own build, so shared source is duplicated into each
 * bundle and no chunk can ever be emitted. Build options are inherited from
 * the parent preload config (electron-vite's resolved node target, externals,
 * minify, defines) so this stays faithful to the preset rather than restating
 * it.
 */
function selfContainedPreloadEntry(name: string, entry: string): Plugin {
  let parent: ResolvedConfig;
  let started = false;
  return {
    name: "ion:self-contained-preload-entry",
    apply: "build",
    configResolved(config) {
      parent = config;
    },
    async closeBundle() {
      // In watch mode the child build watches its own graph, so it is started
      // once and left running; re-invoking per parent rebuild would stack
      // watchers.
      if (started) return;
      started = true;
      const outDir = parent.build.outDir;
      await viteBuild({
        configFile: false,
        root: parent.root,
        mode: parent.mode,
        define: parent.define,
        logLevel: parent.logLevel,
        ssr: { noExternal: true },
        build: {
          ssr: true,
          target: parent.build.target,
          outDir,
          emptyOutDir: false,
          minify: parent.build.minify,
          sourcemap: parent.build.sourcemap,
          reportCompressedSize: false,
          watch: parent.build.watch ? {} : null,
          // Single-entry lib build: rollup has nothing to hoist a shared
          // module into, so the bundle is self-contained by construction.
          lib: { entry, formats: ["cjs"], fileName: () => `${name}.js` },
          rollupOptions: {
            external: parent.build.rollupOptions.external,
          },
        },
      });
      if (parent.build.watch) return;
      const files = emittedBundleFiles(outDir);
      assertSelfContainedPreloads(files);
      assertNoWorkspaceSourceLoads(files);
    },
  };
}

export default defineConfig({
  main: {
    define: {
      __ION_DESKTOP_VERSION__: JSON.stringify(desktopVersion),
    },
    plugins: [mainServerLoggerPlugin(__dirname), workspaceBundleGuard()],
    build: {
      outDir: "dist/main",
      externalizeDeps,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
        },
      },
    },
  },
  preload: {
    // One entry per build — see selfContainedPreloadEntry. Adding a second
    // entry here would reintroduce shared `chunks/` that no sandboxed preload
    // can load; the guard fails the build if that happens.
    plugins: [
      selfContainedPreloadEntry(
        "splash",
        resolve(__dirname, "src/preload/splash.ts"),
      ),
    ],
    build: {
      outDir: "dist/preload",
      externalizeDeps,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    // The Studio renderer imports the server session store directly for its
    // reactive selectors, which transitively reaches real Node-only server
    // infrastructure. `serverBrowserStubsPlugin` (shared with
    // `vite.web.config.ts`, spec 18) resolves each import normally, then
    // swaps in the matching stub whenever the result is exactly one of the
    // listed server files, regardless of how the importer spelled the
    // relative path — a plain `resolve.alias` entry can't do this, because
    // Vite matches alias keys against the import specifier text as written
    // ('./logger', '../logger', '../../logger' depending on the importing
    // file's depth), not the resolved absolute path.
    plugins: [react(), tailwindcss(), serverBrowserStubsPlugin(__dirname)],
    // The graph layout worker (studio/graph/graph-layout.worker.ts) is a
    // module worker that imports ForceAtlas2's CommonJS internals. The dev
    // server's dependency scanner does not crawl into `new Worker(new URL())`
    // entries, so those deps are named here or the worker's first import
    // 404s in dev while the production bundle is fine.
    optimizeDeps: {
      include: [
        "graphology-layout-forceatlas2/iterate",
        "graphology-layout-forceatlas2/defaults",
        "graphology-layout-forceatlas2/helpers",
      ],
    },
    build: {
      outDir: resolve(__dirname, "dist/renderer"),
      rollupOptions: {
        input: {
          studio: resolve(__dirname, "src/renderer/studio.html"),
          splash: resolve(__dirname, "src/renderer/splash.html"),
          "worktree-overlap": resolve(
            __dirname,
            "src/renderer/worktree-overlap.html",
          ),
        },
      },
    },
  },
});
