// @ts-check
// afterSign hook — notarizes the .app bundle in CI only.
// Skipped entirely for local builds.
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

/**
 * @param {import("electron-builder").AfterPackContext} context
 */
exports.default = async function notarize(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CI !== "true") {
    console.log("Skipping notarization (not CI)");
    return;
  }

  const apiKey = process.env.APPLE_API_KEY;
  const apiKeyId = process.env.APPLE_API_KEY_ID;
  const apiIssuer = process.env.APPLE_API_ISSUER;
  if (!apiKey || !apiKeyId || !apiIssuer) {
    console.warn("Skipping notarization (missing APPLE_API_* env vars)");
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  if (!fs.existsSync(appPath)) {
    throw new Error(`App not found at ${appPath}`);
  }

  console.log(`Notarizing ${appPath}...`);

  // Create a zip for notarytool
  const zipPath = `${appPath}.zip`;
  execSync(
    `ditto -c -k --keepParent "${appPath}" "${zipPath}"`,
    { stdio: "inherit" },
  );

  // Write API key to temp file
  const keyFile = path.join(require("os").tmpdir(), `apikey-${Date.now()}.p8`);
  fs.writeFileSync(keyFile, Buffer.from(apiKey, "base64"));

  try {
    execSync(
      [
        "xcrun notarytool submit",
        `"${zipPath}"`,
        `--key "${keyFile}"`,
        `--key-id "${apiKeyId}"`,
        `--issuer "${apiIssuer}"`,
        "--wait",
        "--timeout 15m",
      ].join(" "),
      { stdio: "inherit" },
    );

    // Staple the ticket to the .app
    execSync(`xcrun stapler staple "${appPath}"`, { stdio: "inherit" });
    console.log("Notarization complete.");
  } finally {
    fs.unlinkSync(keyFile);
    fs.unlinkSync(zipPath);
  }
};
