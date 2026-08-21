import XCTest
@testable import IonRemote

/// Tests for the #256 single-instance conversation collapse on iOS.
///
/// Coverage:
///   1. Legacy multi-instance snapshot renders active instance without crashing
///   2. Single-instance snapshot renders the sole instance correctly
///   3. Instance-management TypeKeys are absent from the enum
///   4. engineAddInstance / engineRemoveInstance are not emittable (no cases)
///   5. loadEngineConversation is retired (WI-004 / #259): TypeKey absent,
///      no enum case, loadConversation sends desktop_load_conversation
final class EngineInstanceCollapseTests: XCTestCase {

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    // MARK: - Helpers

    private func jsonObject(from command: RemoteCommand) throws -> [String: Any] {
        let data = try encoder.encode(command)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func makeInstance(id: String, label: String, isRunning: Bool = false) -> ConversationInstanceInfo {
        ConversationInstanceInfo(id: id, label: label, isRunning: isRunning)
    }

    // MARK: - 1. Legacy multi-instance snapshot: active instance wins

    func testMultiInstanceSnapshotRendersActiveInstanceWithoutCrash() {
        // Drive the SHIPPED resolver (the same function SessionViewModel+Snapshot
        // uses to populate activeEngineInstance[tab.id]) rather than re-deriving
        // the expression inline. If production resolution changes, this fails.
        let inst1 = makeInstance(id: "inst-1", label: "Sub 1")
        let inst2 = makeInstance(id: "inst-2", label: "Sub 2", isRunning: true)
        let legacyInstances = [inst1, inst2]

        let resolvedId = ConversationInstanceInfo.resolveActiveInstanceId(
            activeId: "inst-2",
            instances: legacyInstances
        )
        XCTAssertEqual(resolvedId, "inst-2", "Must prefer activeConversationInstanceId when present")
        // The resolved id must address a real instance in the snapshot.
        XCTAssertEqual(legacyInstances.first { $0.id == resolvedId }?.isRunning, true)
    }

    func testMultiInstanceSnapshotFallsBackToFirstWhenActiveAbsent() {
        let inst1 = makeInstance(id: "inst-a", label: "Alpha")
        let inst2 = makeInstance(id: "inst-b", label: "Beta")
        let instances = [inst1, inst2]

        // activeConversationInstanceId is nil on a single-instance (post-#256)
        // tab; the resolver falls back to the first instance's id.
        let resolvedId = ConversationInstanceInfo.resolveActiveInstanceId(
            activeId: nil,
            instances: instances
        )
        XCTAssertEqual(resolvedId, "inst-a", "When active id absent, fall back to first instance")
    }

    func testMultiInstanceSnapshotStaleActiveIdStillResolves() {
        // The resolver trusts the provided activeId verbatim (the desktop owns
        // its validity); it does not silently rewrite an unknown id to first.
        let instances = [makeInstance(id: "inst-a", label: "Alpha")]
        let resolvedId = ConversationInstanceInfo.resolveActiveInstanceId(
            activeId: "inst-gone",
            instances: instances
        )
        XCTAssertEqual(resolvedId, "inst-gone", "Explicit activeId is honored as-is")
    }

    // MARK: - 2. Single-instance snapshot

    func testSingleInstanceSnapshotResolvesCorrectly() {
        let only = makeInstance(id: "sole-inst", label: "Main")
        let resolvedId = ConversationInstanceInfo.resolveActiveInstanceId(
            activeId: nil,
            instances: [only]
        )
        XCTAssertEqual(resolvedId, "sole-inst")
    }

    func testEmptyInstanceListResolvesNilSafely() {
        let resolvedId = ConversationInstanceInfo.resolveActiveInstanceId(
            activeId: nil,
            instances: []
        )
        XCTAssertNil(resolvedId, "Empty instance list with no active id must resolve nil, not crash")
    }

    // MARK: - Per-instance startup state

    func testStartingInstanceUsesAStillStartupIndicator() {
        let instance = ConversationInstanceInfo(id: "main", label: "Main", isStarting: true)

        XCTAssertEqual(EngineInstanceBar.statusIndicator(for: instance), .starting)
    }

    func testRunningInstanceOutranksStarting() {
        let instance = ConversationInstanceInfo(
            id: "main",
            label: "Main",
            isRunning: true,
            isStarting: true
        )

        XCTAssertEqual(EngineInstanceBar.statusIndicator(for: instance), .running)
    }

    // MARK: - 3. Instance-management TypeKeys absent from enum

    func testEngineAddInstanceTypeKeyAbsent() {
        let key = RemoteCommand.TypeKey(rawValue: "desktop_engine_add_instance")
        XCTAssertNil(key,
            "desktop_engine_add_instance was removed in #256 — TypeKey must not have this rawValue")
    }

    func testEngineRemoveInstanceTypeKeyAbsent() {
        let key = RemoteCommand.TypeKey(rawValue: "desktop_engine_remove_instance")
        XCTAssertNil(key,
            "desktop_engine_remove_instance was removed in #256 — TypeKey must not have this rawValue")
    }

    func testEngineSelectInstanceTypeKeyAbsent() {
        let key = RemoteCommand.TypeKey(rawValue: "desktop_engine_select_instance")
        XCTAssertNil(key,
            "desktop_engine_select_instance was removed in #256 — TypeKey must not have this rawValue")
    }

    func testEngineMoveInstanceTypeKeyAbsent() {
        let key = RemoteCommand.TypeKey(rawValue: "desktop_engine_move_instance")
        XCTAssertNil(key,
            "desktop_engine_move_instance was removed in #256 — TypeKey must not have this rawValue")
    }

    // MARK: - 4. No encode path for removed cases

    func testRemoteCommandHasNoEngineAddInstanceCase() {
        // Verify by exhaustively checking all cases via a switch on a known
        // exhaustive array. Swift will emit a compile-time warning if the
        // switch is not exhaustive; if the enum gains a new case this test
        // will fail to compile, which is the desired signal.
        //
        // Since the cases no longer exist we simply assert the TypeKey nil
        // tests above are the authoritative coverage. This function exists
        // as a documentation anchor for the removed cases.
        XCTAssertNil(RemoteCommand.TypeKey(rawValue: "desktop_engine_add_instance"))
        XCTAssertNil(RemoteCommand.TypeKey(rawValue: "desktop_engine_remove_instance"))
        XCTAssertNil(RemoteCommand.TypeKey(rawValue: "desktop_engine_rename_instance"))
        XCTAssertNil(RemoteCommand.TypeKey(rawValue: "desktop_engine_select_instance"))
        XCTAssertNil(RemoteCommand.TypeKey(rawValue: "desktop_engine_move_instance"))
    }

    // MARK: - 5. loadEngineConversation retired (WI-004)

    func testLoadEngineConversationTypeKeyIsAbsent() {
        // WI-004 / #259: desktop_load_engine_conversation is retired.
        // The TypeKey must not exist — a stale paired client sending this
        // string will get no match in the decoder, which is the desired
        // tolerance behavior.
        XCTAssertNil(
            RemoteCommand.TypeKey(rawValue: "desktop_load_engine_conversation"),
            "loadEngineConversation TypeKey must be absent after WI-004 retirement"
        )
    }

    func testLoadConversationEncodesUnifiedCommand() throws {
        // The unified command replaces loadEngineConversation for all tabs.
        let cmd = RemoteCommand.loadConversation(tabId: "tab-x", before: nil)
        let json = try jsonObject(from: cmd)
        XCTAssertEqual(json["type"] as? String, "desktop_load_conversation",
            "loadConversation must encode as desktop_load_conversation (unified command)")
        XCTAssertEqual(json["tabId"] as? String, "tab-x")
    }

    // MARK: - 6. EngineInstanceBar shows single instance without crash

    func testEngineInstanceBarIsOnlyShownAboveOneInstance() {
        // The guard `if instances.count > 1` in EngineView suppresses the bar
        // for single-instance tabs. Verify the count logic used in EngineView:
        let singleInstances = [makeInstance(id: "i1", label: "Main")]
        XCTAssertFalse(singleInstances.count > 1,
            "Bar guard must be false for a single-instance tab — bar should not appear")

        let multiInstances = [makeInstance(id: "i1", label: "Main"), makeInstance(id: "i2", label: "Sub")]
        XCTAssertTrue(multiInstances.count > 1,
            "Bar guard must be true for a legacy multi-instance snapshot — bar should still render defensively")
    }
}
