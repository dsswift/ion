import XCTest
@testable import IonRemote

/// Pins the slash-command pill rendering for iOS-originated slash commands:
///
/// 1. The optimistic insert carries `slashCommand`/`slashArgs` metadata so
///    the pill renders immediately from the first frame.
/// 2. A desktop echo with slash metadata reconciles by id and preserves the
///    pill (the canonical echo replaces the optimistic, carrying metadata).
/// 3. A conversation history load with slash metadata (engine resolveSlash
///    path) renders the pill from metadata, not fallback content parsing.
/// 4. The fallback parser (`parseSlashCommand`) pills raw `/command` content
///    even without metadata (extension commands, optimistic bubbles before
///    the echo arrives).
@MainActor
final class SlashPillOptimisticTests: XCTestCase {

    private func makeTab(id: String) -> RemoteTabState {
        RemoteTabState(
            id: id,
            title: id,
            customTitle: nil,
            status: .idle,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            thinkingEffort: nil,
            permissionQueue: [],
            hasEngineExtension: true
        )
    }

    // MARK: - Test 1: optimistic insert carries slash metadata

    func testOptimisticSlashInsertCarriesMetadata() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab-s1")]

        vm.submit(tabId: "tab-s1", text: "/align the changes")

        let msgs = vm.conversationMessages("tab-s1")
        XCTAssertEqual(msgs.count, 1,
            "Optimistic insert must appear immediately")
        let msg = msgs[0]
        XCTAssertEqual(msg.role, .user)
        XCTAssertEqual(msg.slashCommand, "/align",
            "Optimistic insert must carry slashCommand metadata")
        XCTAssertEqual(msg.slashArgs, "the changes",
            "Optimistic insert must carry slashArgs metadata")
    }

    // MARK: - Test 2: bare slash (no args) populates metadata

    func testOptimisticSlashInsertNoArgs() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab-s2")]

        vm.submit(tabId: "tab-s2", text: "/clear")

        let msgs = vm.conversationMessages("tab-s2")
        XCTAssertEqual(msgs.count, 1)
        let msg = msgs[0]
        XCTAssertEqual(msg.slashCommand, "/clear",
            "Bare slash must carry command metadata")
        XCTAssertEqual(msg.slashArgs, "",
            "Bare slash with no args must have empty slashArgs")
    }

    // MARK: - Test 3: non-slash prompt does NOT get slash metadata

    func testOptimisticNonSlashHasNoMetadata() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab-s3")]

        vm.submit(tabId: "tab-s3", text: "hello world")

        let msgs = vm.conversationMessages("tab-s3")
        XCTAssertEqual(msgs.count, 1)
        let msg = msgs[0]
        XCTAssertNil(msg.slashCommand,
            "Non-slash prompt must not have slashCommand metadata")
        XCTAssertNil(msg.slashArgs,
            "Non-slash prompt must not have slashArgs metadata")
    }

    // MARK: - Test 4: echo with slash metadata reconciles to a single pill

    func testEchoWithSlashMetadataReconciles() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab-s4")]

        // Submit slash command (optimistic insert with metadata).
        vm.submit(tabId: "tab-s4", text: "/align the changes")
        let optimisticId = vm.conversationMessages("tab-s4").first?.id
        XCTAssertNotNil(optimisticId)

        // Desktop echo arrives with slash metadata under the same id.
        var echo = Message(
            id: optimisticId!,
            role: .user,
            content: "/align the changes",
            timestamp: 1_700_000_001_000
        )
        echo.slashCommand = "/align"
        echo.slashArgs = "the changes"
        echo.slashSource = "extension"
        vm.handleMessageAdded(tabId: "tab-s4", message: echo)

        // Must reconcile to exactly one user message, with metadata.
        let userMsgs = vm.conversationMessages("tab-s4").filter { $0.role == .user }
        XCTAssertEqual(userMsgs.count, 1,
            "Echo must REPLACE the optimistic by id, not append a duplicate")
        XCTAssertEqual(userMsgs[0].slashCommand, "/align",
            "Reconciled message must carry slashCommand from the echo")
        XCTAssertEqual(userMsgs[0].slashArgs, "the changes")

        // The pill resolver prefers metadata over fallback.
        let segments = userMsgs[0].slashSegments(fallbackText: userMsgs[0].content)
        XCTAssertNotNil(segments, "Slash segments must resolve for the pill")
        XCTAssertEqual(segments?.command, "/align")
    }

    // MARK: - Test 5: history with slash metadata renders pill

    func testHistoryWithSlashMetadataRendersPill() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab-s5")]

        // Simulate history load with slash metadata (engine resolveSlash path).
        var userMsg = Message(
            id: "engine-turn-001",
            role: .user,
            content: "/align the changes",
            timestamp: 1_700_000_000_000
        )
        userMsg.slashCommand = "/align"
        userMsg.slashArgs = "the changes"
        userMsg.slashSource = "ion"

        let assistantMsg = Message(
            id: "engine-turn-002",
            role: .assistant,
            content: "I'll review the changes now.",
            timestamp: 1_700_000_001_000
        )

        vm.handleConversationHistory(
            tabId: "tab-s5",
            newMessages: [userMsg, assistantMsg],
            hasMore: false,
            cursor: nil
        )

        let msgs = vm.conversationMessages("tab-s5")
        let user = msgs.first { $0.role == .user }
        XCTAssertNotNil(user)
        XCTAssertEqual(user?.slashCommand, "/align",
            "History message must carry slash metadata through to rendering")

        let segments = user?.slashSegments(fallbackText: user!.content)
        XCTAssertNotNil(segments)
        XCTAssertEqual(segments?.command, "/align")
    }

    // MARK: - Test 6: fallback parser pills raw slash content without metadata

    func testFallbackParserPillsRawSlashContent() {
        // This tests the parseSlashCommand fallback that renders pills even
        // when no metadata is present (e.g. optimistic bubble before echo).
        let result = parseSlashCommand("/diagram the auth flow")
        XCTAssertNotNil(result, "Fallback parser must pill raw slash content")
        XCTAssertEqual(result?.command, "/diagram")
        XCTAssertEqual(result?.args, "the auth flow")
    }

    func testLivePersistedTurnStampsModelProvenance() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab-model")]
        vm.submit(tabId: "tab-model", text: "/align")

        vm.handleEngineUserTurnPersisted(
            tabId: "tab-model",
            instanceId: nil,
            entryId: "entry-align",
            slashModelAlias: "fast",
            slashModelEffective: "dci-marketing/gpt-5.6-luna"
        )

        let message = vm.conversationMessages("tab-model").first
        XCTAssertEqual(message?.id, "entry-align")
        XCTAssertEqual(message?.slashModelAlias, "fast")
        XCTAssertEqual(message?.slashModelEffective, "dci-marketing/gpt-5.6-luna")
        XCTAssertEqual(message?.slashModelDisplay, "Fast · GPT 5.6 Luna")
    }

    func testSlashWithoutConfiguredModelHasNoProvenanceDisplay() {
        var message = Message(
            id: "engine-turn-no-model",
            role: .user,
            content: "/clear",
            timestamp: 1_700_000_000_000
        )
        message.slashCommand = "/clear"
        message.slashArgs = ""

        XCTAssertNil(message.slashModelDisplay)
    }

    func testSlashModelDisplayNormalizesProviderModelIDs() {
        var message = Message(
            id: "engine-turn-labels",
            role: .user,
            content: "/align",
            timestamp: 1_700_000_000_000
        )

        message.slashModelEffective = "claude-opus-4-6"
        XCTAssertEqual(message.slashModelDisplay, "Opus 4.6")

        message.slashModelEffective = "claude-sonnet-4-6-20260101"
        XCTAssertEqual(message.slashModelDisplay, "Sonnet 4.6")

        message.slashModelEffective = "gpt-5.6-terra"
        XCTAssertEqual(message.slashModelDisplay, "GPT 5.6 Terra")

        message.slashModelAlias = "claude-opus-5"
        message.slashModelEffective = "claude-opus-5"
        XCTAssertEqual(message.slashModelDisplay, "Opus 5")

        message.slashModelAlias = "fast"
        message.slashModelEffective = "dci-marketing/gpt-5.6-luna"
        XCTAssertEqual(message.slashModelDisplay, "Fast · GPT 5.6 Luna")

        message.slashModelEffective = nil
        XCTAssertNil(message.slashModelDisplay)
    }

    func testSlashModelDisplayUsesAttachmentCapsule() throws {
        let iosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sourceURL = iosRoot
            .appendingPathComponent("IonRemote")
            .appendingPathComponent("Views")
            .appendingPathComponent("EngineMessageRow+SlashBubble.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        guard let marker = source.range(of: ".accessibilityIdentifier(\"slash-model-pill\")") else {
            XCTFail("Slash model pill must retain its stable accessibility identifier")
            return
        }
        let capsuleBlock = source[source.index(marker.lowerBound, offsetBy: -700)..<marker.upperBound]
        XCTAssertTrue(capsuleBlock.contains("Image(systemName: \"brain\")"))
        XCTAssertTrue(capsuleBlock.contains(".background(Color(.secondarySystemFill))"))
        XCTAssertTrue(capsuleBlock.contains(".clipShape(Capsule())"))
    }

    // MARK: - Test 7: fallback parser does NOT pill non-slash content

    func testFallbackParserDoesNotPillNonSlash() {
        XCTAssertNil(parseSlashCommand("hello world"),
            "Fallback parser must not pill non-slash content")
        XCTAssertNil(parseSlashCommand("/123/path/not/a/command"),
            "Fallback parser must not pill numeric-starting paths")
    }
}
