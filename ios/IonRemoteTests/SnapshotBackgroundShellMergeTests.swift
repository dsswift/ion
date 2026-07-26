import XCTest
@testable import IonRemote

/// Regression: the per-instance snapshot merge dropped `backgroundShellCount`.
///
/// ROOT CAUSE: `SessionViewModel+Snapshot.swift`'s `handleSnapshot` merges
/// snapshot-projected fields onto the prior `ConversationInstanceInfo` so
/// runtime-only state (messages, agentStates, statusFields) survives each
/// tick. The merge copied `label`, `waitingState`, `isRunning`,
/// `runningAgentCount`, `modelFallback`, and `thinkingEffort` — but not
/// `backgroundShellCount`, which was added to the struct without being added
/// to the merge.
///
/// Every tab open for one snapshot tick takes the merge branch, so the
/// freshly projected count was discarded and the field stayed at whatever it
/// held when the instance was first seen — permanently nil in practice, since
/// a tab's first snapshot precedes any background command. The result: the
/// per-instance pink shell dot and the "N shells" label in `EngineInstanceBar`
/// never appeared.
///
/// Only HALF the feature broke, which is what made it hard to spot by hand:
/// the parent tab pill reads `RemoteTabState.backgroundShellCount`, which is
/// replaced wholesale each tick and worked fine.
///
/// The discriminator: removing `prior.backgroundShellCount = snap.backgroundShellCount`
/// makes `testCountUpdatesOnASubsequentTick` fail while the first-sight test
/// still passes.
@MainActor
final class SnapshotBackgroundShellMergeTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: - Helpers

    /// One tab, one instance, with `backgroundShellCount` spliced raw so the
    /// test can cover a value and the field being absent.
    private func snapshotJSON(shellCountJSON: String?) -> Data {
        let shellLine = shellCountJSON.map { "\"backgroundShellCount\":\($0)," } ?? ""
        let json = """
        {"type":"desktop_snapshot","tabs":[{
          "id":"tab-1",
          "title":"Test Tab",
          "customTitle":null,
          "status":"idle",
          "workingDirectory":"/tmp",
          "permissionMode":"auto",
          "permissionQueue":[],
          "conversationInstances":[
            {"id":"inst-1","label":"Main",\(shellLine)"isRunning":false}
          ],
          "activeConversationInstanceId":"inst-1",
          "lastMessage":null,
          "contextTokens":null
        }]}
        """
        return json.data(using: .utf8)!
    }

    private func apply(_ vm: SessionViewModel, shellCountJSON: String?) throws {
        let event = try decoder.decode(RemoteEvent.self, from: snapshotJSON(shellCountJSON: shellCountJSON))
        guard case .snapshot(let tabs, _, _, _, _, _, _, _, _, _, _) = event else {
            XCTFail("Expected snapshot"); return
        }
        vm.handleSnapshot(snapshotTabs: tabs, recentDirs: [], groupMode: nil, groups: nil)
    }

    private func instance(_ vm: SessionViewModel) throws -> ConversationInstanceInfo {
        try XCTUnwrap(vm.conversationInstances["tab-1"]?.first, "expected one conversation instance")
    }

    // MARK: - Tests

    /// The first snapshot for an instance takes the `return snap` path, which
    /// always worked. Pinned so the two paths are covered independently.
    func testCountArrivesOnFirstSight() throws {
        let vm = SessionViewModel()
        try apply(vm, shellCountJSON: "2")
        XCTAssertEqual(try instance(vm).backgroundShellCount, 2)
    }

    /// The merge path: instance already known, a later tick carries the count.
    /// This is the one that was broken — and it is the steady-state path, since
    /// a tab's first snapshot precedes any background command.
    func testCountUpdatesOnASubsequentTick() throws {
        let vm = SessionViewModel()
        try apply(vm, shellCountJSON: nil)
        XCTAssertNil(try instance(vm).backgroundShellCount, "pre-condition: no shells on first sight")

        try apply(vm, shellCountJSON: "3")
        XCTAssertEqual(try instance(vm).backgroundShellCount, 3,
                       "merge must copy the freshly projected count onto the known instance")
    }

    /// Commands finishing clears the indicator: the desktop omits the field at
    /// zero, and the merge must carry that absence through rather than pinning
    /// the last non-nil value.
    func testCountClearsWhenTheFieldGoesAbsent() throws {
        let vm = SessionViewModel()
        try apply(vm, shellCountJSON: "4")
        XCTAssertEqual(try instance(vm).backgroundShellCount, 4)

        try apply(vm, shellCountJSON: nil)
        XCTAssertNil(try instance(vm).backgroundShellCount,
                     "an absent count must clear the dot, not leave it stuck at the last value")
    }

    /// The merge exists to preserve runtime-only state, so updating the shell
    /// count must not disturb it. (The general form of this invariant is pinned
    /// by DataDrivenConversationTests.testSnapshotMergePreservesRuntimeStateForPlainTab;
    /// this asserts it specifically for the field added here.)
    func testMergePreservesRuntimeMessages() throws {
        let vm = SessionViewModel()
        try apply(vm, shellCountJSON: nil)
        vm.mutateConversationMessages(tabId: "tab-1") {
            $0.append(Message(id: "m1", role: .user, content: "hi", timestamp: 1))
        }

        try apply(vm, shellCountJSON: "1")

        let inst = try instance(vm)
        XCTAssertEqual(inst.backgroundShellCount, 1)
        XCTAssertEqual(inst.messages.count, 1, "runtime messages must survive the merge")
    }
}
