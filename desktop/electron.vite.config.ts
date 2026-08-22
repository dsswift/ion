import { execFileSync } from "child_process";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import { defineConfig } from "electron-vite";
import { build as viteBuild, type Plugin, type ResolvedConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { assertSelfContainedPreloads } from "./src/buildtools/preload-bundle-guard";

function localDevelopmentVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../release-please-manifest.json"), "utf8")) as { desktop: string };
  const [major, minor] = manifest.desktop.split(".").map(Number);
  const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: __dirname, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: __dirname, encoding: "utf8" }).trim();
  return `${major}.${minor + 1}.0-dev.${sha}${dirty ? ".dirty" : ""}`;
}

const desktopVersion = process.env.ION_DESKTOP_VERSION || localDevelopmentVersion();

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
      const files = readdirSync(outDir, {
        recursive: true,
        withFileTypes: true,
      })
        .filter(
          (dirent) => dirent.isFile() && /\.(js|mjs|cjs)$/.test(dirent.name),
        )
        .map((dirent) => {
          const full = join(dirent.parentPath, dirent.name);
          return {
            file: relative(outDir, full),
            code: readFileSync(full, "utf8"),
          };
        });
      assertSelfContainedPreloads(files);
    },
  };
}

export default defineConfig({
  main: {
    define: {
      __ION_DESKTOP_VERSION__: JSON.stringify(desktopVersion),
    },
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          // Transport crypto worker: a worker_threads entry spawned by
          // transport-send-worker-host.ts via join(__dirname, ...). Emitted as
          // its own chunk next to the main bundle so the path resolves in both
          // dev and packaged builds.
          "transport-crypto-worker": resolve(
            __dirname,
            "src/main/remote/transport-crypto-worker.ts",
          ),
        },
        output: {
          // Keep entry names stable (no hash) — the host resolves the worker
          // artifact by filename at runtime.
          entryFileNames: "[name].js",
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
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve(__dirname, "dist/renderer"),
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
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
