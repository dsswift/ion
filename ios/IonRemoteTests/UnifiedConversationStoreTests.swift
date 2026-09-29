import XCTest
@testable import IonRemote

/// The single per-tab conversation instance (#256): every tab, plain or
/// extension-backed, owns exactly one `ConversationInstanceInfo`, created by
/// `ensureMainInstance` and never replaced by a second call.
@MainActor
final class UnifiedConversationStoreTests: XCTestCase {

    // MARK: - ensureMainInstance

    func testEnsureMainInstanceCreatesSingleInstance() {
        let vm = SessionViewModel()
        XCTAssertNil(vm.conversationInstances["tab-1"])

        let id = vm.ensureMainInstance(tabId: "tab-1")

        XCTAssertEqual(id, ConversationInstanceInfo.mainInstanceId)
        XCTAssertEqual(vm.conversationInstances["tab-1"]?.count, 1)
        XCTAssertEqual(vm.activeEngineInstance["tab-1"], ConversationInstanceInfo.mainInstanceId)
    }

    func testEnsureMainInstanceIsIdempotentAndPreservesState() {
        let vm = SessionViewModel()
        vm.handleTranscriptPage(TranscriptTestSupport.page(tabId: "tab-1", rows: [
            Message(id: "m1", role: .user, content: "hello", timestamp: 1_700_000_000_000)
        ]))
        // A second ensure must not wipe the existing instance/messages.
        let id = vm.ensureMainInstance(tabId: "tab-1")
        XCTAssertEqual(id, ConversationInstanceInfo.mainInstanceId)
        XCTAssertEqual(vm.conversationInstances["tab-1"]?.count, 1)
        XCTAssertEqual(vm.conversationMessages("tab-1").map(\.content), ["hello"])
    }

    func testEnsureMainInstancePreservesExistingEngineInstanceId() {
        // An engine tab whose instance arrived from a snapshot keeps its id;
        // ensureMainInstance must not overwrite it.
        let vm = SessionViewModel()
        vm.conversationInstances["tab-e"] = [ConversationInstanceInfo(id: "main", label: "Main")]
        let id = vm.ensureMainInstance(tabId: "tab-e")
        XCTAssertEqual(id, "main")
        XCTAssertEqual(vm.activeEngineInstance["tab-e"], "main")
    }
}
