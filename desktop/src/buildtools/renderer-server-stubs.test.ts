/**
 * Regression coverage for the browser web build (spec 18) pulling in a
 * Node-only server file that isn't listed in `rendererServerStubs()`.
 *
 * Two `server/src/config/*.ts` files (`secret-ref.ts`, `server-config.ts`)
 * reach `fs`/`os`/`path` at module scope and are transitively reachable from
 * `server/src/store/sessionStore.ts` (the module every Studio renderer file
 * imports for its reactive selectors), but were never added to the stub
 * table. `vite build --config vite.web.config.ts` (`npm -w desktop run
 * build:web`) failed with `"<builtin fn>" is not exported by
 * "__vite-browser-external"` the first time that build was actually run
 * against them.
 *
 * This test walks the real `server/src` import graph from `sessionStore.ts`,
 * the same way Vite's bundler does, and fails on any file that (a) is
 * reachable, (b) is not swapped for a browser stub, and (c) imports a Node
 * builtin at module scope — pinning the whole defect class, not just the
 * two files that tripped it this time.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { rendererServerStubs, mainServerLoggerPlugin, sameModulePath, serverBrowserStubsPlugin } from "./renderer-server-stubs";

const SERVER_SRC = resolve(__dirname, "../../../server/src");
const ENTRY = resolve(SERVER_SRC, "store/sessionStore.ts");

/** Node built-in modules unavailable to a browser-target Rollup bundle. */
const NODE_BUILTINS = new Set([
  "fs",
  "path",
  "os",
  "net",
  "tls",
  "dgram",
  "dns",
  "http",
  "https",
  "http2",
  "child_process",
  "cluster",
  "worker_threads",
  "v8",
  "vm",
  "readline",
  "repl",
  "zlib",
  "crypto",
]);

const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

function isNodeBuiltin(specifier: string): boolean {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return NODE_BUILTINS.has(bare);
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = join(dirname(fromFile), specifier);
  // Order matters: try the exact path first (an already-extensioned import),
  // then `.ts`/`.tsx`, then directory-index resolution. `base` itself may be
  // an existing directory (`./slices`), which `isFile` correctly rejects.
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

interface Violation {
  file: string;
  specifier: string;
}

/**
 * BFS from `sessionStore.ts` over server/src's own relative-import graph.
 * Stubbed files are treated as leaves (matching Vite's `resolveId`, which
 * swaps them out before their content is ever parsed) and are not opened.
 */
function findUnstubbedNodeBuiltinImports(): Violation[] {
  const stubbedRealPaths = new Set(rendererServerStubs(resolve(__dirname, "..", "..")).map(([realPath]) => realPath));
  const violations: Violation[] = [];
  const visited = new Set<string>();
  const queue: string[] = [ENTRY];

  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    if (stubbedRealPaths.has(file)) continue; // never parsed for real in the browser build

    const source = readFileSync(file, "utf-8");
    IMPORT_SPECIFIER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_SPECIFIER.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(file, specifier);
        if (resolved) queue.push(resolved);
        continue;
      }
      if (isNodeBuiltin(specifier)) {
        violations.push({ file, specifier });
      }
      // Non-relative, non-builtin specifiers (npm packages, `@ion/shared/*`)
      // are out of scope: they're either external packages Vite handles on
      // its own, or the separately browser-safe shared package.
    }
  }

  return violations;
}

const NAMED_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;

interface MissingExport {
  file: string;
  name: string;
  stub: string;
}

/**
 * Every value a reachable server file imports BY NAME from a stubbed module
 * must be exported by that module's browser stub. Rollup resolves the stub in
 * place of the real file, so a name the real file exports and the stub does
 * not is a build failure -- and only a build failure: `tsc` checks the import
 * against the REAL module's types and passes.
 */
function findImportsMissingFromStubs(): MissingExport[] {
  const stubs = new Map(rendererServerStubs(resolve(__dirname, "..", "..")));
  const missing: MissingExport[] = [];
  const visited = new Set<string>();
  const queue: string[] = [ENTRY];

  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    if (stubs.has(file)) continue;

    const source = readFileSync(file, "utf-8");
    IMPORT_SPECIFIER.lastIndex = 0;
    let spec: RegExpExecArray | null;
    while ((spec = IMPORT_SPECIFIER.exec(source)) !== null) {
      if (!spec[1].startsWith(".")) continue;
      const resolved = resolveRelative(file, spec[1]);
      if (resolved) queue.push(resolved);
    }

    NAMED_IMPORT.lastIndex = 0;
    let named: RegExpExecArray | null;
    while ((named = NAMED_IMPORT.exec(source)) !== null) {
      if (named[1] || !named[3].startsWith(".")) continue; // `import type {...}` is erased
      const resolved = resolveRelative(file, named[3]);
      const stub = resolved ? stubs.get(resolved) : undefined;
      if (!stub) continue;
      const stubSource = readFileSync(stub, "utf-8");
      for (const raw of named[2].split(",")) {
        const part = raw.trim();
        if (!part || part.startsWith("type ")) continue;
        const name = part.split(/\s+as\s+/)[0].trim();
        const exported = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class|enum)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`).test(stubSource);
        if (!exported) missing.push({ file, name, stub });
      }
    }
  }
  return missing;
}

describe("rendererServerStubs", () => {
  it("exports from each stub every name a reachable server file imports from it", () => {
    const missing = findImportsMissingFromStubs();
    const detail = missing.map(({ file, name, stub }) => `  ${file} imports '${name}', absent from ${stub}`).join("\n");
    expect(missing, `A browser stub is missing an export the renderer bundle needs:\n${detail}`).toEqual([]);
  });


  it("stubs every server/src file reachable from sessionStore that imports a Node builtin", () => {
    const violations = findUnstubbedNodeBuiltinImports();
    if (violations.length === 0) return;
    const detail = violations.map(({ file, specifier }) => `  ${file} -> '${specifier}'`).join("\n");
    expect.fail(
      `Files reachable from sessionStore.ts import a Node builtin unavailable in the browser web build ` +
        `(vite.web.config.ts) and are not in rendererServerStubs():\n${detail}\n` +
        `Add a browser stub and register it in renderer-server-stubs.ts.`,
    );
  });

  it("lists a browser stub file that exists on disk for every real path", () => {
    for (const [, stubPath] of rendererServerStubs(resolve(__dirname, "..", ".."))) {
      expect(existsSync(stubPath), `missing stub file: ${stubPath}`).toBe(true);
    }
  });
});

const DESKTOP_DIR = resolve(__dirname, "..", "..");
const REAL_SERVER_LOGGER = resolve(SERVER_SRC, "logger.ts");
const LOGGER_ADAPTER = resolve(DESKTOP_DIR, "src/main/server-logger-adapter.ts");

/**
 * Every shipped `.ts` under server/src. Tests are excluded because the main
 * bundle never includes them: a name only a `__tests__` file imports (like
 * `_resetForTest`) is not one the adapter has to stand in for.
 */
function everyServerFile(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...everyServerFile(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Drive the plugin's `resolveId` the way Rollup does, with a context whose
 * `this.resolve` answers the absolute path the importer's specifier points at.
 */
async function resolveThroughPlugin(source: string, importer: string): Promise<string | null> {
  const plugin = mainServerLoggerPlugin(DESKTOP_DIR);
  const hook = plugin.resolveId;
  const handler = typeof hook === "function" ? hook : hook?.handler;
  if (!handler) throw new Error("mainServerLoggerPlugin exposes no resolveId hook");
  const context = {
    resolve: (spec: string, from: string) => {
      const resolved = resolveRelative(from, spec);
      return Promise.resolve(resolved ? { id: resolved } : null);
    },
  };
  const result = await handler.call(context as never, source, importer, {} as never);
  if (typeof result === "string") return result;
  // Rollup's resolveId may also answer `false` (an explicit "leave it external").
  return result && typeof result === "object" ? (result.id ?? null) : null;
}

describe("mainServerLoggerPlugin", () => {
  it("swaps the server logger for the desktop adapter in the main bundle", async () => {
    // Without the swap, every @ion/server module desktop main runs writes
    // server.jsonl as component 'server' -- the wrong file and surface for
    // lines this process emitted.
    const importer = resolve(SERVER_SRC, "engine/engine-bootstrap.ts");
    expect(await resolveThroughPlugin("../logger", importer)).toBe(LOGGER_ADAPTER);
  });

  it("leaves every other server module alone", async () => {
    const importer = resolve(SERVER_SRC, "main.ts");
    expect(await resolveThroughPlugin("./paths", importer)).toBeNull();
  });

  it("never swaps the adapter's own imports, so it cannot resolve to itself", async () => {
    expect(await resolveThroughPlugin("./logger", LOGGER_ADAPTER)).toBeNull();
  });

  it("exports from the adapter every name a server module imports from the logger", () => {
    // Rollup puts the adapter where the real logger was, so a name the real
    // logger exports and the adapter does not is a main-bundle build failure --
    // and only that: tsc checks each import against the REAL module and passes.
    const adapterSource = readFileSync(LOGGER_ADAPTER, "utf-8");
    const missing: string[] = [];
    for (const file of everyServerFile(SERVER_SRC)) {
      const source = readFileSync(file, "utf-8");
      NAMED_IMPORT.lastIndex = 0;
      let named: RegExpExecArray | null;
      while ((named = NAMED_IMPORT.exec(source)) !== null) {
        if (named[1] || !named[3].startsWith(".")) continue; // `import type {...}` is erased
        if (resolveRelative(file, named[3]) !== REAL_SERVER_LOGGER) continue;
        for (const raw of named[2].split(",")) {
          const part = raw.trim();
          if (!part || part.startsWith("type ")) continue;
          const name = part.split(/\s+as\s+/)[0].trim();
          const exported = new RegExp(
            `export\\s+(?:async\\s+)?(?:function|const|let|class|enum)\\s+${name}\\b|export\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b`,
          ).test(adapterSource);
          if (!exported) missing.push(`  ${file} imports '${name}'`);
        }
      }
    }
    expect(missing, `server-logger-adapter.ts is missing an export desktop main needs:\n${missing.join("\n")}`).toEqual([]);
  });
});

// Vite hands `resolveId` forward-slash ids on every platform; `path.resolve`
// answers with backslashes on Windows. The swap has to match across that
// difference or every Windows renderer build bundles the real server files.
describe("sameModulePath", () => {
  it("treats a Windows resolve() path and Vite's normalized id as the same file", () => {
    expect(sameModulePath("C:\\dev\\ion\\server\\src\\logger.ts", "C:/dev/ion/server/src/logger.ts")).toBe(true);
  });

  it("still distinguishes different files", () => {
    expect(sameModulePath("C:\\dev\\ion\\server\\src\\logger.ts", "C:/dev/ion/server/src/state.ts")).toBe(false);
    expect(sameModulePath("/repo/server/src/logger.ts", "/repo/server/src/state.ts")).toBe(false);
  });
});

describe("serverBrowserStubsPlugin on a Windows checkout", () => {
  it("swaps a stub in when Vite reports the server file with forward slashes", async () => {
    const desktopDir = "C:\\dev\\ion\\desktop";
    const plugin = serverBrowserStubsPlugin(desktopDir);
    const resolveId = plugin.resolveId as (
      this: { resolve: (source: string) => Promise<{ id: string }> },
      source: string,
      importer: string,
      options: Record<string, unknown>,
    ) => Promise<string | null>;
    // What Vite would report for `../server/src/logger.ts` on that checkout,
    // whatever `path.resolve` produced for the stub table on this host.
    const [realLogger, stub] = rendererServerStubs(desktopDir)[0];
    const viteId = realLogger.replace(/\\/g, "/");
    const result = await resolveId.call(
      { resolve: async () => ({ id: viteId }) },
      "../logger",
      "C:/dev/ion/server/src/store/sessionStore.ts",
      {},
    );
    expect(result).toBe(stub);
  });
});
