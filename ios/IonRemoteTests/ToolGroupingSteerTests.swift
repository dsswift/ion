import XCTest
@testable import IonRemote

/// Steer relocation in the grouping pass (ToolGrouping.swift).
///
/// A mid-turn steer is inserted optimistically where the user typed it, but the
/// engine applies it later and emits a "── Steer applied" divider at the point
/// it took effect. The grouping pass pairs the two via the shared
/// `steerAppliedDividerId` and re-emits the bubble directly AFTER its divider,
/// so the steer reads at its true moment of application instead of stranded
/// rows above the divider that announces it.
///
/// Desktop lockstep: `tool-helpers-steer.test.ts`. Both clients render the same
/// paired surface, so both must relocate identically.
final class ToolGroupingSteerTests: XCTestCase {

    private static let dividerId = "divider-1"

    // MARK: - Helpers

    private func steerBubble(id: String = "steer-bubble", dividerId: String? = ToolGroupingSteerTests.dividerId) -> Message {
        var m = Message(id: id, role: .user, content: "actually, check the other file first", timestamp: 1.0)
        m.steerApplied = dividerId != nil
        m.steerAppliedDividerId = dividerId
        return m
    }

    private func steerDivider(id: String = ToolGroupingSteerTests.dividerId) -> Message {
        Message(id: id, role: .system, content: "── Steer applied at 3:21 PM · 36 chars ──", timestamp: 4.0)
    }

    private func assistantMsg(_ id: String) -> Message {
        Message(id: id, role: .assistant, content: "working on it", timestamp: 2.0)
    }

    private func toolMsg(_ id: String) -> Message {
        var m = Message(id: id, role: .tool, content: "", timestamp: 3.0)
        m.toolName = "Read"
        m.toolId = id
        m.toolStatus = .completed
        return m
    }

    /// Index of the grouped item carrying the given message id, or nil.
    private func index(of id: String, in items: [ConversationItem]) -> Int? {
        items.firstIndex { item in
            switch item {
            case .user(let m), .assistant(let m), .system(let m), .thinking(let m), .compaction(let m):
                return m.id == id
            case .toolGroup, .agentTurn:
                return false
            }
        }
    }

    // MARK: - Relocation (both grouping modes)

    func testSteerEmittedImmediatelyAfterItsDivider() {
        for unified in [true, false] {
            let items = groupConversationItems(
                [steerBubble(), assistantMsg("a1"), toolMsg("t1"), steerDivider()],
                unifiedTurnView: unified
            )
            guard let dividerIdx = index(of: Self.dividerId, in: items),
                  let steerIdx = index(of: "steer-bubble", in: items) else {
                XCTFail("divider or steer missing (unified=\(unified))")
                return
            }
            XCTAssertEqual(steerIdx, dividerIdx + 1, "steer must follow its divider (unified=\(unified))")
        }
    }

    func testSteerRendersAfterTheAssistantTextItInterrupted() {
        for unified in [true, false] {
            let items = groupConversationItems(
                [steerBubble(), assistantMsg("a1"), steerDivider()],
                unifiedTurnView: unified
            )
            guard let assistantIdx = index(of: "a1", in: items),
                  let steerIdx = index(of: "steer-bubble", in: items) else {
                XCTFail("assistant or steer missing (unified=\(unified))")
                return
            }
            XCTAssertGreaterThan(steerIdx, assistantIdx, "unified=\(unified)")
        }
    }

    func testSteerAppearsExactlyOnce() {
        for unified in [true, false] {
            let items = groupConversationItems(
                [steerBubble(), assistantMsg("a1"), steerDivider()],
                unifiedTurnView: unified
            )
            let hits = items.filter { item in
                if case .user(let m) = item { return m.id == "steer-bubble" }
                return false
            }
            XCTAssertEqual(hits.count, 1, "relocated, never duplicated (unified=\(unified))")
        }
    }

    func testTwoSteersEachPairWithTheirOwnDivider() {
        for unified in [true, false] {
            let items = groupConversationItems([
                steerBubble(id: "steer-a", dividerId: "div-a"),
                assistantMsg("a1"),
                steerDivider(id: "div-a"),
                steerBubble(id: "steer-b", dividerId: "div-b"),
                assistantMsg("a2"),
                steerDivider(id: "div-b"),
            ], unifiedTurnView: unified)

            XCTAssertEqual(index(of: "steer-a", in: items), index(of: "div-a", in: items).map { $0 + 1 })
            XCTAssertEqual(index(of: "steer-b", in: items), index(of: "div-b", in: items).map { $0 + 1 })
        }
    }

    // MARK: - Degradation

    func testPendingSteerStaysAtItsSendPosition() {
        // A still-pending steer carries no divider id — nothing to relocate to.
        for unified in [true, false] {
            var pending = steerBubble(dividerId: nil)
            pending.steerPending = true
            let items = groupConversationItems([pending, assistantMsg("a1")], unifiedTurnView: unified)
            guard let steerIdx = index(of: "steer-bubble", in: items),
                  let assistantIdx = index(of: "a1", in: items) else {
                XCTFail("rows missing (unified=\(unified))")
                return
            }
            XCTAssertLessThan(steerIdx, assistantIdx, "unified=\(unified)")
        }
    }

    func testSteerWhoseDividerNeverArrivedIsNotDropped() {
        for unified in [true, false] {
            let items = groupConversationItems([steerBubble(), assistantMsg("a1")], unifiedTurnView: unified)
            XCTAssertNotNil(index(of: "steer-bubble", in: items), "unified=\(unified)")
        }
    }

    func testOrdinaryUserTurnIsNotRelocated() {
        // Post-reload shape: the engine file carries the turn at its applied
        // position and the client-only pairing fields are absent.
        for unified in [true, false] {
            let plain = Message(id: "u1", role: .user, content: "hello", timestamp: 1.0)
            let items = groupConversationItems(
                [plain, assistantMsg("a1"), steerDivider()],
                unifiedTurnView: unified
            )
            guard let userIdx = index(of: "u1", in: items),
                  let assistantIdx = index(of: "a1", in: items) else {
                XCTFail("rows missing (unified=\(unified))")
                return
            }
            XCTAssertLessThan(userIdx, assistantIdx, "unified=\(unified)")
        }
    }

    // MARK: - Turn integrity

    func testSteerDoesNotSplitTheAgentTurnAtItsSendPosition() {
        // The steer landed mid-turn. Flushing the turn on it would break one
        // agent-turn into two around the point where the user happened to type.
        let items = groupConversationItems(
            [toolMsg("t1"), steerBubble(), toolMsg("t2"), steerDivider()],
            unifiedTurnView: true
        )
        let turns = items.compactMap { item -> [Message]? in
            if case .agentTurn(let tools, _, _, _) = item { return tools }
            return nil
        }
        XCTAssertEqual(turns.count, 1, "expected a single agent turn")
        XCTAssertEqual(turns.first?.map(\.id), ["t1", "t2"])
    }
}
