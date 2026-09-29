import XCTest
@testable import IonRemote

/// Tests for #256: engine session keys collapsed to bare tabId, single instance.
///
/// Coverage:
///   1. parseEngineSessionKey strips compound form to bare tabId
///   2. parseEngineSessionKey passes bare tabId through unchanged
///   3. engineInstance ignores instanceId and returns the single instance
///   4. mutateEngineInstance targets the single instance (and creates it)
///   5. engineDraft reads the unified bare-tabId store (post-#256)
///   6. Engine and plain drafts share one store
///   7. setEngineDraft writes bare tabId key
///   8. clearEngineDrafts removes the unified bare-tabId entry
///   10. loadEngineConversation retired (WI-004 / #259): TypeKey absent, loadConversation used instead
///   11. Terminal compound keys are NOT affected by parseEngineSessionKey (it only strips, terminals keep their own compound keys when addressed directly)
///   12. AgentDetailFullScreenView.compoundKey parse round-trip via parseEngineSessionKey
final class EngineSessionKeyCollapseTests: XCTestCase {

    // MARK: - 1 & 2. parseEngineSessionKey

    func testParseEngineSessionKey_stripsInstanceIdSuffix() {
        XCTAssertEqual(SessionViewModel.parseEngineSessionKey("tab-abc:main"), "tab-abc")
        XCTAssertEqual(SessionViewModel.parseEngineSessionKey("tab-abc:inst-xyz-123"), "tab-abc")
        XCTAssertEqual(SessionViewModel.parseEngineSessionKey("abc:def:ghi"), "abc",
            "Only the first colon segment is the tabId — second colon should still be stripped")
    }

    func testParseEngineSessionKey_passesBareTabIdThrough() {
        XCTAssertEqual(SessionViewModel.parseEngineSessionKey("tab-abc"), "tab-abc")
        XCTAssertEqual(SessionViewModel.parseEngineSessionKey(""), "")
        XCTAssertEqual(SessionViewModel.parseEngineSessionKey("plain"), "plain")
    }

    func testParseEngineSessionKey_realWorldIds() {
        // Realistic UUID-style tabId + ":main" suffix from pre-#256 snapshot
        let legacyKey = "550e8400-e29b-41d4-a716-446655440000:main"
        XCTAssertEqual(SessionViewModel.parseEngineSessionKey(legacyKey), "550e8400-e29b-41d4-a716-446655440000")
    }

    // MARK: - 3. engineInstance / mutateEngineInstance ignore instanceId

    @MainActor
    func testEngineInstanceIgnoresInstanceIdAndReturnsTheSingleInstance() async {
        // Post-#256 a tab has exactly one instance; engineInstance returns it
        // regardless of the (vestigial) instanceId argument.
        let vm = SessionViewModel()
        vm.conversationInstances["tab-x"] = [ConversationInstanceInfo(id: "main", label: "Main")]
        XCTAssertEqual(vm.engineInstance(tabId: "tab-x", instanceId: nil)?.id, "main")
        XCTAssertEqual(vm.engineInstance(tabId: "tab-x", instanceId: "any-other-id")?.id, "main",
            "engineInstance must return the single instance regardless of instanceId")
    }

    @MainActor
    func testMutateEngineInstanceTargetsTheSingleInstanceRegardlessOfInstanceId() async {
        let vm = SessionViewModel()
        vm.conversationInstances["tab-y"] = [ConversationInstanceInfo(id: "main", label: "Main")]
        vm.mutateEngineInstance(tabId: "tab-y", instanceId: "stale-id") { $0.modelOverride = "m" }
        XCTAssertEqual(vm.conversationInstances["tab-y"]?.first?.modelOverride, "m",
            "mutateEngineInstance must target the single instance even with a stale instanceId")
    }

    @MainActor
    func testMutateEngineInstanceCreatesTheInstanceWhenAbsent() async {
        // A write to a tab with no instance yet (plain tab, or pre-snapshot
        // engine tab) ensures the main instance rather than no-opping.
        let vm = SessionViewModel()
        vm.mutateEngineInstance(tabId: "tab-new", instanceId: nil) { $0.modelOverride = "x" }
        XCTAssertEqual(vm.conversationInstances["tab-new"]?.count, 1)
        XCTAssertEqual(vm.conversationInstances["tab-new"]?.first?.modelOverride, "x")
    }

    // MARK: - 5. engineDraft reads the unified bare-tabId store (post-#256)

    @MainActor
    func testEngineDraft_readsUnifiedStore() async {
        let vm = SessionViewModel()
        vm.draftInputByTab["tab-1"] = "my draft text"
        let draft = vm.engineDraft(tabId: "tab-1", instanceId: "ignored-instance")
        XCTAssertEqual(draft, "my draft text")
    }

    @MainActor
    func testEngineDraft_returnsEmptyWhenNoKey() async {
        let vm = SessionViewModel()
        let draft = vm.engineDraft(tabId: "tab-missing", instanceId: "inst")
        XCTAssertEqual(draft, "")
    }

    // MARK: - 6. Engine and plain drafts share one store

    @MainActor
    func testEngineAndPlainDraftsShareOneStore() async {
        let vm = SessionViewModel()
        // Writing via the engine shim and reading via the plain accessor (and
        // vice-versa) must hit the same bare-tabId entry.
        vm.setEngineDraft(tabId: "tab-2", instanceId: "main", "engine wrote this")
        XCTAssertEqual(vm.tabDraft("tab-2"), "engine wrote this")

        vm.setTabDraft("tab-3", "plain wrote this")
        XCTAssertEqual(vm.engineDraft(tabId: "tab-3", instanceId: "ignored"), "plain wrote this")
    }

    // MARK: - 7. setEngineDraft writes bare tabId key

    @MainActor
    func testSetEngineDraft_writesBareTabId() async {
        let vm = SessionViewModel()
        vm.setEngineDraft(tabId: "tab-w", instanceId: "ignored", "new draft")
        XCTAssertEqual(vm.draftInputByTab["tab-w"], "new draft")
        // Must NOT write a compound key
        XCTAssertNil(vm.draftInputByTab["tab-w:ignored"],
            "setEngineDraft must not write a compound key post-#256")
    }

    @MainActor
    func testSetEngineDraft_clearsBareTabId() async {
        let vm = SessionViewModel()
        vm.draftInputByTab["tab-v"] = "existing draft"
        vm.setEngineDraft(tabId: "tab-v", instanceId: "ignored", "")
        XCTAssertNil(vm.draftInputByTab["tab-v"], "Empty text should remove the bare key")
    }

    // MARK: - 8. clearEngineDrafts removes the unified bare-tabId entry

    @MainActor
    func testClearEngineDrafts_removesBareTabIdKey() async {
        let vm = SessionViewModel()
        vm.draftInputByTab["tab-c"] = "draft"
        vm.clearEngineDrafts(forTab: "tab-c")
        XCTAssertNil(vm.draftInputByTab["tab-c"])
    }

    @MainActor
    func testClearEngineDrafts_doesNotTouchOtherTabDrafts() async {
        let vm = SessionViewModel()
        vm.draftInputByTab["tab-f"] = "keep this"
        vm.draftInputByTab["tab-g"] = "remove this"
        vm.clearEngineDrafts(forTab: "tab-g")
        XCTAssertEqual(vm.draftInputByTab["tab-f"], "keep this",
            "clearEngineDrafts must not affect other tabs' drafts")
        XCTAssertNil(vm.draftInputByTab["tab-g"])
    }

    // MARK: - 10. loadEngineConversation retired (WI-004)

    @MainActor
    func testLoadEngineConversation_typeKeyAbsent() {
        // WI-004 / #259: desktop_load_engine_conversation is retired.
        XCTAssertNil(
            RemoteCommand.TypeKey(rawValue: "desktop_load_engine_conversation"),
            "loadEngineConversation TypeKey must be absent after WI-004 retirement"
        )
    }

    // MARK: - 11. Terminal keys are not collapsed by parseEngineSessionKey

    func testTerminalCompoundKeysAreNotStrippedByParseHelper() {
        // parseEngineSessionKey only strips the first colon segment.
        // Terminal code uses compound keys for valid reasons — but those keys
        // should never be fed into parseEngineSessionKey. This test documents
        // the behavior (strips on first colon) so that if terminal keys were
        // accidentally passed in, the behavior is predictable and detectable.
        let terminalKey = "tab-t:terminal-instance-1"
        // The helper WOULD strip it (same mechanical rule) — that's why terminal
        // keys must never be passed to this helper. Test that strip occurs so we
        // know exactly what would happen.
        XCTAssertEqual(SessionViewModel.parseEngineSessionKey(terminalKey), "tab-t",
            "parseEngineSessionKey strips ANY compound form — callers must not pass terminal keys to it")
    }

    // MARK: - 12. AgentDetailFullScreenView compoundKey parse round-trip

    func testAgentDetailViewKeyParse_legacyCompoundKey() {
        // Simulate what AgentDetailFullScreenView.agent does:
        // parse compoundKey via parseEngineSessionKey to get bare tabId
        let legacyCompoundKey = "tab-agent-1:main"
        let parsed = SessionViewModel.parseEngineSessionKey(legacyCompoundKey)
        XCTAssertEqual(parsed, "tab-agent-1")
    }

    func testAgentDetailViewKeyParse_bareKey() {
        let bareKey = "tab-agent-2"
        let parsed = SessionViewModel.parseEngineSessionKey(bareKey)
        XCTAssertEqual(parsed, "tab-agent-2")
    }
}
