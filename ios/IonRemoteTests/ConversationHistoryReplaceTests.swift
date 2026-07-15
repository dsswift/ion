import XCTest
@testable import IonRemote

/// Regression tests for the conversation-history replace/prepend semantics
/// (the interlaced-transcript heal-loop bug) and the desktop_message_end
/// canonical-id re-key.
///
/// Production shape of the heal-loop bug: every fingerprint-heal response
/// carried a non-nil RESPONSE `cursor` (the conversation had more history),
/// and the old handler branched on that cursor to decide replace-vs-prepend —
/// so every heal took the prepend branch and prepended the same first page
/// again. Message counts grew 132→172→212→252, one page per heal, producing
/// an interlaced transcript. The discriminator is now `before` — the
/// desktop's echo of the REQUEST cursor: nil = first page / heal (wholesale
/// replace), non-nil = older-page pagination (prepend unseen rows).
///
/// The re-key tests pin the companion mechanism: desktop_message_end now
/// carries the canonical persisted entry ids (`entryId` / `userEntryId`), and
/// iOS re-keys the locally-streamed rows to them so the next history page
/// anchors on those rows instead of duplicating them.
@MainActor
final class ConversationHistoryReplaceTests: XCTestCase {

    // MARK: - Helpers

    private func msg(
        id: String,
        role: MessageRole,
        content: String,
        ts: Double,
        source: MessageSource? = nil
    ) -> Message {
        Message(id: id, role: role, content: content, timestamp: ts, source: source)
    }

    /// The production first-page shape: canonical engine row ids, more
    /// history behind it (hasMore: true, non-nil response cursor).
    private func firstPage() -> [Message] {
        [
            msg(id: "e1", role: .user, content: "prompt 1", ts: 1_000),
            msg(id: "e2", role: .assistant, content: "answer 1", ts: 2_000),
            msg(id: "e3", role: .user, content: "prompt 2", ts: 3_000),
            msg(id: "e4", role: .assistant, content: "answer 2", ts: 4_000),
        ]
    }

    // MARK: - (a) Heal-loop growth

    /// Delivering the SAME first page twice with `before: nil` and the exact
    /// production response shape (`hasMore: true`, non-nil `cursor`) must not
    /// grow the list. On the old code — which branched on the response cursor
    /// — the second delivery took the prepend branch and doubled the
    /// transcript (the 132→172→212→252 heal loop). This test is RED on that
    /// code and GREEN on the `before`-discriminated replace.
    func testRepeatedFirstPageDeliveryDoesNotGrowTranscript() {
        let vm = SessionViewModel()
        let tabId = "tab-heal-loop"
        let page = firstPage()

        vm.handleConversationHistory(
            tabId: tabId, newMessages: page, hasMore: true, cursor: "cursor-e1", before: nil
        )
        let countAfterFirst = vm.conversationMessages(tabId).count
        XCTAssertEqual(countAfterFirst, page.count, "precondition: first delivery populates the page")

        // The fingerprint heal re-requests the first page; the desktop answers
        // with the identical page (hasMore still true, cursor still set).
        vm.handleConversationHistory(
            tabId: tabId, newMessages: page, hasMore: true, cursor: "cursor-e1", before: nil
        )
        let countAfterSecond = vm.conversationMessages(tabId).count

        XCTAssertEqual(countAfterSecond, countAfterFirst,
            "re-delivering the same first page must REPLACE, not prepend a duplicate page (heal-loop growth)")
        let ids = vm.conversationMessages(tabId).map { $0.id }
        XCTAssertEqual(Set(ids).count, ids.count, "no duplicate ids after repeated first-page delivery")
    }

    // MARK: - (b) Replace preserves live tail + pending optimistic rows

    /// A wholesale replace must preserve (1) live rows streamed after the
    /// page was cut (anchored by id on the last local row the page contains)
    /// and (2) optimistic user rows not yet persisted — appended BELOW the
    /// history, since they are the newest turns (the old code wrongly put
    /// them above it). Final shape: incoming + pendingOptimistic + liveTail.
    func testReplacePreservesLiveTailAndPendingOptimistic() {
        let vm = SessionViewModel()
        let tabId = "tab-replace-tail"

        vm.setConversationMessages(tabId: tabId, [
            msg(id: "e1", role: .user, content: "prompt 1", ts: 1_000),
            msg(id: "live-a", role: .assistant, content: "streaming…", ts: 3_000),
            msg(id: "client-1", role: .user, content: "optimistic prompt", ts: 4_000, source: .remote),
        ])

        // Page: e1 (canonical version, updated content) + e2 (new to iOS).
        let page = [
            msg(id: "e1", role: .user, content: "prompt 1 (canonical)", ts: 1_000),
            msg(id: "e2", role: .assistant, content: "answer 1", ts: 2_000),
        ]
        vm.handleConversationHistory(
            tabId: tabId, newMessages: page, hasMore: false, cursor: nil, before: nil
        )

        let final = vm.conversationMessages(tabId)
        XCTAssertEqual(final.map { $0.id }, ["e1", "e2", "client-1", "live-a"],
            "anchor = e1 → tail = [live-a]; pending optimistic = [client-1] below the history; final = incoming + pending + tail")
        XCTAssertEqual(final[0].content, "prompt 1 (canonical)",
            "the page's version of an anchored row is canonical and replaces the local copy")
        XCTAssertEqual(final[2].source, .remote, "the optimistic row survives intact")
    }

    /// When no local id appears in the page (a fully pre-canonical local
    /// list), the timestamp fallback preserves only rows STRICTLY newer than
    /// the page's last timestamp — stale local rows are replaced away.
    func testReplaceTimestampFallbackDropsStaleRowsKeepsNewer() {
        let vm = SessionViewModel()
        let tabId = "tab-ts-fallback"

        vm.setConversationMessages(tabId: tabId, [
            msg(id: "old-1", role: .assistant, content: "stale", ts: 1_000),
            msg(id: "live-b", role: .assistant, content: "post-page stream", ts: 9_000),
        ])
        let page = [
            msg(id: "e1", role: .user, content: "prompt", ts: 1_000),
            msg(id: "e2", role: .assistant, content: "answer", ts: 5_000),
        ]
        vm.handleConversationHistory(
            tabId: tabId, newMessages: page, hasMore: false, cursor: nil, before: nil
        )

        XCTAssertEqual(vm.conversationMessages(tabId).map { $0.id }, ["e1", "e2", "live-b"],
            "no id anchor → rows with ts > page's last ts (9000 > 5000) survive; equal-or-older rows (1000) are replaced away")
    }

    // MARK: - (c) Older-page prepend

    /// `before != nil` is the pagination request echo: only ids the local
    /// list doesn't already hold are prepended ABOVE the current transcript.
    func testOlderPagePrependsOnlyUnseenIdsAboveCurrent() {
        let vm = SessionViewModel()
        let tabId = "tab-prepend"

        vm.setConversationMessages(tabId: tabId, [
            msg(id: "e3", role: .user, content: "prompt 2", ts: 3_000),
            msg(id: "e4", role: .assistant, content: "answer 2", ts: 4_000),
        ])

        // Older page overlaps the local head (e3 already present).
        let olderPage = [
            msg(id: "e1", role: .user, content: "prompt 1", ts: 1_000),
            msg(id: "e2", role: .assistant, content: "answer 1", ts: 2_000),
            msg(id: "e3", role: .user, content: "prompt 2", ts: 3_000),
        ]
        vm.handleConversationHistory(
            tabId: tabId, newMessages: olderPage, hasMore: false, cursor: nil, before: "cursor-e3"
        )

        XCTAssertEqual(vm.conversationMessages(tabId).map { $0.id }, ["e1", "e2", "e3", "e4"],
            "pagination prepends only unseen ids above the current transcript")
        XCTAssertTrue(vm.suppressScrollToBottom,
            "pagination must suppress the scroll-to-bottom the count change would trigger")
    }

    // MARK: - (d) message_end canonical-id re-key

    /// message_end with entryId/userEntryId re-keys the streamed rows: the
    /// most recent UNSEALED assistant text row (walking back past tool rows)
    /// adopts `entryId` and is sealed; the most recent user row adopts
    /// `userEntryId`. A later tool-only message_end must NOT steal the sealed
    /// row's identity.
    func testMessageEndReKeysAssistantAndUserRows() {
        let vm = SessionViewModel()
        let tabId = "tab-rekey"

        vm.mutateConversationMessages(tabId: tabId) { msgs in
            msgs = [
                self.msg(id: "client-1", role: .user, content: "prompt", ts: 1_000, source: .remote),
                self.msg(id: "local-1", role: .assistant, content: "answer text", ts: 2_000),
                Message(id: "toolu_1", role: .tool, content: "", toolName: "Bash",
                        toolId: "toolu_1", toolStatus: .running, timestamp: 3_000),
            ]
        }

        vm.handleEngineMessageEnd(
            tabId: tabId, instanceId: nil, inputTokens: 10, contextPercent: 1,
            entryId: "e9", userEntryId: "u9"
        )

        let msgs = vm.conversationMessages(tabId)
        XCTAssertEqual(msgs[1].id, "e9", "assistant text row (behind the tool row) adopts the canonical entry id")
        XCTAssertTrue(msgs[1].sealed, "the re-keyed assistant row is sealed at the re-key site")
        XCTAssertEqual(msgs[0].id, "u9", "the run-opening user row adopts the canonical user entry id")

        // A follow-up tool-only assistant message ends (its message produced
        // no text row of its own): walking back past the tool row lands on
        // the ALREADY-SEALED e9 row, which must not be re-keyed.
        vm.handleEngineMessageEnd(
            tabId: tabId, instanceId: nil, inputTokens: 12, contextPercent: 1,
            entryId: "e10", userEntryId: nil
        )
        let after = vm.conversationMessages(tabId)
        XCTAssertEqual(after[1].id, "e9",
            "an already-sealed assistant row is never re-keyed by a later tool-only message_end")
    }

    /// End-to-end anchor: after the re-key, a heal page keyed by the same
    /// canonical ids anchors on the streamed rows instead of duplicating them.
    func testReKeyedRowsAnchorTheNextHealPage() {
        let vm = SessionViewModel()
        let tabId = "tab-rekey-heal"

        vm.mutateConversationMessages(tabId: tabId) { msgs in
            msgs = [
                self.msg(id: "client-1", role: .user, content: "prompt", ts: 1_000, source: .remote),
                self.msg(id: "local-1", role: .assistant, content: "answer", ts: 2_000),
            ]
        }
        vm.handleEngineMessageEnd(
            tabId: tabId, instanceId: nil, inputTokens: 10, contextPercent: 1,
            entryId: "e2", userEntryId: "e1"
        )

        // Heal page carries the persisted rows under the same canonical ids.
        let page = [
            msg(id: "e1", role: .user, content: "prompt", ts: 1_000),
            msg(id: "e2", role: .assistant, content: "answer", ts: 2_000),
        ]
        vm.handleConversationHistory(
            tabId: tabId, newMessages: page, hasMore: true, cursor: "cursor-e1", before: nil
        )

        XCTAssertEqual(vm.conversationMessages(tabId).map { $0.id }, ["e1", "e2"],
            "re-keyed live rows are anchored (and superseded) by the heal page — no duplicates")
    }

    // MARK: - Wire decode: `before` echo

    /// desktop_conversation_history decode carries the `before` echo through
    /// to the Swift case; absent and explicit-null both decode as nil.
    func testConversationHistoryDecodeCarriesBefore() throws {
        let decoder = JSONDecoder()

        let paginated = """
        {"type":"desktop_conversation_history","tabId":"t1","messages":[],"hasMore":true,"cursor":"c-next","before":"c-req"}
        """.data(using: .utf8)!
        guard case .conversationHistory(_, _, let hasMore, let cursor, let before) =
            try decoder.decode(RemoteEvent.self, from: paginated) else {
            return XCTFail("Expected conversationHistory (paginated)")
        }
        XCTAssertTrue(hasMore)
        XCTAssertEqual(cursor, "c-next")
        XCTAssertEqual(before, "c-req")

        let firstPage = """
        {"type":"desktop_conversation_history","tabId":"t1","messages":[],"hasMore":true,"cursor":"c-next","before":null}
        """.data(using: .utf8)!
        guard case .conversationHistory(_, _, _, _, let nullBefore) =
            try decoder.decode(RemoteEvent.self, from: firstPage) else {
            return XCTFail("Expected conversationHistory (explicit null before)")
        }
        XCTAssertNil(nullBefore, "explicit JSON null decodes as nil (first page / heal)")

        let legacy = """
        {"type":"desktop_conversation_history","tabId":"t1","messages":[],"hasMore":false}
        """.data(using: .utf8)!
        guard case .conversationHistory(_, _, _, _, let absentBefore) =
            try decoder.decode(RemoteEvent.self, from: legacy) else {
            return XCTFail("Expected conversationHistory (absent before)")
        }
        XCTAssertNil(absentBefore, "absent key decodes as nil (older desktop)")
    }
}
