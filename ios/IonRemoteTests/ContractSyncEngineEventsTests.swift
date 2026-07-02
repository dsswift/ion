// @file-size-exception: contract sync test suite — each engine event variant needs its own decode + field-set test
import XCTest
@testable import IonRemote

/// Contract tests for engine workflow events that iOS observes-only.
///
/// Extracted from ContractSyncTests.swift to keep that file under the
/// 600-line Swift cap as the engine workflow surface grows. iOS does
/// not act on any of these events — the desktop is the authoritative
/// consumer for plan proposals, early-stop decisions, and slash-command
/// registry / result — but the wire protocol stays uniform across
/// consumers, and the contract tests ensure the iOS decoders track
/// every Go-side field addition.
///
/// Events covered here:
///   - engine_plan_proposal (ADR-003)
///   - engine_early_stop_decision_request (ADR-002)
///   - engine_command_registry (snapshot semantics — agent-state.md)
///   - engine_command_result
///   - engine_model_fallback (field-set only — iOS uses snapshot path)
///
/// Plus the shared `EngineCommandListing` type that rides inside
/// engine_command_registry snapshots.
final class ContractSyncEngineEventsTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // Manifest loading is shared with ContractSyncTests; this file's
    // tests that need the manifest call into a local copy of the
    // helpers below. The duplication is intentional — keeping the
    // tests independent of the other file means either suite can run
    // in isolation (useful when debugging a single test target run
    // under Xcode's test-by-class navigator).

    private struct Manifest: Decodable {
        let normalizedEvents: [String: [String]?]
        let engineEvent: [String]
        let sharedTypes: [String: [String]]
    }

    private func loadManifest() throws -> Manifest {
        // Try repo-relative paths (Xcode sets cwd to the project root or
        // a DerivedData folder depending on the run mode).
        let candidates = [
            "../engine/internal/types/testdata/contracts.json",
            "engine/internal/types/testdata/contracts.json",
        ]
        for candidate in candidates {
            let url = URL(fileURLWithPath: candidate)
            if FileManager.default.fileExists(atPath: url.path) {
                let data = try Data(contentsOf: url)
                return try JSONDecoder().decode(Manifest.self, from: data)
            }
        }

        // Fallback: search up from the source file location. Robust against
        // simulator runs whose cwd lives inside DerivedData rather than the
        // repo. Walks up to five parent directories looking for the
        // manifest under its canonical repo-relative path.
        var dir = URL(fileURLWithPath: #file).deletingLastPathComponent()
        for _ in 0..<5 {
            dir = dir.deletingLastPathComponent()
            let candidate = dir
                .appendingPathComponent("engine/internal/types/testdata/contracts.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let data = try Data(contentsOf: candidate)
                return try JSONDecoder().decode(Manifest.self, from: data)
            }
        }

        throw NSError(domain: "ContractSyncEngineEventsTests", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "could not locate contracts.json — searched cwd-relative and #file-relative paths"
        ])
    }


    // MARK: - EngineCommandListing decode

    /// EngineCommandListing rides inside engine_command_registry snapshots
    /// emitted by the engine when a session's extension command set changes.
    /// iOS does not yet consume the registry for autocomplete (see Phase 0.5
    /// of the unified slash-pipeline plan — iOS UI is intentionally out of
    /// scope for that change), but the contract must stay in sync so future
    /// iOS work picks up the type cleanly. Test verifies the shape decodes
    /// and all Go fields are tracked.
    func testEngineCommandListingDecode() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.sharedTypes["EngineCommandListing"] else {
            XCTFail("EngineCommandListing not found in Go manifest")
            return
        }

        let swiftHandled: Set<String> = [
            "name", "description",
        ]
        let goSet = Set(goFields)
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go EngineCommandListing has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

    // MARK: - PlanProposalEvent decode

    /// The engine emits engine_plan_proposal when the model proposes a
    /// plan-mode transition (currently only kind="exit"). iOS doesn't act
    /// on this event — the desktop is the authoritative consumer that
    /// renders the approval card — but the wire protocol stays uniform
    /// across consumers by decoding it cleanly. Test verifies the shape
    /// decodes and the field set matches the Go-side manifest.
    func testPlanProposalDecode() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.normalizedEvents["plan_proposal"] else {
            XCTFail("plan_proposal not found in Go manifest")
            return
        }

        let json = """
        {
            "type": "desktop_plan_proposal",
            "tabId": "t1",
            "instanceId": "i1",
            "planProposalKind": "exit",
            "planFilePath": "/home/user/.ion/plans/happy-jumping-rabbit.md",
            "planSlug": "happy-jumping-rabbit"
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .enginePlanProposal(let tabId, let instanceId, let kind, let path, let slug) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(kind, "exit")
            XCTAssertEqual(path, "/home/user/.ion/plans/happy-jumping-rabbit.md")
            XCTAssertEqual(slug, "happy-jumping-rabbit")
        } else {
            XCTFail("Expected enginePlanProposal, got \(event)")
        }

        // The Swift case uses the wire field name "planProposalKind" for the
        // discriminator (mirroring the Go flat EngineEvent layout) but the
        // NormalizedEvent variant — which is what the manifest tracks — uses
        // the plain "kind" field name on the variant struct. Track both names
        // here because the wire shape is what iOS decodes off the socket.
        let swiftHandled: Set<String> = [
            "kind", "planFilePath", "planSlug",
        ]
        let goSet = Set(goFields ?? [])
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go plan_proposal has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

    // MARK: - PlanModeAutoExitEvent decode

    /// The engine emits engine_plan_mode_auto_exit when it
    /// deterministically synthesizes an ExitPlanMode call at end-of-turn
    /// because the model misrouted plan exit (issue #187). Sibling to
    /// engine_plan_proposal — both surface the plan-approval card, but
    /// this event additionally tells consumers the exit was
    /// engine-driven rather than model-driven. iOS does not act on this
    /// event today (the desktop is the authoritative consumer), but
    /// decoding cleanly here keeps the wire protocol uniform across
    /// consumers and lets a future iOS surface (e.g. a "Plan surfaced
    /// automatically" hint) read the full payload without contract
    /// changes.
    func testPlanModeAutoExitDecode() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.normalizedEvents["plan_mode_auto_exit"] else {
            XCTFail("plan_mode_auto_exit not found in Go manifest")
            return
        }

        let json = """
        {
            "type": "desktop_plan_mode_auto_exit",
            "tabId": "t1",
            "instanceId": "i1",
            "planModeAutoExitStopReason": "end_turn",
            "planFilePath": "/home/user/.ion/plans/happy-jumping-rabbit.md",
            "planSlug": "happy-jumping-rabbit",
            "planModeAutoExitReason": "engine-synthesized: run ended in plan mode without ExitPlanMode call",
            "planModeAutoExitSessionId": "sess-42",
            "planModeAutoExitRunId": "run-99"
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .enginePlanModeAutoExit(let tabId, let instanceId, let stopReason, let path, let slug, let reason, let sessionId, let runId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(stopReason, "end_turn")
            XCTAssertEqual(path, "/home/user/.ion/plans/happy-jumping-rabbit.md")
            XCTAssertEqual(slug, "happy-jumping-rabbit")
            XCTAssertEqual(reason, "engine-synthesized: run ended in plan mode without ExitPlanMode call")
            XCTAssertEqual(sessionId, "sess-42")
            XCTAssertEqual(runId, "run-99")
        } else {
            XCTFail("Expected enginePlanModeAutoExit, got \(event)")
        }

        // Swift tracks the NormalizedEvent variant field names verbatim
        // (the manifest's `plan_mode_auto_exit` entry uses the un-prefixed
        // tags from the PlanModeAutoExitEvent struct). The iOS wire-side
        // CodingKeys use planModeAutoExit* prefixes for collision-free
        // decoding, but the contract manifest tracks the variant struct
        // — which is what consumers reason about logically.
        let swiftHandled: Set<String> = [
            "stopReason", "planFilePath", "planSlug",
            "reason", "sessionId", "runId",
        ]
        let goSet = Set(goFields ?? [])
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go plan_mode_auto_exit has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

    // MARK: - EarlyStopDecisionRequest decode

    /// The engine emits engine_early_stop_decision_request as the wire-
    /// protocol surface for the `before_early_stop_decision` extension
    /// hook, promoting it to a request/response cycle a socket-only
    /// harness can participate in. The desktop's early-stop-policy.ts is
    /// the authoritative responder via the `early_stop_decision_response`
    /// client command; iOS observes the event for diagnostic visibility
    /// only.
    ///
    /// This test locks in the full payload decode — every field the
    /// Go-side EarlyStopDecisionRequestEvent emits must round-trip
    /// through the iOS Swift decoder without loss so a future iOS
    /// surface for the event (e.g. a "model nudged" status indicator)
    /// can read the complete record without contract changes.

    // MARK: - RunStalledEvent decode

    /// The engine emits engine_run_stalled when the progress watchdog
    /// detects no forward progress for longer than the configured
    /// threshold. Advisory only; the authoritative completion signal is
    /// the follow-up engine_task_complete. iOS decodes the event via
    /// NormalizedEvent.swift CodingKeys; this test pins the wire format.
    func testRunStalledDecode() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.normalizedEvents["run_stalled"] else {
            XCTFail("run_stalled not found in Go manifest")
            return
        }

        let json = """
        {
            "type": "desktop_run_stalled",
            "tabId": "t1",
            "instanceId": "i1",
            "runStalledDuration": 45.2,
            "runStalledLastActivity": "provider stream chunk"
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineRunStalled(let tabId, let instanceId, let stalledDuration, let lastActivity) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(stalledDuration, 45.2, accuracy: 0.001)
            XCTAssertEqual(lastActivity, "provider stream chunk")
        } else {
            XCTFail("Expected engineRunStalled, got \(event)")
        }

        let swiftHandled: Set<String> = [
            "stalledDuration", "lastActivity",
        ]
        let goSet = Set(goFields ?? [])
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go run_stalled has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

    // MARK: - ModelFallbackEvent field-set

    /// The engine emits engine_model_fallback when the provider falls back
    /// to a different model than the one originally requested. iOS does NOT
    /// decode this as a live RemoteEvent — it consumes the information via
    /// the snapshot path instead (EngineInstanceModelFallback in
    /// RemoteTabState). This test validates only that the Swift-tracked
    /// field set stays in sync with the Go manifest so that any future
    /// decoder or snapshot consumer picks up new fields without a silent
    /// contract drift.
    func testModelFallbackFieldSetMatchesManifest() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.normalizedEvents["model_fallback"] else {
            XCTFail("model_fallback not found in Go manifest")
            return
        }

        // iOS uses the snapshot path (EngineInstanceModelFallback in
        // RemoteTabState), not live event decoding. This set tracks the
        // Go-side NormalizedEvent variant fields so a manifest addition
        // triggers a test failure and prompts an iOS-side review.
        let swiftTracked: Set<String> = [
            "fallbackModel", "reason", "requestedModel",
        ]
        let goSet = Set(goFields ?? [])
        let untracked = goSet.subtracting(swiftTracked)
        XCTAssert(
            untracked.isEmpty,
            "Go model_fallback has fields not tracked in Swift test: \(untracked.sorted())"
        )
    }

    func testEngineEarlyStopDecisionRequestDecode() throws {
        let json = """
        {
            "type": "desktop_early_stop_decision_request",
            "tabId": "t1",
            "instanceId": "inst-a",
            "earlyStopRequestId": "req-42",
            "earlyStopRunId": "run-abc",
            "earlyStopModel": "claude-sonnet-4-6",
            "earlyStopTurnNumber": 3,
            "earlyStopStopReason": "end_turn",
            "earlyStopCumulativeOutput": 7200,
            "earlyStopBudget": 8000,
            "earlyStopThresholdPct": 90,
            "earlyStopContinuationCount": 1,
            "earlyStopMaxContinuations": 3,
            "earlyStopLastContinuationDelta": 500,
            "earlyStopWouldContinue": true,
            "earlyStopIsSubagent": false
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineEarlyStopDecisionRequest(
            let tabId,
            let instanceId,
            let requestId,
            let runId,
            let model,
            let turnNumber,
            let stopReason,
            let cumulativeOutput,
            let budget,
            let thresholdPct,
            let continuationCount,
            let maxContinuations,
            let lastContinuationDelta,
            let wouldContinue,
            let isSubagent
        ) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "inst-a")
            XCTAssertEqual(requestId, "req-42")
            XCTAssertEqual(runId, "run-abc")
            XCTAssertEqual(model, "claude-sonnet-4-6")
            XCTAssertEqual(turnNumber, 3)
            XCTAssertEqual(stopReason, "end_turn")
            XCTAssertEqual(cumulativeOutput, 7200)
            XCTAssertEqual(budget, 8000)
            XCTAssertEqual(thresholdPct, 90)
            XCTAssertEqual(continuationCount, 1)
            XCTAssertEqual(maxContinuations, 3)
            XCTAssertEqual(lastContinuationDelta, 500)
            XCTAssertTrue(wouldContinue)
            XCTAssertFalse(isSubagent)
        } else {
            XCTFail("Expected engineEarlyStopDecisionRequest, got \(event)")
        }
    }

    /// Negative-control test: when the wire payload omits the early-stop
    /// detail fields (the Go side ships every field as omitempty), the
    /// Swift decoder must default missing values to zero/empty rather
    /// than failing the decode. This is the same forward-compatibility
    /// posture the other engine variants take.
    func testEngineEarlyStopDecisionRequestDecodeMinimal() throws {
        let json = """
        {
            "type": "desktop_early_stop_decision_request",
            "tabId": "t1"
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineEarlyStopDecisionRequest(
            let tabId,
            let instanceId,
            let requestId,
            let runId,
            let model,
            let turnNumber,
            _, // stopReason
            let cumulativeOutput,
            let budget,
            _, // thresholdPct
            _, // continuationCount
            _, // maxContinuations
            _, // lastContinuationDelta
            let wouldContinue,
            let isSubagent
        ) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
            XCTAssertEqual(requestId, "")
            XCTAssertEqual(runId, "")
            XCTAssertEqual(model, "")
            XCTAssertEqual(turnNumber, 0)
            XCTAssertEqual(cumulativeOutput, 0)
            XCTAssertEqual(budget, 0)
            XCTAssertFalse(wouldContinue)
            XCTAssertFalse(isSubagent)
        } else {
            XCTFail("Expected engineEarlyStopDecisionRequest, got \(event)")
        }
    }

    // MARK: - engine_command_registry decode

    /// Snapshot of the session's extension-registered slash commands.
    /// Test verifies (a) the wire payload decodes into the iOS variant
    /// with both `tabId` and `instanceId` correlators preserved, (b)
    /// the nested `EngineCommandListing` array round-trips with the
    /// optional `description` field intact, (c) the empty-commands
    /// case decodes cleanly as the authoritative "no extension
    /// commands" snapshot signal.
    func testEngineCommandRegistryDecode() throws {
        let json = """
        {
            "type": "desktop_command_registry",
            "tabId": "t1",
            "instanceId": "inst-a",
            "commands": [
                { "name": "clear", "description": "Reset the conversation context." },
                { "name": "ion--review-changes", "description": "Run a pre-PR review on the working tree." },
                { "name": "no-desc-cmd" }
            ]
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineCommandRegistry(let tabId, let instanceId, let commands) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "inst-a")
            XCTAssertEqual(commands.count, 3)
            XCTAssertEqual(commands[0].name, "clear")
            XCTAssertEqual(commands[0].description, "Reset the conversation context.")
            XCTAssertEqual(commands[1].name, "ion--review-changes")
            XCTAssertEqual(commands[2].name, "no-desc-cmd")
            XCTAssertNil(commands[2].description)
        } else {
            XCTFail("Expected engineCommandRegistry, got \(event)")
        }
    }

    /// Empty commands array decodes as the authoritative "no extension
    /// commands for this session" signal. Pinning this case prevents a
    /// well-intentioned future decoder optimization from skipping the
    /// payload when `commands` is empty.
    func testEngineCommandRegistryDecodeEmpty() throws {
        let json = """
        {
            "type": "desktop_command_registry",
            "tabId": "t1",
            "instanceId": "inst-a",
            "commands": []
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineCommandRegistry(_, _, let commands) = event {
            XCTAssertEqual(commands.count, 0, "empty commands array must decode as the snapshot signal — never as nil")
        } else {
            XCTFail("Expected engineCommandRegistry, got \(event)")
        }
    }

    // MARK: - engine_command_result decode

    /// Result of an engine SendCommand dispatch. Test verifies the
    /// three independently-optional payload fields (message, command,
    /// commandError) decode in each useful permutation: full success
    /// (no error), failure (commandError set), and the absent-fields
    /// case (engine emitted only the bare type + tabId).
    func testEngineCommandResultDecode() throws {
        // Success path: command resolved cleanly, no error, optional
        // message present.
        let successJson = """
        {
            "type": "desktop_command_result",
            "tabId": "t1",
            "instanceId": "inst-a",
            "message": "Cleared 8 conversation turns.",
            "command": "clear"
        }
        """.data(using: .utf8)!
        let successEvent = try decoder.decode(RemoteEvent.self, from: successJson)
        if case .engineCommandResult(let tabId, let instanceId, let message, let command, let commandError) = successEvent {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "inst-a")
            XCTAssertEqual(message, "Cleared 8 conversation turns.")
            XCTAssertEqual(command, "clear")
            XCTAssertNil(commandError)
        } else {
            XCTFail("Expected engineCommandResult (success), got \(successEvent)")
        }

        // Failure path: extension threw or unknown command.
        let failureJson = """
        {
            "type": "desktop_command_result",
            "tabId": "t1",
            "command": "not-a-real-command",
            "commandError": "unknown_command"
        }
        """.data(using: .utf8)!
        let failureEvent = try decoder.decode(RemoteEvent.self, from: failureJson)
        if case .engineCommandResult(_, let instanceId, let message, let command, let commandError) = failureEvent {
            XCTAssertNil(instanceId)
            XCTAssertNil(message)
            XCTAssertEqual(command, "not-a-real-command")
            XCTAssertEqual(commandError, "unknown_command")
        } else {
            XCTFail("Expected engineCommandResult (failure), got \(failureEvent)")
        }

        // Minimal path: engine emitted only the type + tab. Decoder
        // must still produce a valid variant (all three payload
        // fields are independently optional per the wire contract).
        let minimalJson = """
        {
            "type": "desktop_command_result",
            "tabId": "t1"
        }
        """.data(using: .utf8)!
        let minimalEvent = try decoder.decode(RemoteEvent.self, from: minimalJson)
        if case .engineCommandResult(let tabId, let instanceId, let message, let command, let commandError) = minimalEvent {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
            XCTAssertNil(message)
            XCTAssertNil(command)
            XCTAssertNil(commandError)
        } else {
            XCTFail("Expected engineCommandResult (minimal), got \(minimalEvent)")
        }
    }

    // MARK: - Extended-thinking events (issue #158)

    /// thinking_block_start carries no payload beyond the standard tabId /
    /// instanceId correlators — its arrival is the signal. Verify it decodes
    /// into the iOS variant and that the Go manifest entry has no fields the
    /// Swift side must track (it is `null` / empty in the manifest).
    func testThinkingBlockStartDecode() throws {
        let manifest = try loadManifest()
        // thinking_block_start has no payload fields; the manifest entry is
        // null (Go ThinkingBlockStartEvent is an empty struct). Assert we
        // tracked that — a future field addition would make this non-nil.
        let goFields = manifest.normalizedEvents["thinking_block_start"] ?? nil
        XCTAssertTrue(
            (goFields ?? []).isEmpty,
            "Go thinking_block_start gained fields the Swift decoder ignores: \((goFields ?? []).sorted())"
        )

        let json = """
        {
            "type": "desktop_thinking_block_start",
            "tabId": "t1",
            "instanceId": "i1"
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineThinkingBlockStart(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Expected engineThinkingBlockStart, got \(event)")
        }
    }

    /// thinking_block_start with no instanceId (CLI-tab / nil emitter) must
    /// still decode — instanceId is optional on the wire.
    func testThinkingBlockStartDecodeNoInstance() throws {
        let json = """
        {"type":"desktop_thinking_block_start","tabId":"t1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineThinkingBlockStart(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
        } else {
            XCTFail("Expected engineThinkingBlockStart, got \(event)")
        }
    }

    /// thinking_delta carries the incremental reasoning text on `thinkingText`
    /// (the desktop's projection of the engine's bare `text` field). Verify
    /// the payload decodes and the manifest's field set is tracked.
    func testThinkingDeltaDecode() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.normalizedEvents["thinking_delta"] else {
            XCTFail("thinking_delta not found in Go manifest")
            return
        }

        let json = """
        {
            "type": "desktop_thinking_delta",
            "tabId": "t1",
            "instanceId": "i1",
            "thinkingText": "Let me reason about this step by step."
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineThinkingDelta(let tabId, let instanceId, let text) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(text, "Let me reason about this step by step.")
        } else {
            XCTFail("Expected engineThinkingDelta, got \(event)")
        }

        // Manifest tracks the engine variant's bare field name ("text"); the
        // iOS wire key is "thinkingText" (desktop projection). Track the bare
        // name so a Go field addition trips this test.
        let swiftHandled: Set<String> = ["text"]
        let goSet = Set(goFields ?? [])
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go thinking_delta has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

    /// thinking_block_end with the full summary present (the delta-streaming,
    /// non-redacted case). All three summary fields decode, and the Go
    /// manifest field set is tracked.
    func testThinkingBlockEndDecodeFull() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.normalizedEvents["thinking_block_end"] else {
            XCTFail("thinking_block_end not found in Go manifest")
            return
        }

        let json = """
        {
            "type": "desktop_thinking_block_end",
            "tabId": "t1",
            "instanceId": "i1",
            "thinkingTotalTokens": 412,
            "thinkingElapsedSeconds": 14.5,
            "thinkingRedacted": false
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineThinkingBlockEnd(let tabId, let instanceId, let tokens, let elapsed, let redacted) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(tokens, 412)
            XCTAssertEqual(elapsed ?? 0, 14.5, accuracy: 0.001)
            XCTAssertEqual(redacted, false)
        } else {
            XCTFail("Expected engineThinkingBlockEnd, got \(event)")
        }

        // Manifest tracks the engine variant's bare names (elapsedSeconds /
        // redacted / totalTokens); the iOS wire keys carry the thinking
        // prefix (desktop projection). Track the bare names.
        let swiftHandled: Set<String> = ["elapsedSeconds", "redacted", "totalTokens"]
        let goSet = Set(goFields ?? [])
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go thinking_block_end has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

    /// thinking_block_end with ALL summary fields absent (older desktop, or
    /// the engine had no authoritative token count). decodeIfPresent must
    /// leave them nil rather than fail or invent zeros — this is the
    /// forward-compat posture for the optional fields.
    func testThinkingBlockEndDecodeMinimal() throws {
        let json = """
        {"type":"desktop_thinking_block_end","tabId":"t1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineThinkingBlockEnd(let tabId, let instanceId, let tokens, let elapsed, let redacted) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
            XCTAssertNil(tokens)
            XCTAssertNil(elapsed)
            XCTAssertNil(redacted)
        } else {
            XCTFail("Expected engineThinkingBlockEnd, got \(event)")
        }
    }

    /// thinking_block_end for a redacted (encrypted) reasoning block: only
    /// `thinkingRedacted` is set; tokens/elapsed may be absent. The decoder
    /// must surface redacted=true so the UI shows "🔒 redacted reasoning".
    func testThinkingBlockEndDecodeRedacted() throws {
        let json = """
        {
            "type": "desktop_thinking_block_end",
            "tabId": "t1",
            "instanceId": "i1",
            "thinkingRedacted": true
        }
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineThinkingBlockEnd(_, _, let tokens, let elapsed, let redacted) = event {
            XCTAssertNil(tokens)
            XCTAssertNil(elapsed)
            XCTAssertEqual(redacted, true)
        } else {
            XCTFail("Expected engineThinkingBlockEnd (redacted), got \(event)")
        }
    }

    /// Round-trip: encode a block_end with NO summary fields, decode it back,
    /// and assert the absent fields stay absent (nil) — i.e. the encoder uses
    /// encodeIfPresent so a legacy-desktop event never gains spurious JSON
    /// nulls on re-encode. This pins the forward-compat contract.
    func testThinkingBlockEndRoundTripAbsentFieldsStayAbsent() throws {
        let original = RemoteEvent.engineThinkingBlockEnd(
            tabId: "t1",
            instanceId: nil,
            thinkingTotalTokens: nil,
            thinkingElapsedSeconds: nil,
            thinkingRedacted: nil
        )
        let data = try encoder.encode(original)

        // Inspect the raw JSON: the optional keys must be absent entirely.
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(obj)
        XCTAssertNil(obj?["instanceId"], "absent instanceId must not encode")
        XCTAssertNil(obj?["thinkingTotalTokens"], "absent tokens must not encode")
        XCTAssertNil(obj?["thinkingElapsedSeconds"], "absent elapsed must not encode")
        XCTAssertNil(obj?["thinkingRedacted"], "absent redacted must not encode")

        // And the decode round-trips back to all-nil.
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .engineThinkingBlockEnd(let tabId, let instanceId, let tokens, let elapsed, let redacted) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
            XCTAssertNil(tokens)
            XCTAssertNil(elapsed)
            XCTAssertNil(redacted)
        } else {
            XCTFail("Expected engineThinkingBlockEnd round-trip, got \(decoded)")
        }
    }

    /// Round-trip with the summary fields PRESENT: encode → decode must
    /// preserve every value (no widening / truncation of the token Int or
    /// elapsed Double).
    func testThinkingBlockEndRoundTripPresentFields() throws {
        let original = RemoteEvent.engineThinkingBlockEnd(
            tabId: "t1",
            instanceId: "i1",
            thinkingTotalTokens: 412,
            thinkingElapsedSeconds: 14.5,
            thinkingRedacted: true
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .engineThinkingBlockEnd(_, let instanceId, let tokens, let elapsed, let redacted) = decoded {
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(tokens, 412)
            XCTAssertEqual(elapsed ?? 0, 14.5, accuracy: 0.001)
            XCTAssertEqual(redacted, true)
        } else {
            XCTFail("Expected engineThinkingBlockEnd round-trip, got \(decoded)")
        }
    }

    // MARK: - engine_tool_update / engine_tool_complete / engine_schedule_fired / engine_llm_call / engine_dispatch_start

    func testEngineToolUpdateDecode() throws {
        let json = """
        {"type":"desktop_tool_update","tabId":"t1","instanceId":"i1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineToolUpdate(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Expected engineToolUpdate")
        }
    }

    func testEngineToolCompleteDecode() throws {
        let json = """
        {"type":"desktop_tool_complete","tabId":"t1","instanceId":"i1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineToolComplete(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Expected engineToolComplete")
        }
    }

    func testEngineScheduleFiredDecode() throws {
        let json = """
        {"type":"desktop_schedule_fired","tabId":"t1","instanceId":"i1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineScheduleFired(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Expected engineScheduleFired")
        }
    }

    func testEngineLlmCallDecode() throws {
        let json = """
        {"type":"desktop_llm_call","tabId":"t1","instanceId":"i1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineLlmCall(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Expected engineLlmCall")
        }
    }

    func testEngineDispatchStartDecode() throws {
        let json = """
        {"type":"desktop_dispatch_start","tabId":"t1","instanceId":"i1","dispatchAgent":"agent-a","dispatchSessionId":"sess-1","dispatchModel":"opus","dispatchTask":"do stuff","dispatchDepth":2,"dispatchParentId":"parent-123","dispatchId":"id-abc"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineDispatchStart(let tabId, let instanceId, let agent, let sessionId, let model, let task, let depth, let parentId, let dispatchId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(agent, "agent-a")
            XCTAssertEqual(sessionId, "sess-1")
            XCTAssertEqual(model, "opus")
            XCTAssertEqual(task, "do stuff")
            XCTAssertEqual(depth, 2)
            XCTAssertEqual(parentId, "parent-123")
            XCTAssertEqual(dispatchId, "id-abc")
        } else {
            XCTFail("Expected engineDispatchStart")
        }
    }

    func testEngineDispatchEndDecode() throws {
        let json = """
        {"type":"desktop_dispatch_end","tabId":"t1","instanceId":"i1","dispatchAgent":"agent-a","dispatchDepth":1,"dispatchParentId":"","dispatchExitCode":0,"dispatchElapsed":3.5,"dispatchId":"id-xyz","dispatchConversationId":"conv-1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineDispatchEnd(let tabId, let instanceId, let agent, let depth, let parentId, let exitCode, let elapsed, let dispatchId, let conversationId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(agent, "agent-a")
            XCTAssertEqual(depth, 1)
            XCTAssertEqual(parentId, "")
            XCTAssertEqual(exitCode, 0)
            XCTAssertEqual(elapsed, 3.5, accuracy: 0.01)
            XCTAssertEqual(dispatchId, "id-xyz")
            XCTAssertEqual(conversationId, "conv-1")
        } else {
            XCTFail("Expected engineDispatchEnd")
        }
    }

    func testEngineDispatchEndDecodeNoConversationId() throws {
        // dispatchConversationId is optional — absent on dispatches that don't
        // create a child conversation (e.g. tool-only dispatches).
        let json = """
        {"type":"desktop_dispatch_end","tabId":"t1","dispatchAgent":"a","dispatchDepth":0,"dispatchParentId":"","dispatchExitCode":1,"dispatchElapsed":0.5,"dispatchId":"id-gamma"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineDispatchEnd(_, _, _, _, _, _, _, let dispatchId, let conversationId) = event {
            XCTAssertEqual(dispatchId, "id-gamma")
            XCTAssertNil(conversationId)
        } else {
            XCTFail("Expected engineDispatchEnd (no conversationId)")
        }
    }

}
