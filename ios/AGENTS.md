# iOS (Swift, SwiftUI, MVVM)

iPhone companion (Ion Remote) for an Ion Studio Server. One wire: the Studio wire, reached over the local network (Bonjour) or through a relay.

## Commands

```bash
make ios            # install via commands/install.command
make ios-check      # device-target build (CI parity)
make ios-pr-check   # device-target compile, required before pushing an iOS change
make ios-test       # full local simulator suite (heavy; before push only)

cd ios && xcodebuild test -project IonRemote.xcodeproj -scheme IonRemote \
  -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:IonRemoteTests/<Suite>
```

During development run the targeted `IonRemoteTests` suite for the changed area only.

## View readiness principle

iOS is a thin client. The server's snapshot is the source of truth. Every view renders complete on first frame: badge counts, tab status, metadata. A badge that shows "1" and then "3" is a bug. iOS never computes a count, list, or status from partial local data when the snapshot carries the answer. Heavy content (file bodies, images, full briefing text) may load on tap; its metadata may not.

## Layout

```
ios/IonRemote/
  App/          entry point, AppDelegate, environment
  Crypto/       pairing crypto, ECDH, encryption (all crypto stays here)
  Models/       plain Codable data (NormalizedEvent, RemoteCommand, RemoteTabState)
  Networking/   StudioWire/ (transport, route, command mapping, pairing), OIDC, Bonjour, relay
  Services/     speech and voice
  Utilities/    cross-cutting helpers
  ViewModels/   SessionViewModel and its extensions, ResourceStore
  Views/        SwiftUI
ios/IonRemoteTests/   XCTest; mirrors the source folders
```

A new source or test file must also be added to `IonRemote.xcodeproj/project.pbxproj`, or the build never sees it. Tests belong to the `IonRemoteTests` target.

## File-architecture rules

- Cap: 600 lines per `.swift` (root `AGENTS.md` § "File-size caps"). Split with `+Extension` files (`TabListView+Helpers.swift`).
- One type per file; the filename matches the type.
- `Models/NormalizedEvent.swift` carries a file-size exception. Don't extend it; extract.

## MVVM

- Views own no business state; they observe a ViewModel (`@StateObject` / `@ObservedObject`).
- ViewModels publish state and hold no view code.
- Models are plain `Codable` data with no business logic.
- async/await throughout. Cancel with `Task` cancellation, not custom flags.
- Views send through `SessionViewModel`, never a socket.

## Logging

Logs land in `<ION_DATA_DIR>/ios-diagnostic-logs.jsonl` on the paired server's host (`component=ios`), shipped by `DiagnosticLog`.

- Always `DiagnosticLog.log()`. `print()` and `os.Logger` never reach the operator; a device in normal use has no attached console. `make check-logging` (OS-LOGGER) fails a new `Logger(subsystem:)` outside `DiagnosticLog.swift`.
- `tag` is the subsystem (`ipc`, `session`, `transport`). Context goes in `fields`, never concatenated into `msg`.
- SwiftLint (`ios/.swiftlint.yml`) errors on an empty `catch {}` and warns on a silent `try?`. A genuinely benign discard gets a comment saying why.

## Pairing and transport

`StudioTransport` carries `RemoteEvent`s in and `RemoteCommand`s out over the route `StudioRoute` picks (direct TCP on the LAN, or relay). `StudioTransportCommandMapping` turns each `RemoteCommand` into the `studio_action` or frame the server answers. Pairing is a one-time code against the server's `POST /auth/pair`; the credential lives in `StudioServerKeychainStore`.

`RemoteCommand` is a plain `Sendable` value; it does not encode itself. `RemoteCommand.TypeKey` is the shared name of each command. `StudioCommandMapTests` checks `TypeKey.allCases` against `packages/shared/src/studio-wire/phone-command-map.json`.

Tests that guard this: `E2ECryptoTests.swift` (real pairing handshakes) and `IonRemoteTests/StudioWire/` (`StudioTransportTests`, `StudioConnectionTests`, `StudioRouteTests`, `StudioCommandMapTests`).

## Wire parity and naming (ADR 008)

- `NormalizedEvent`, `RemoteCommand`, and `RemoteTabState` mirror server and engine types. Sources of truth: `engine/internal/types/normalized_event.go` and `packages/shared/src/`.
- When iOS needs an engine event it doesn't decode, add it to `NormalizedEvent.swift` and handle it in a ViewModel extension. Never relay a rendered artifact instead (e.g. a divider sent as `engine_harness_message`).
- `engine_` TypeKeys decode engine-originated events. `desktop_` TypeKeys name `RemoteCommand` / `RemoteEvent` cases; `phone-command-map.json` is keyed by them. Never mix or omit the prefix. A new `RemoteCommand` without its `desktop_*` TypeKey and map entry fails `StudioCommandMapTests`.
- Studio wire renames are lockstep: `packages/shared/src/studio-wire/` and the Swift side change together (root `AGENTS.md` § "Contract stability").
- Wire-type changes update their test fixtures.

## Vocabulary

A concept on both clients uses the same canonical term from `docs/vocabulary/terms.json` in view names, comments, logs, and plans. A Swift suffix (`StatusDrawerView`) is idiom, not a new term. Add an iOS qualifier only when iOS genuinely differs, and record it in the registry. When the clients place a concept differently, mark the entry `review-needed` and say how (e.g. iOS `ConversationStatusBar` vs the Desktop Input Bar). Naming never renames a wire string, TypeKey, or `CodingKeys` key.

## Contract sync

`IonRemoteTests/ContractSyncTests.swift` checks shared Swift types against `engine/internal/types/testdata/contracts.json` and decodes sample JSON per engine event.

1. Update the Swift struct in `Models/`.
2. Update that type's `swiftHandled` set in `ContractSyncTests.swift`.
3. Run the test; it fails if Go has a field Swift does not account for.

`StatusFields.contextPercent` is `Double` in Swift and `int` in Go on purpose.

## Resources

`ResourceStore` applies snapshots and deltas (`applySnapshot`, `applyDelta`) for NotificationsView (workspace-scoped) and the attachments panel (session-scoped). Reading an item sends `mark_read` so every client converges. Subsystem rules: [`docs/architecture/resource-subsystem.md`](../docs/architecture/resource-subsystem.md).
