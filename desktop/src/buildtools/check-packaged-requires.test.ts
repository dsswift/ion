import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type Problem = { from: string; specifier: string; reason: string };
const checker = require("../../scripts/check-packaged-requires.js") as {
  bareSpecifiers: (code: string) => string[];
  checkResolution: (rootDir: string, entries: { file: string; code: string }[], binary?: string) => Problem[];
  checkAsar: (asarPath: string, binary?: string) => Problem[];
  bundleEntries: (rootDir: string) => { file: string; code: string }[];
};
const asar = require("@electron/asar") as {
  createPackage: (src: string, dest: string) => Promise<void>;
};

// The tests probe with this process's Node: the fixtures are pure JS, and
// what is under test is resolution from inside the packaged tree, which is
// binary-independent. Production probes with Electron for the native ABI.
const NODE = process.execPath;

/** Writes a minimal installed package under `root/node_modules/<name>`. */
function installPackage(
  root: string,
  name: string,
  manifest: Record<string, unknown> = {},
  code = "module.exports = {}",
) {
  const dir = join(root, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js", ...manifest }),
  );
  writeFileSync(join(dir, "index.js"), code);
  return dir;
}

function writeMain(root: string, code: string) {
  mkdirSync(join(root, "dist", "main"), { recursive: true });
  writeFileSync(join(root, "dist", "main", "index.js"), code);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", main: "dist/main/index.js" }));
}

function entries(root: string) {
  return [{ file: "dist/main/index.js", code: readFileSync(join(root, "dist/main/index.js"), "utf8") }];
}

describe("check-packaged-requires", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ion-req-check-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("collects bare specifiers and rejects prose that only looks like a load", () => {
    const code = [
      'const a = require("archiver");',
      'const b = require("@ion/server/state");',
      "import c from 'zustand/vanilla'",
      'const d = await import("ws")',
      'const e = require("./local");',
      'const f = require("node:fs");',
      // Verbatim shapes from the real main bundle's log strings.
      'log("resolved from ", who);',
      'warn("ignoring input from a resize arrived with bad numbers");',
      'return { ok: false, reason: `from ${x}` }',
    ].join("\n");
    expect(checker.bareSpecifiers(code)).toEqual([
      "archiver",
      "@ion/server/state",
      "zustand/vanilla",
      "ws",
      "node:fs",
    ]);
  });

  it("passes a complete graph and ignores builtins and electron", () => {
    installPackage(root, "alpha", {}, 'require("beta"); require("fs"); require("node:path");');
    installPackage(root, "beta");
    writeMain(root, 'require("alpha"); require("fs"); require("node:path"); require("electron");');
    expect(checker.checkResolution(root, entries(root), NODE)).toEqual([]);
  });

  it("stubs electron so a library touching electron.app at module scope still loads", () => {
    installPackage(root, "updater", {}, 'const e = require("electron"); e.app.on("ready", () => {}); module.exports = e.app.getPath("x")');
    writeMain(root, 'require("updater");');
    expect(checker.checkResolution(root, entries(root), NODE)).toEqual([]);
  });

  it("reports a bundle require the asar does not carry", () => {
    writeMain(root, 'require("react");');
    const problems = checker.checkResolution(root, entries(root), NODE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ from: "dist/main/index.js", specifier: "react" });
    expect(problems[0].reason).toMatch(/Cannot find module 'react'/);
  });

  it("reports a shipped package whose own require is not shipped", () => {
    // The zustand launch failure as it happened: the bundle's require
    // resolves, but that package's entry unconditionally requires a module
    // that was never packaged. Its manifest calls react an optional peer, so
    // only loading it reveals the truth.
    installPackage(
      root,
      "zustand",
      { peerDependencies: { react: "*" }, peerDependenciesMeta: { react: { optional: true } } },
      'module.exports = require("react")',
    );
    writeMain(root, 'require("zustand");');
    const problems = checker.checkResolution(root, entries(root), NODE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ from: "dist/main/index.js", specifier: "zustand" });
    expect(problems[0].reason).toMatch(/Cannot find module 'react'/);
  });

  it("accepts a guarded optional require the package handles itself", () => {
    installPackage(root, "ws", {}, 'try { require("bufferutil") } catch { module.exports = "fallback" }');
    writeMain(root, 'require("ws");');
    expect(checker.checkResolution(root, entries(root), NODE)).toEqual([]);
  });

  it("does not fall back to node_modules above the packaged tree", () => {
    // A dependency installed beside the temp dir, the way the developer's
    // own node_modules sits above an extraction, must not rescue the probe.
    installPackage(dirname(root), "outsider");
    try {
      writeMain(root, 'require("outsider");');
      const problems = checker.checkResolution(root, entries(root), NODE);
      expect(problems.map((p) => p.specifier)).toEqual(["outsider"]);
    } finally {
      rmSync(join(dirname(root), "node_modules", "outsider"), { recursive: true, force: true });
    }
  });

  it("resolves scoped subpath specifiers through the package's exports map", () => {
    const dir = installPackage(root, "@scope/pkg", { exports: { "./sub": "./sub.js" } });
    writeFileSync(join(dir, "sub.js"), "module.exports = 1");
    writeMain(root, 'require("@scope/pkg/sub");');
    expect(checker.checkResolution(root, entries(root), NODE)).toEqual([]);
  });

  it("probes the shipped Studio server bundle alongside main and preload", () => {
    // The server ships unpacked at server/main.js with node-pty external;
    // a packaged copy that could not find a package it imports left the
    // LOCAL environment offline on every launch.
    writeMain(root, 'require("electron");');
    mkdirSync(join(root, "dist", "server"), { recursive: true });
    writeFileSync(
      join(root, "dist", "server", "main.js"),
      // ws's optional accelerators are required inside ws's own try/catch
      // and stay external in the server bundle; their absence is expected.
      'import "node-pty";\nimport "ws";\nrequire("bufferutil");\nrequire("utf-8-validate");',
    );
    installPackage(root, "node-pty");
    const files = checker.bundleEntries(root).map((e) => e.file).sort();
    expect(files).toEqual(["dist/main/index.js", "dist/server/main.js"]);
    const problems = checker.checkResolution(root, checker.bundleEntries(root), NODE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ from: "dist/server/main.js", specifier: "ws" });
  });

  it("reports an asar that ships no Studio server bundle", async () => {
    writeMain(root, 'require("electron");');
    const asarDir = mkdtempSync(join(tmpdir(), "ion-req-asar-"));
    const asarPath = join(asarDir, "app.asar");
    await asar.createPackage(root, asarPath);
    try {
      expect(checker.checkAsar(asarPath, NODE)).toEqual([
        { from: asarPath, specifier: "dist/server/main.js", reason: "Studio server bundle is not packaged" },
      ]);
    } finally {
      rmSync(asarDir, { recursive: true, force: true });
    }
  });

  it("checks a real asar end to end", async () => {
    installPackage(root, "zustand", {}, 'module.exports = require("react")');
    writeMain(root, 'require("zustand");');
    mkdirSync(join(root, "dist", "server"), { recursive: true });
    writeFileSync(join(root, "dist", "server", "main.js"), 'import "node-pty";');
    installPackage(root, "node-pty");
    const asarDir = mkdtempSync(join(tmpdir(), "ion-req-asar-"));
    const asarPath = join(asarDir, "app.asar");
    await asar.createPackage(root, asarPath);
    try {
      const problems = checker.checkAsar(asarPath, NODE);
      expect(problems, JSON.stringify(problems)).toHaveLength(1);
      expect(problems[0]).toMatchObject({ from: "dist/main/index.js", specifier: "zustand" });
      expect(problems[0].reason).toMatch(/Cannot find module 'react'/);
    } finally {
      rmSync(asarDir, { recursive: true, force: true });
    }
  });
});
