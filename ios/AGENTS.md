# iOS (Swift, SwiftUI, MVVM)

iPhone companion (Ion Remote) for Ion Desktop. LAN (Bonjour/mDNS) + relay (WebSocket).

> **Plan resolution rule (applies to all fix plans for this area):** documenting a defect is not a resolution. See root [`AGENTS.md`](../AGENTS.md) § "Aspirational comments" → "The rule applies to plans, not just code".

> **Role in the consumer landscape.** This application is **a reference implementation** for mobile companion clients of the Ion Engine. It is not the canonical mobile client — third-party developers may build their own. The engine's real consumers are external. When the engine ships a feature iOS does not consume, that is the expected default; we extend iOS coverage when there is a UX or parity reason, not to validate engine surface. See root [`AGENTS.md`](../AGENTS.md) § "Engine consumers".

## View readiness principle

iOS is a thin client. The desktop snapshot is the source of truth. Every view must render with correct, complete data the moment it appears. When a user enters a conversation, the attachment badge must show the correct count, the tab status must be accurate, and all metadata must be present. No deferred loading for data the snapshot already carries.

If a badge shows "1" and then updates to "3" after a round-trip, that is a bug. The snapshot must carry all data needed to render every visible element. iOS never computes critical display values (counts, lists, status) from local partial data when the snapshot provides the authoritative answer.

Content that is expensive to transfer (file bodies, image data, full briefing text) can be loaded lazily when the user taps to view it. But the metadata (names, types, counts, identifiers) must be present in the snapshot so lists render complete and counts are accurate from the first frame.

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

**Do not defer event-surface expansion.** When a desktop feature requires iOS to react to an engine event that iOS doesn't yet decode, the proper fix is to add the event to `NormalizedEvent.swift` and handle it in the appropriate ViewModel extension. Do not create workarounds that relay rendered artifacts (e.g. sending a divider as an `engine_harness_message` instead of teaching iOS to decode the real event). Comments like "iOS does not yet act on this" describe known gaps — when a consumer arrives, close the gap.

## Contract sync (cross-language types)

Shared types (`StatusFields`, `MessageEndUsage`, etc.) are validated against the Go-generated manifest (`engine/internal/types/testdata/contracts.json`) by `IonRemoteTests/ContractSyncTests.swift`.

**When you add/change a field in a shared Swift type (`StatusFields`, `EngineMessageEndUsage`, etc.):**

1. Update the Swift struct in `Models/`.
2. Update the field coverage set in `ContractSyncTests.swift` (the `swiftHandled` set for that type).
3. Run the test target — it will fail if Go has fields you haven't accounted for.

The test also decodes representative JSON for each engine event type, catching mismatches between Go's JSON keys and Swift's `CodingKeys`. Note: `StatusFields.contextPercent` is `Double` in Swift vs `int` in Go — this is intentional (Swift `Double` decodes JSON integers).

## Notifications and resources

The iOS app is a thin client for the resource subsystem. It subscribes to resource kinds and renders them in NotificationsView (global) or the attachments panel (session-scoped).

- ResourceStore accumulates snapshot/delta events from the engine WebSocket
- NotificationsView shows workspace-level briefings with read/unread state
- Push notifications carry `ionKind` and `ionResourceId` in userInfo for deep-linking
- When the user reads a resource, iOS sends `mark_read` through the transport so the desktop reflects the change

## Done criteria

1. `make ios-check` succeeds.
2. Wire-type or crypto or networking changes: run the relevant `IonRemoteTests/` test.
3. `make check-file-sizes` passes.
4. UI changes: smoke-tested on device or simulator. Report what was tested.
5. Don't `git push`.
