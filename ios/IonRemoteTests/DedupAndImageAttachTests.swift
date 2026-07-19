import XCTest
@testable import IonRemote

/// RC-25 / RC-26: dedup ordering and image-attach idempotency.
@MainActor
final class DedupAndImageAttachTests: XCTestCase {

    private func seedTab(_ vm: SessionViewModel, id: String) {
        vm.tabs = [RemoteTabState(
            id: id, title: id, customTitle: nil, status: .running,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )]
    }

    // RC-26: a recurring id keeps the LAST value at the FIRST-seen position.
    func testDeduplicateKeepsLastValueAtFirstPosition() {
        let vm = SessionViewModel()
        let a0 = Message(id: "A", role: .user, content: "first", timestamp: 1)
        let b = Message(id: "B", role: .assistant, content: "middle", timestamp: 2)
        let a2 = Message(id: "A", role: .user, content: "updated", timestamp: 3)

        let out = vm.deduplicateMessages([a0, b, a2])

        XCTAssertEqual(out.map { $0.id }, ["A", "B"], "A stays at its first position, not relocated after B")
        XCTAssertEqual(out.first { $0.id == "A" }?.content, "updated", "the last value for A wins")
    }

    func testDeduplicatePreservesUniqueOrder() {
        let vm = SessionViewModel()
        let msgs = [
            Message(id: "1", role: .user, content: "a", timestamp: 1),
            Message(id: "2", role: .assistant, content: "b", timestamp: 2),
            Message(id: "3", role: .user, content: "c", timestamp: 3),
        ]
        XCTAssertEqual(vm.deduplicateMessages(msgs).map { $0.id }, ["1", "2", "3"])
    }

    // RC-25: two provider-image events for the same path attach once, even when
    // the "last assistant" row shifts between them.
    func testProviderImageAttachesOnceAcrossRekey() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")

        // First assistant row + image.
        vm.handleEngineTextDelta(tabId: "t", instanceId: nil, text: "looking")
        vm.handleEngineImageContent(tabId: "t", instanceId: nil, path: "/img/x.png", mediaType: "image/png", source: "provider", toolId: nil)
        // message_end re-keys/seals the row; a new assistant row opens on the next delta.
        vm.handleEngineMessageEnd(tabId: "t", instanceId: nil, inputTokens: 1, contextPercent: 1, entryId: "e1", userEntryId: nil)
        vm.handleEngineTextDelta(tabId: "t", instanceId: nil, text: "more")
        // A duplicate image event for the SAME path (reconnect replay).
        vm.handleEngineImageContent(tabId: "t", instanceId: nil, path: "/img/x.png", mediaType: "image/png", source: "provider", toolId: nil)

        let attachCount = vm.conversationMessages("t").reduce(0) { acc, m in
            acc + (m.attachments?.filter { $0.path == "/img/x.png" }.count ?? 0)
        }
        XCTAssertEqual(attachCount, 1, "the same image path must attach exactly once across a re-key")
    }
}
