import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const versioning = require("../../scripts/desktop-version.js") as {
  nextDevelopmentVersion: (
    release: string,
    sha: string,
    dirty?: boolean,
  ) => string;
  readReleasedDesktopVersion: () => string;
};

describe("desktop development version", () => {
  it("uses the next minor version and identifies the source commit", () => {
    expect(versioning.nextDevelopmentVersion("1.82.0", "abcdef123456")).toBe(
      "1.83.0-dev.abcdef123456",
    );
    expect(
      versioning.nextDevelopmentVersion("1.82.0", "abcdef123456", true),
    ).toBe("1.83.0-dev.abcdef123456.dirty");
  });

  // Asserts the READ, not a specific version string. release-please rewrites
  // release-please-manifest.json on every release, so a hardcoded expectation
  // here goes red on a commit that changed nothing about this code — which is
  // exactly what happened when desktop shipped 1.84.0 against a test pinned to
  // '1.83.0'. Compare against the manifest itself: that pins the contract the
  // function actually has (read THIS key from THAT file) and survives releases.
  it("reads the released desktop version from the release manifest", () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(__dirname, "../../../release-please-manifest.json"),
        "utf8",
      ),
    ) as Record<string, string>;

    expect(versioning.readReleasedDesktopVersion()).toBe(manifest.desktop);
    // The format matters as much as the value: nextDevelopmentVersion parses it
    // with split('.')/Number, so a non-semver string would silently yield NaN.
    expect(versioning.readReleasedDesktopVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
