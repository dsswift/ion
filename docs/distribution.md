# Distribution & Signing

Ion uses Apple Developer ID code signing and notarization for its macOS binaries. This ensures users can run Ion without Gatekeeper warnings.

## What Gets Signed

| Artifact | Signed | Notarized | Where |
|----------|--------|-----------|-------|
| Engine binary (macOS) | ✅ Developer ID | ✅ | CI release pipeline |
| Desktop app (.app) | ✅ Developer ID | ✅ | CI release pipeline |
| Desktop .pkg | ✅ Developer ID Installer (`productsign`) | ✅ | Installs the signed + notarized .app safely |
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
5. `.pkg` uploaded for manual installation; zip + `latest-mac.yml` uploaded for auto-update

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
3. Shows update progress and a ready-to-install dialog in both Desktop presentations
4. Stages a detached install worker when the user chooses Install update
5. User clicks Restart to stop desktop and engine, replace the bundle, and relaunch

## Installing over a running Ion

Replacing the app bundle while Ion is running corrupts the live process: the new
payload lands on the executable, frameworks, and bundled engine binary while they
are mapped and in use. Which artifacts guard against that differs, because only
some of them can execute code at install time.

| Install path | Quits a running Ion first | Mechanism |
|---|---|---|
| In-app updater | Yes | Stages the zip and dispatches `install-worker.sh`; the explicit Restart stops the desktop and engine before the worker replaces the bundle |
| `.pkg` (manual / MDM) | No, if Ion is running | `preinstall` refuses before the payload changes and tells the user to quit Ion, then retry; `postinstall` launches Ion for the active console user after a successful install |
| Source build (`make desktop`) | Yes | A detached coordinator sends the normal `SIGUSR1` drain, waits for Ion to exit, then opens the same `.pkg` |

The source-build coordinator sends `SIGUSR1`: Ion drains active agents,
flushes renderer tab state, boots out the engine daemon so launchd does not
restart it, then exits (`desktop/src/main/app-lifecycle.ts`). The coordinator
waits outside Installer without a timeout and opens the already-built `.pkg`
only after Ion exits. A manually opened package never stops Ion: its preinstall
script exits before the payload changes and tells the user to quit Ion, then
retry. After a successful package install, postinstall opens Ion for the active
console user. The in-app updater stages the signed zip, dispatches the detached install
worker, and performs an explicit immediate Restart that closes desktop and
engine together before the worker replaces the bundle.

## Bundle IDs

| Component | Bundle ID |
|-----------|-----------|
| Desktop | `com.sprague.ion.desktop` |
| iOS | `com.sprague.ion.mobile` |

## Push Notifications

Push notifications are an optional enhancement for the iOS app. They fire when the mobile WebSocket is disconnected and the engine needs attention (permission request, plan approval, task completion).

The flow: Engine event → Desktop → Relay → APNs → iOS

Push degrades gracefully — if registration fails, the app works identically via WebSocket. See `docs/push-notifications.md` for details.
