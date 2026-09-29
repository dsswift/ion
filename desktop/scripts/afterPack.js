// ──────────────────────────────────────────────────────
//  afterPack.js -- electron-builder afterPack hook
//
//  1. Makes node-pty's prebuilt spawn-helper executable in
//     app.asar.unpacked (macOS and Linux). npm extracts it
//     0644, electron-builder copies that mode, and pkgbuild
//     preserves it -- so without this step every terminal in
//     the installed app fails with "posix_spawnp failed."
//  2. Signs the Ion Engine binary embedded as an extraResource
//     (macOS). electron-builder signs the main Electron app and
//     its frameworks, but does not automatically sign
//     extraResources. Without this, macOS Gatekeeper
//     quarantines the unsigned engine binary on first launch.
// ──────────────────────────────────────────────────────

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { ensureSpawnHelpersExecutable, ensureHelperPathUnpackSafe, spawnHelperPaths } = require("../../scripts/node-pty-spawn-helper");

const IDENTITY = process.env.APPLE_SIGNING_IDENTITY || "Ion Local Dev";
const ENTITLEMENTS = path.join(__dirname, "..", "resources", "entitlements.mac.plist");

/**
 * The unpacked node-pty package inside a packed app, per platform. Windows
 * ships node-pty too but uses ConPTY and carries no spawn-helper.
 */
function unpackedNodePtyDir(context, appPath) {
  const resources = context.electronPlatformName === "darwin"
    ? path.join(appPath, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  return path.join(resources, "app.asar.unpacked", "node_modules", "node-pty");
}

/**
 * Fail the build rather than ship a terminal that cannot start. The helper
 * is a hard requirement of the terminal feature on these platforms, so its
 * absence is a packaging defect, not a condition to skip past.
 */
function fixSpawnHelper(context, appPath) {
  if (context.electronPlatformName === "win32") {
    console.log("  afterPack: win32 target, no node-pty spawn-helper to fix");
    return;
  }
  const nodePtyDir = unpackedNodePtyDir(context, appPath);
  if (!fs.existsSync(nodePtyDir)) {
    throw new Error(`afterPack: node-pty is not unpacked at ${nodePtyDir}; check asarUnpack in package.json`);
  }
  if (spawnHelperPaths(nodePtyDir).length === 0) {
    throw new Error(`afterPack: no prebuilt spawn-helper under ${nodePtyDir}/prebuilds; node-pty's prebuilds did not ship`);
  }
  const { fixed, already } = ensureSpawnHelpersExecutable(nodePtyDir);
  for (const p of fixed) console.log(`  afterPack: set execute bit on ${path.relative(context.appOutDir, p)}`);
  for (const p of already) console.log(`  afterPack: already executable ${path.relative(context.appOutDir, p)}`);
  // The server loads node-pty from this unpacked tree; its shipped resolver
  // would double the `.unpacked` suffix. check-packaged-requires refuses the
  // artifact if this did not take.
  console.log(`  afterPack: node-pty helper path resolver ${ensureHelperPathUnpackSafe(nodePtyDir)}`);
}

exports.fixSpawnHelper = fixSpawnHelper;

exports.default = async function afterPack(context) {
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  fixSpawnHelper(context, appPath);

  if (context.electronPlatformName !== "darwin") {
    console.log("  afterPack: non-darwin target, codesign skipped");
    return;
  }

  const engineBin = path.join(appPath, "Contents", "Resources", "engine", "ion");

  if (!fs.existsSync(engineBin)) {
    console.log("  afterPack: engine binary not found, skipping codesign");
    return;
  }

  // Build the codesign command. Use the project signing identity if
  // available, otherwise fall back to ad-hoc signing.
  const entitlementsArgs = fs.existsSync(ENTITLEMENTS)
    ? `--entitlements "${ENTITLEMENTS}"`
    : "";

  const identityAvailable = (() => {
    try {
      const out = execSync(
        `security find-identity -v -p codesigning 2>/dev/null`,
        { encoding: "utf8" }
      );
      return out.includes(IDENTITY);
    } catch {
      return false;
    }
  })();

  const sign = identityAvailable ? `"${IDENTITY}"` : "-";

  // Explicit namespaced identifier: macOS Local Network grants key to the
  // code identity, and grant creation is silently suppressed for identities
  // with stale records in the SIP-locked NetworkExtension policy store (the
  // default filename-derived identifier "ion" is poisoned that way). Keep in
  // sync with engine/commands/install.command and the release workflow.
  const cmd = `codesign --force --sign ${sign} --identifier house.sprague.ion.engine --options runtime ${entitlementsArgs} "${engineBin}"`;

  console.log(`  afterPack: signing engine binary (identity: ${identityAvailable ? IDENTITY : "ad-hoc"})`);
  try {
    execSync(cmd, { stdio: "inherit" });
    console.log("  afterPack: engine binary signed");
  } catch (err) {
    console.error("  afterPack: codesign failed, falling back to ad-hoc");
    try {
      execSync(`codesign --force --sign - --options runtime "${engineBin}"`, {
        stdio: "inherit",
      });
      console.log("  afterPack: engine binary signed (ad-hoc fallback)");
    } catch (fallbackErr) {
      console.error("  afterPack: ad-hoc codesign also failed:", fallbackErr.message);
    }
  }
};
