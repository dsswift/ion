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
- Wire-format changes (`NormalizedEvent`, `RemoteCommand`, `RemoteTabState`) must update the corresponding test fixtures.
- Crypto changes must keep `E2ECryptoTests.swift` passing — it round-trips real pairing handshakes.
- Network changes must keep `RelayClientTests.swift` and `TransportManagerTests.swift` green.

## MVVM

- Views own no business state. Observe a ViewModel via `@StateObject` / `@ObservedObject`.
- ViewModels publish state. No view code in them.
- Models are plain data. `Codable` for wire types. No business logic.
- Networking: async/await throughout. Cancellation via `Task` cancellation, not custom flags.
- Crypto isolated under `Crypto/`. Don't inline crypto operations elsewhere.

## Logging

iOS logs write to `~/.ion/ios-diagnostic-logs.jsonl` on the paired desktop in the canonical Ion JSONL schema (`component=ios`). The file arrives via the `DiagnosticLog` transport — **always use `DiagnosticLog.log()`, never `print()`**. The iOS device runs without an attached Xcode console in normal use; `print()` output is invisible. `DiagnosticLog.log()` is the only path that reaches the desktop log file.

`tag` = Swift subsystem label (e.g. `ipc`, `session`, `transport`). Structured context goes in the `fields` map; do not concatenate it into `msg`.

**`os.Logger` (e.g. a `private let ionLog = Logger(subsystem:...)`) does NOT reach the operator.** It writes to Apple's unified logging (Console.app only), which is invisible on a device with no attached Xcode session. Every error/warn path that matters must go through `DiagnosticLog.log(..., level: .warn/.error)`. A `grep`-based CI check forbids new `os.Logger`/`Logger(subsystem:` usage outside a narrow allowlist; SwiftLint (`ios/.swiftlint.yml`) flags empty `catch {}` (`empty_catch_block`, error) and discourages silent `try?` (`silent_try_optional`, warning).

**No silent failures** (see root [`AGENTS.md`](../AGENTS.md) § "Logging policy → No silent failures"): an empty `catch {}` or a `try?` that discards an error on a path where the failure matters is a defect. Route the error through `DiagnosticLog.log`, or — if the failure is genuinely benign (cancellation, an expected-absent optional) — say so in a comment inside the `catch`. Silence with no reason is never acceptable.

See root [`AGENTS.md`](../AGENTS.md) § "Logging policy" for file locations, `jq` recipes, and LogQL cheat-sheet.

## Pairing/transport

LAN and relay share `RemoteCommand` and `RemoteTabState`. Pairing is ECDH; shared secret derives an AES key. Transport switching (LAN ↔ relay) via the transport manager. Don't bypass it from views.

## Wire-protocol parity and naming (ADR 008)

iOS models (`NormalizedEvent`, `RemoteCommand`, `RemoteTabState`) mirror desktop/engine wire types. When the engine adds an event variant or field, the iOS Swift type must add it too — otherwise relay/LAN messages decode incorrectly. Source of truth: `engine/internal/types/normalized_event.go` and `desktop/src/shared/types.ts`.

**Do not defer event-surface expansion.** When a desktop feature requires iOS to react to an engine event that iOS doesn't yet decode, the proper fix is to add the event to `NormalizedEvent.swift` and handle it in the appropriate ViewModel extension. Do not create workarounds that relay rendered artifacts (e.g. sending a divider as an `engine_harness_message` instead of teaching iOS to decode the real event). Comments like "iOS does not yet act on this" describe known gaps — when a consumer arrives, close the gap.

### Wire naming rule

Two distinct prefixes exist on the iOS side:

- **`engine_`** — events from the engine NDJSON socket. TypeKey raw values in `NormalizedEvent.swift` that decode engine-originated events use this prefix.
- **`desktop_`** — events on the desktop↔iOS wire (`RemoteCommand`, `RemoteEvent`). The desktop owns this wire; iOS mirrors it. TypeKey raw values for `RemoteCommand`/`RemoteEvent` decode use the `desktop_` prefix.

Do not introduce TypeKey raw values that mix these prefixes or omit them entirely. When the desktop renames a `RemoteEvent` member from an old prefix to `desktop_*`, update the corresponding Swift TypeKey in the same PR (lockstep rule).

### Lockstep model

The desktop↔iOS wire operates under a **lockstep model**: every wire rename ships to all clients in one PR. There is no window where the desktop has the new string and iOS still expects the old one. When reviewing or implementing a desktop↔iOS rename, do not treat it as a published-contract break — it is a parity obligation. The required gate is: `protocol.ts` and the Swift TypeKey raw values are updated together.

See root `AGENTS.md` § "Contract stability" and [docs/architecture/adr/008-wire-event-naming-and-ownership.md](../docs/architecture/adr/008-wire-event-naming-and-ownership.md).

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
- The relay includes `ionKind` and `ionResourceId` in the APNs payload. `AppDelegate.swift` currently deep-links to a tab via `tabId` only; resource-level deep-linking using `ionResourceId` is not yet implemented.
- When the user reads a resource, iOS sends `mark_read` through the transport so the desktop reflects the change

## Done criteria

`make ios-check` is a full `xcodebuild` — a heavy gate. Do not run it repeatedly while iterating. While developing, rely on targeted `IonRemoteTests/` tests for the area you touched; the full build runs at PR time — CI builds the iOS app on every PR, and the user may run `make ios-check` locally before pushing. (It is **not** part of `make test-linux`, which is Linux-only, so `/create-pr` does not run it.) See root [`AGENTS.md`](../AGENTS.md) § "Heavy gates — never run during development".

1. Wire-type or crypto or networking changes: run the relevant `IonRemoteTests/` test (scoped — fine during development).
2. `make check-file-sizes` passes.
3. UI changes: smoke-tested on device or simulator. Report what was tested.
4. `make ios-check` — heavy full build. CI runs it on the PR; the user may run it locally before pushing. Don't run it repeatedly while iterating.
5. Don't `git push`.
