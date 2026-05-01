# iOS (Swift, SwiftUI, MVVM)

iPhone companion (Ion Remote) for Ion Desktop. LAN (Bonjour/mDNS) + relay (WebSocket).

## Commands

```bash
make ios          # install via commands/install.command
make ios-check    # build only (CI parity)

cd ios && xcodebuild -project IonRemote.xcodeproj -scheme IonRemote \
  -destination 'generic/platform=iOS' build

# Run unit tests on a simulator destination:
cd ios && xcodebuild test -project IonRemote.xcodeproj -scheme IonRemote \
  -destination 'platform=iOS Simulator,name=iPhone 15'
```

Interactive: open `ios/IonRemote.xcodeproj` in Xcode. ⌘U runs tests.

## Layout

```
ios/
  IonRemote.xcodeproj    Xcode project (single source of truth for build config)
  IonRemote/             App target source
    App/                 Entry point, environment setup
    Crypto/              Pairing crypto, ECDH, encryption
    Models/              Plain data (NormalizedEvent, RemoteCommand)
    Networking/          LAN + relay clients, transport mux, pairing
    Utilities/           Cross-cutting helpers
    ViewModels/          SessionViewModel, etc.
    Views/               SwiftUI views
  IonRemoteTests/        XCTest target. Mirrors source folder structure.
  commands/              Local install scripts (install.command)
  logs/                  Local-only logs from install commands. Gitignored.
  README.md, CHANGELOG.md, VERSION
```

## Adding files to the project

Source files added to `IonRemote/` or test files added to `IonRemoteTests/` must also be added to the Xcode project file (`IonRemote.xcodeproj/project.pbxproj`) — either via Xcode's "Add Files…" dialog or by manually editing the pbxproj. A file on disk that isn't referenced in the project is invisible to the build.

When adding a test, ensure it's a member of the `IonRemoteTests` target, not `IonRemote`.

## File-architecture rules

- 600-line cap per `.swift`. CI hard-fails above. Override: `// @file-size-exception: <reason>` on line 1.
- One type per file. Filename matches the type name.
- Subfolder when a folder grows past ~5 files (Networking already splits this way).
- Allowlisted (don't extend; extract): `IonRemote/ViewModels/SessionViewModel.swift`, `IonRemote/Networking/TransportManager.swift`, `IonRemote/Models/NormalizedEvent.swift`.

## Tests (`IonRemoteTests/`)

- XCTest. Mirror the source folder structure inside `IonRemoteTests/`.
- Existing test files: `E2ECryptoTests.swift`, `NormalizedEventLifecycleTests.swift`, `NormalizedEventStreamTests.swift`, `NormalizedEventPermissionTests.swift`, `NormalizedEventTerminalTests.swift`, `RelayClientTests.swift`, `TransportManagerTests.swift`.
- Wire-format changes (`NormalizedEvent`, `RemoteCommand`, `RemoteTabState`) must update the corresponding test fixtures.
- Crypto changes must keep `E2ECryptoTests.swift` passing — it round-trips real pairing handshakes.
- Network changes must keep `RelayClientTests.swift` and `TransportManagerTests.swift` green.

## MVVM

- Views own no business state. Observe a ViewModel via `@StateObject` / `@ObservedObject`.
- ViewModels publish state. No view code in them.
- Models are plain data. `Codable` for wire types. No business logic.
- Networking: async/await throughout. Cancellation via `Task` cancellation, not custom flags.
- Crypto isolated under `Crypto/`. Don't inline crypto operations elsewhere.

## Pairing/transport

LAN and relay share `RemoteCommand` and `RemoteTabState`. Pairing is ECDH; shared secret derives an AES key. Transport switching (LAN ↔ relay) via the transport manager. Don't bypass it from views.

## Wire-protocol parity

iOS models (`NormalizedEvent`, `RemoteCommand`, `RemoteTabState`) mirror desktop/engine wire types. When the engine adds an event variant or field, the iOS Swift type must add it too — otherwise relay/LAN messages decode incorrectly. Source of truth: `engine/internal/types/normalized_event.go` and `desktop/src/shared/types.ts`.

## Done criteria

1. `make ios-check` succeeds.
2. Wire-type or crypto or networking changes: run the relevant `IonRemoteTests/` test.
3. `make check-file-sizes` passes.
4. UI changes: smoke-tested on device or simulator. Report what was tested.
5. Don't `git push`.
