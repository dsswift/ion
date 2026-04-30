// ──────────────────────────────────────────────────────
//  afterPack.js -- electron-builder afterPack hook
//
//  Signs the Ion Engine binary embedded as an extraResource.
//  electron-builder signs the main Electron app and its
//  frameworks, but does not automatically sign extraResources.
//  Without this, macOS Gatekeeper quarantines the unsigned
//  engine binary on first launch.
// ──────────────────────────────────────────────────────

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const IDENTITY = "Ion Local Dev";
const ENTITLEMENTS = path.join(__dirname, "..", "resources", "entitlements.mac.plist");

exports.default = async function afterPack(context) {
  if (process.platform !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
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

  const cmd = `codesign --force --sign ${sign} --options runtime ${entitlementsArgs} "${engineBin}"`;

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
