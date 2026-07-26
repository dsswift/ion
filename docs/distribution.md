# Distribution & Signing

Ion uses Apple Developer ID code signing and notarization for its macOS binaries. This ensures users can run Ion without Gatekeeper warnings.

## What Gets Signed

| Artifact | Signed | Notarized | Where |
|----------|--------|-----------|-------|
| Engine binary (macOS) | ✅ Developer ID | ✅ | CI release pipeline |
| Desktop app (.app) | ✅ Developer ID | ✅ | CI release pipeline |
| Desktop DMG | ✅ Developer ID Application (`dmg.sign`) | N/A | Wraps the signed + notarized .app |
| Desktop .pkg (MDM) | ✅ Developer ID Installer (`productsign`) | ✅ | CI release pipeline; unsigned when `APPLE_INSTALLER_CERT_BASE64` is absent |
| Engine binary (local build) | Ad-hoc (`codesign -`) | ❌ | Local `make engine` |
| Desktop app (local build) | Self-signed | ❌ | Local `npm run dist` |
| iOS app | Xcode Automatic Signing | N/A | Xcode Cloud / local Xcode |

## Required Secrets

These GitHub repository secrets power the CI signing pipeline:

| Secret | Description |
|--------|-------------|
| `APPLE_CERT_BASE64` | Base64-encoded .p12 Developer ID Application certificate |
| `APPLE_CERT_PASSWORD` | Password for the .p12 file |
| `APPLE_API_KEY` | Base64-encoded App Store Connect API .p8 key |
| `APPLE_API_KEY_ID` | Key ID from App Store Connect |
| `APPLE_API_ISSUER` | Issuer UUID from App Store Connect |

## How It Works

### Engine (CI)

1. Darwin matrix entries run on `macos-14` runners
2. Certificate imported into a temporary keychain
3. Binary signed with `codesign --force --sign "Developer ID Application: ..." --options runtime`
4. Binary zipped and submitted to `xcrun notarytool`
5. Apple scans, approves, issues ticket
6. Signed binary uploaded to GitHub Release

### Desktop (CI)

1. Builds on `macos-14` with electron-builder
2. Certificate imported into keychain (same process as engine)
3. electron-builder signs the .app with Developer ID
4. `afterSign` hook (`scripts/notarize.js`) notarizes and staples
5. DMG + zip uploaded to GitHub Release with `latest-mac.yml` for auto-update

### Local Builds

Local builds are completely unaffected by the signing pipeline:

- `make engine` uses ad-hoc signing (`codesign --sign -`)
- `npm run dist` uses the local "Ion Local Dev" self-signed certificate
- No Apple Developer ID certificate is required for development
- No network calls to Apple during local builds

## Self-Update

The engine supports `ion upgrade` which:

1. Queries GitHub API for the latest `engine-v*` release
2. Compares semver against the compiled-in version
3. Downloads the correct binary for the current OS/arch
4. Verifies SHA256 checksum against `checksums.txt`
5. Atomically replaces the running binary

The desktop app uses electron-updater for auto-update:

1. Checks GitHub Releases on launch and every 4 hours
2. Downloads update in the background
3. Shows a notification banner when ready
4. User clicks "Restart" to quit and install

## Installing over a running Ion

Replacing the app bundle while Ion is running corrupts the live process: the new
payload lands on the executable, frameworks, and bundled engine binary while they
are mapped and in use. Which artifacts guard against that differs, because only
some of them can execute code at install time.

| Install path | Quits a running Ion first | Mechanism |
|---|---|---|
| In-app updater | Yes | `autoInstallOnAppQuit` + `quitAndInstall()` (`desktop/src/main/updater.ts`) |
| `.pkg` (MDM / manual) | Yes | `preinstall` script embedded via `pkgbuild --scripts` (`desktop/scripts/pkg-scripts/preinstall`) |
| Source build (`install-app.command`) | Yes | Inline PID resolution + `SIGUSR1` drain |
| `.dmg` | No — not possible | Drag-to-Applications image; Finder performs the copy and no project code runs |

The `.pkg` and the source-build installer both quit via `SIGUSR1`: the app drains
active agents, flushes renderer tab state, boots out the engine daemon so launchd
does not restart it, then exits (`desktop/src/main/app-lifecycle.ts`). The `.pkg`
preinstall waits for that drain, force-quits if it exceeds its budget, then reaps
stray helper processes before the payload is written. It always exits 0, so
installing when Ion is not running is never blocked. The in-app updater does not
need a signal — it quits the app itself before swapping the bundle.

**The DMG cannot be fixed the same way.** A DMG is a disk image, not an
installer: electron-builder's `dmg` options expose no script or hook key, so
there is no install-time step to attach a quit to. Users updating in place should
use the in-app updater (or the `.pkg`), and quit Ion manually before dragging a
DMG build over an existing install.

## Bundle IDs

| Component | Bundle ID |
|-----------|-----------|
| Desktop | `com.sprague.ion.desktop` |
| iOS | `com.sprague.ion.mobile` |

## Push Notifications

Push notifications are an optional enhancement for the iOS app. They fire when the mobile WebSocket is disconnected and the engine needs attention (permission request, plan approval, task completion).

The flow: Engine event → Desktop → Relay → APNs → iOS

Push degrades gracefully — if registration fails, the app works identically via WebSocket. See `docs/push-notifications.md` for details.
