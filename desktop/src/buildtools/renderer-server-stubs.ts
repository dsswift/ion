/**
 * `RENDERER_SERVER_STUBS` and the Vite plugin that swaps them in — shared
 * between the Electron renderer build (`electron.vite.config.ts`) and the
 * browser web build (`vite.web.config.ts`, spec 18). Both renderer targets
 * import the server session store directly for its reactive selectors,
 * which transitively reaches real Node-only server infrastructure (sockets,
 * `execFileSync`, real fs paths) that neither a `<script type="module">` in
 * Electron's sandboxed renderer nor a genuine browser tab can run. Extracted
 * out of `electron.vite.config.ts` so the web config does not fork a second
 * copy of the stub list and silently drift from it.
 */
import { resolve } from "path";
import type { Plugin } from "vite";

/**
 * Files under server/src/ that construct real Node infrastructure at module
 * scope and are unconditionally reachable from every renderer file that
 * imports the session store for its reactive selectors (spec 17: Studio
 * renders against the server-owned store). See each stub's own docstring for
 * why the swap is architecturally correct, not just a build workaround.
 */
export function rendererServerStubs(desktopDir: string): ReadonlyArray<readonly [string, string]> {
  return [
    [
      resolve(desktopDir, "../server/src/logger.ts"),
      resolve(desktopDir, "src/buildtools/server-logger-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/state.ts"),
      resolve(desktopDir, "src/buildtools/server-state-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/store/host-api-git.ts"),
      resolve(desktopDir, "src/buildtools/server-host-api-git-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/store/host-api-misc.ts"),
      resolve(desktopDir, "src/buildtools/server-host-api-misc-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/store/host-api-project.ts"),
      resolve(desktopDir, "src/buildtools/server-host-api-project-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/utils/atomicWrite.ts"),
      resolve(desktopDir, "src/buildtools/server-atomic-write-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/utils/secretStore.ts"),
      resolve(desktopDir, "src/buildtools/server-secret-store-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/config/server-config.ts"),
      resolve(desktopDir, "src/buildtools/server-config-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/persistence/settings-store.ts"),
      resolve(desktopDir, "src/buildtools/server-settings-store-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/persistence/effective-settings.ts"),
      resolve(
        desktopDir,
        "src/buildtools/server-effective-settings-browser-stub.ts",
      ),
    ],
    [
      resolve(desktopDir, "../server/src/questions/questions-wiring.ts"),
      resolve(desktopDir, "src/buildtools/server-questions-wiring-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/persistence/chart-resource-store.ts"),
      resolve(desktopDir, "src/buildtools/server-chart-resource-store-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/explorer-state-store.ts"),
      resolve(desktopDir, "src/buildtools/server-explorer-state-store-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/protocol/tabs-index.ts"),
      resolve(desktopDir, "src/buildtools/server-tabs-index-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/store/host-api-engine.ts"),
      resolve(desktopDir, "src/buildtools/server-host-api-engine-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/identity/request-principal.ts"),
      resolve(desktopDir, "src/buildtools/server-request-principal-browser-stub.ts"),
    ],
    [
      resolve(desktopDir, "../server/src/tracing/op-span.ts"),
      resolve(desktopDir, "src/buildtools/server-op-span-browser-stub.ts"),
    ],
  ];
}

/**
 * Whether two absolute paths name the same module file.
 *
 * Vite normalizes every resolved module id to forward slashes on every
 * platform, while `path.resolve` answers with backslashes on Windows. A
 * plain `===` between the two therefore never matched there: every renderer
 * build on Windows bundled the real server files (`AsyncLocalStorage` from
 * `request-principal.ts`, chokidar's `os` import) and failed, and the main
 * bundle kept the real server logger and filed desktop-main lines under
 * `server.jsonl`. Both sides are compared in Vite's own form.
 */
export function sameModulePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}

/**
 * A plugin resolves each import normally, then swaps in the matching stub
 * whenever the result is exactly one of `rendererServerStubs`' listed
 * files, regardless of how the importer spelled the relative path (Vite
 * matches alias keys against the import specifier text as written, not the
 * resolved absolute path, so a plain `resolve.alias` entry cannot do this).
 */
export function serverBrowserStubsPlugin(desktopDir: string): Plugin {
  const stubs = rendererServerStubs(desktopDir);
  return {
    name: "ion:server-browser-stubs",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith("\0")) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (!resolved) return null;
      const stub = stubs.find(([realPath]) => sameModulePath(realPath, resolved.id));
      return stub ? stub[1] : null;
    },
  };
}

/**
 * The main bundle's one swap: `server/src/logger.ts` for
 * `main/server-logger-adapter.ts`.
 *
 * Unlike the renderer stubs above, this is not about what Node APIs a target
 * can run -- desktop main runs all of them. It is about which FILE the lines
 * land in. Desktop main executes a large amount of `@ion/server` code in its
 * own process, and the real server logger writes `server.jsonl` stamped
 * `component: 'server'`, so this process's lines were filed against the
 * server. The adapter routes them to `main/logger.ts` instead. See its
 * docstring for the full reasoning.
 */
export function mainServerLoggerPlugin(desktopDir: string): Plugin {
  const realLogger = resolve(desktopDir, "../server/src/logger.ts");
  const adapter = resolve(desktopDir, "src/main/server-logger-adapter.ts");
  return {
    name: "ion:main-server-logger",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith("\0")) return null;
      // The adapter imports the desktop logger, never the server one, so it
      // cannot recurse into itself; guard anyway so a future edit cannot.
      if (sameModulePath(importer, adapter)) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (!resolved) return null;
      return sameModulePath(resolved.id, realLogger) ? adapter : null;
    },
  };
}
