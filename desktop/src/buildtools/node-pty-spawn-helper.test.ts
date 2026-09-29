/**
 * node-pty's prebuilt `spawn-helper` ships 0644 from npm and a non-executable
 * helper fails every terminal with "posix_spawnp failed." -- which is how the
 * packaged desktop shipped once. Three places set or verify the bit from one
 * implementation: the repo's postinstall (dev tree), afterPack.js (the
 * app.asar.unpacked copy pkgbuild installs), and check-packaged-requires.js
 * (the gate that the fix reached the artifact). These tests pin all three.
 */
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const helperScript = require("../../../scripts/node-pty-spawn-helper.js") as {
  ensureHelperPathUnpackSafe: (dir: string) => "patched" | "already" | "unrecognised" | "missing";
  helperPathIsUnpackSafe: (dir: string) => boolean;
  spawnHelperPaths: (nodePtyDir: string) => string[];
  ensureSpawnHelpersExecutable: (nodePtyDir: string) => { fixed: string[]; already: string[] };
  findNodePtyDir: (fromDir: string) => string | undefined;
};
const checker = require("../../scripts/check-packaged-requires.js") as {
  checkSpawnHelpers: (unpackedRoot: string, platform?: NodeJS.Platform) => { from: string; specifier: string; reason: string }[];
};
const afterPack = require("../../scripts/afterPack.js") as {
  fixSpawnHelper: (context: { electronPlatformName: string; appOutDir: string }, appPath: string) => void;
};

const POSIX = process.platform !== "win32";

/** A node-pty package layout with one helper per prebuild, all written 0644 the way npm leaves them. */
function installNodePty(root: string, prebuilds: string[]): string {
  const dir = join(root, "node_modules", "node-pty");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0" }));
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", "unixTerminal.js"), "var helperPath = native.dir + '/spawn-helper';\nhelperPath = path.resolve(__dirname, helperPath);\nhelperPath = helperPath.replace('app.asar', 'app.asar.unpacked');\n");
  for (const p of prebuilds) {
    mkdirSync(join(dir, "prebuilds", p), { recursive: true });
    writeFileSync(join(dir, "prebuilds", p, "pty.node"), "");
    if (!p.startsWith("win32")) {
      writeFileSync(join(dir, "prebuilds", p, "spawn-helper"), "#!/bin/sh\n");
      chmodSync(join(dir, "prebuilds", p, "spawn-helper"), 0o644);
    }
  }
  return dir;
}

const isExecutable = (p: string): boolean => (statSync(p).mode & 0o111) === 0o111;

describe("node-pty spawn-helper execute bit", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ion-spawn-helper-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists every unix prebuild's helper and none for windows", () => {
    const dir = installNodePty(root, ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]);
    expect(helperScript.spawnHelperPaths(dir).map((p) => basename(dirname(p)))).toEqual(["darwin-arm64", "darwin-x64", "linux-x64"]);
    expect(helperScript.spawnHelperPaths(join(root, "nowhere"))).toEqual([]);
  });

  it.skipIf(!POSIX)("sets the execute bit on every helper npm left 0644 and reports what changed", () => {
    const dir = installNodePty(root, ["darwin-arm64", "linux-x64"]);
    chmodSync(join(dir, "prebuilds", "linux-x64", "spawn-helper"), 0o755);
    const { fixed, already } = helperScript.ensureSpawnHelpersExecutable(dir);
    expect(fixed).toEqual([join(dir, "prebuilds", "darwin-arm64", "spawn-helper")]);
    expect(already).toEqual([join(dir, "prebuilds", "linux-x64", "spawn-helper")]);
    expect(isExecutable(join(dir, "prebuilds", "darwin-arm64", "spawn-helper"))).toBe(true);
    // Idempotent: a second pass changes nothing.
    expect(helperScript.ensureSpawnHelpersExecutable(dir)).toEqual({ fixed: [], already: [already[0], fixed[0]].sort() });
  });

  it("rewrites the shipped helper resolver so an unpacked load does not double the suffix, idempotently", () => {
    const dir = installNodePty(root, ["darwin-arm64"]);
    expect(helperScript.helperPathIsUnpackSafe(dir)).toBe(false);
    expect(helperScript.ensureHelperPathUnpackSafe(dir)).toBe("patched");
    expect(helperScript.helperPathIsUnpackSafe(dir)).toBe(true);
    expect(helperScript.ensureHelperPathUnpackSafe(dir)).toBe("already");
    // The rewritten expression maps an in-archive path and leaves an unpacked one alone.
    const resolver = /helperPath\.replace\((.*)\);/.exec(readFileSync(join(dir, "lib", "unixTerminal.js"), "utf8"))![1];
    const apply = (helperPath: string): string => new Function("helperPath", `return helperPath.replace(${resolver})`)(helperPath) as string;
    expect(apply("/App.app/Contents/Resources/app.asar/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper")).toBe("/App.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
    expect(apply("/App.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper")).toBe("/App.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
    expect(helperScript.ensureHelperPathUnpackSafe(join(root, "nowhere"))).toBe("missing");
  });

  it("finds node-pty by walking node_modules upward, as a hoisted workspace requires", () => {
    const dir = installNodePty(root, ["darwin-arm64"]);
    const deep = join(root, "desktop", "scripts");
    mkdirSync(deep, { recursive: true });
    expect(helperScript.findNodePtyDir(deep)).toBe(dir);
    expect(helperScript.findNodePtyDir(mkdtempSync(join(tmpdir(), "ion-no-pty-")))).toBeUndefined();
  });

  it.skipIf(!POSIX)("check-packaged-requires reports a packed helper without its execute bit and is quiet once it has one", () => {
    const unpacked = join(root, "app.asar.unpacked");
    const dir = installNodePty(unpacked, ["darwin-arm64"]);
    const problems = checker.checkSpawnHelpers(unpacked, "darwin");
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({ specifier: "helper path resolver" });
    expect(problems[0].reason).toMatch(/app\.asar\.unpacked\.unpacked/);
    expect(problems[1]).toMatchObject({
      from: join("app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"),
      specifier: "execute bit",
    });
    expect(problems[1].reason).toMatch(/mode 0644 is not executable; every terminal would fail/);
    chmodSync(join(dir, "prebuilds", "darwin-arm64", "spawn-helper"), 0o755);
    helperScript.ensureHelperPathUnpackSafe(dir);
    expect(checker.checkSpawnHelpers(unpacked, "darwin")).toEqual([]);
    // Windows carries no helper; an app without unpacked node-pty has nothing to check.
    expect(checker.checkSpawnHelpers(unpacked, "win32")).toEqual([]);
    expect(checker.checkSpawnHelpers(join(root, "elsewhere"), "darwin")).toEqual([]);
  });

  it.skipIf(!POSIX)("afterPack fixes the app.asar.unpacked copy for a mac app and refuses to ship without a helper", () => {
    const appOutDir = join(root, "mac-arm64");
    const appPath = join(appOutDir, "Ion.app");
    const dir = installNodePty(join(appPath, "Contents", "Resources", "app.asar.unpacked"), ["darwin-arm64"]);
    afterPack.fixSpawnHelper({ electronPlatformName: "darwin", appOutDir }, appPath);
    expect(isExecutable(join(dir, "prebuilds", "darwin-arm64", "spawn-helper"))).toBe(true);

    const bare = join(root, "bare", "Ion.app");
    mkdirSync(bare, { recursive: true });
    expect(() => afterPack.fixSpawnHelper({ electronPlatformName: "darwin", appOutDir: join(root, "bare") }, bare)).toThrow(/node-pty is not unpacked/);

    const noHelper = join(root, "nohelper", "Ion.app");
    installNodePty(join(noHelper, "Contents", "Resources", "app.asar.unpacked"), ["win32-x64"]);
    expect(() => afterPack.fixSpawnHelper({ electronPlatformName: "darwin", appOutDir: join(root, "nohelper") }, noHelper)).toThrow(/no prebuilt spawn-helper/);

    // Windows: nothing to fix, nothing to refuse.
    expect(() => afterPack.fixSpawnHelper({ electronPlatformName: "win32", appOutDir: join(root, "win") }, join(root, "win", "Ion.app"))).not.toThrow();
  });
});
