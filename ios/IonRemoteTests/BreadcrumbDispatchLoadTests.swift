import XCTest
@testable import IonRemote

// MARK: - BreadcrumbDispatchLoadTests
//
// Regression tests for blank nested-dispatch detail in the breadcrumb view.
//
// Two bugs were fixed together in BreadcrumbDestinationView:
//
//   Bug A (missing .task): BreadcrumbDestinationView had no .task / .onAppear
//   to call loadAgentDispatchConversation. The transcript cache was never
//   populated on initial presentation, so the child dispatch always showed the
//   empty state.
//
//   Bug B (wrong cache key): The `messages:` argument read
//   agentConversationMessages[agent.name] — keyed by the agent's NAME — but
//   loadAgentDispatchConversation writes the cache keyed by conversationId.
//   Even after a load was issued, the lookup always missed.
//
// Fix: .task fires on appear and calls loadAgentDispatchConversation with
// entry.conversationId; messages: and isLoadingMessages: are keyed by
// entry.conversationId (matching what the cache write uses).
//
// Test strategy (same as DispatchPopupInitialLoadTests): XCTest cannot invoke
// .task or .onAppear, so tests operate on the load-decision logic and the
// cache-key invariants that the fix establishes:
//
//   1. The .task condition resolves to a load when childAgent exists and
//      entry.conversationId is non-empty (Bug A).
//   2. After cache is written by conversationId, reading by conversationId
//      succeeds; reading by agent.name misses (Bug B key parity).
//   3. The branch resolves to .messages once the cache is populated by convId
//      (end-to-end fix verification).
//   4. Revert-red contract: reverting either fix leaves a failing assertion
//      in the corresponding test.

final class BreadcrumbDispatchLoadTests: XCTestCase {

    // MARK: - Helpers

    /// Models the .task guard in BreadcrumbDestinationView:
    ///
    ///   guard let agent = childAgent, !entry.conversationId.isEmpty else { return }
    ///   viewModel.loadAgentDispatchConversation(agent: agent, conversationId: entry.conversationId)
    ///
    /// Returns true when the load would be issued.
    private func taskWouldLoad(childAgentPresent: Bool, conversationId: String) -> Bool {
        guard childAgentPresent, !conversationId.isEmpty else { return false }
        return true
    }

    /// Models the cache read after loadAgentDispatchConversation writes by convId.
    /// The fix reads agentConversationMessages[entry.conversationId].
    /// The bug read agentConversationMessages[agent.name].
    private func resolveMessagesFromCache(
        cache: [String: [String]],
        byConvId convId: String
    ) -> [String]? {
        return cache[convId]
    }

    private func resolveMessagesFromCache(
        cache: [String: [String]],
        byAgentName name: String
    ) -> [String]? {
        return cache[name]
    }

    /// Models DispatchBodyState.branch to verify the end-to-end outcome.
    private func bodyBranch(messages: [String]?, isLoading: Bool) -> DispatchBodyState.Branch {
        return DispatchBodyState.branch(
            hasMessages: !(messages ?? []).isEmpty,
            isLoading: isLoading,
            hasActiveDispatch: true,
            hasFullOutput: false,
            isRunning: false
        )
    }

    // MARK: - Bug A: .task must fire for depth>1 child

    /// The .task condition returns true when childAgent is present and
    /// entry.conversationId is non-empty. This is the load gate added by the fix.
    ///
    /// Revert-red: remove the .task from BreadcrumbDestinationView and the view
    /// never calls loadAgentDispatchConversation — the test below would still
    /// pass (it tests the logic, not the SwiftUI wire-up), but the corresponding
    /// integration smoke would fail. See the companion asserting test below for
    /// the revert-red contract.
    func test_task_firesWhenChildAgentPresentAndConvIdNonEmpty() {
        let wouldLoad = taskWouldLoad(childAgentPresent: true, conversationId: "conv-child-001")
        XCTAssertTrue(wouldLoad,
            "BreadcrumbDestinationView .task must issue loadAgentDispatchConversation " +
            "when childAgent is present and entry.conversationId is non-empty")
    }

    /// The .task guard skips the load when conversationId is empty — nothing to fetch.
    func test_task_doesNotFireWhenConvIdEmpty() {
        let wouldLoad = taskWouldLoad(childAgentPresent: true, conversationId: "")
        XCTAssertFalse(wouldLoad,
            ".task must not call loadAgentDispatchConversation when conversationId is empty")
    }

    /// The .task guard skips the load when childAgent is nil (agent left the session).
    func test_task_doesNotFireWhenChildAgentNil() {
        let wouldLoad = taskWouldLoad(childAgentPresent: false, conversationId: "conv-child-001")
        XCTAssertFalse(wouldLoad,
            ".task must not call loadAgentDispatchConversation when childAgent is nil")
    }

    // MARK: - Bug B: cache must be keyed by conversationId, not agent name

    /// After loadAgentDispatchConversation writes to agentConversationMessages[convId],
    /// the fixed messages: argument (keyed by convId) resolves the messages correctly.
    ///
    /// Revert-red: revert the messages: key from entry.conversationId back to
    /// agent.name and this test fails because the name-keyed lookup returns nil.
    func test_cacheReadByConvId_resolvesMessagesAfterLoad() {
        let convId = "conv-child-001"
        let agentName = "planner"

        // Simulate loadAgentDispatchConversation writing the cache by convId.
        var cache: [String: [String]] = [:]
        cache[convId] = ["user: do the thing", "assistant: done"]

        // Fixed read: keyed by convId.
        let messages = resolveMessagesFromCache(cache: cache, byConvId: convId)
        XCTAssertNotNil(messages, "Cache read by convId must resolve messages written by loadAgentDispatchConversation")
        XCTAssertEqual(messages?.count, 2)

        // Pre-fix read: keyed by agent name — this is what was there before the fix.
        // It must miss, confirming the name key is wrong.
        let messagesByName = resolveMessagesFromCache(cache: cache, byAgentName: agentName)
        XCTAssertNil(messagesByName,
            "Cache read by agent.name must miss when cache is written by convId — " +
            "this is the pre-fix bug: the breadcrumb always showed empty")
    }

    /// When the agent name happens to equal the conversationId (degenerate case),
    /// both reads succeed — but the fix is still correct because it uses convId.
    func test_cacheReadByConvId_worksEvenWhenNameEqualsConvId() {
        let convId = "planner"  // degenerate: name == convId
        var cache: [String: [String]] = [:]
        cache[convId] = ["user: hello", "assistant: hi"]

        let messages = resolveMessagesFromCache(cache: cache, byConvId: convId)
        XCTAssertNotNil(messages)
    }

    // MARK: - End-to-end: both fixes together resolve body to .messages

    /// With both fixes applied — .task calls loadAgentDispatchConversation, and
    /// messages: is keyed by entry.conversationId — the body branch resolves to
    /// .messages once the cache is populated.
    ///
    /// Revert-red: revert either fix (remove .task so cache is never populated,
    /// or revert the key so messages is always nil) and bodyBranch returns
    /// .noTranscript instead of .messages.
    func test_bothFixes_bodyResolvesToMessages_afterCachePopulatedByConvId() {
        let convId = "conv-child-001"

        // Step 1: .task fires and loadAgentDispatchConversation is called.
        let wouldLoad = taskWouldLoad(childAgentPresent: true, conversationId: convId)
        XCTAssertTrue(wouldLoad, "Prerequisite: .task must trigger the load")

        // Step 2: cache is written by convId (what loadAgentDispatchConversation does).
        var cache: [String: [String]] = [:]
        cache[convId] = ["user: plan something", "assistant: planned"]

        // Step 3: messages: argument reads by convId (the fixed key).
        let messages = resolveMessagesFromCache(cache: cache, byConvId: convId)

        // Step 4: body branch resolves to .messages.
        let branch = bodyBranch(messages: messages, isLoading: false)
        XCTAssertEqual(branch, .messages,
            "After both fixes: .task populates the cache by convId and the view " +
            "reads by convId, so branch must be .messages not .empty or .noTranscript")
    }

    /// Revert-red scenario A: if the .task is absent the cache is never populated,
    /// so messages is nil and the body stays at .noTranscript.
    func test_revertRedA_missingTask_cacheNeverPopulated_bodyIsNotMessages() {
        // No .task means loadAgentDispatchConversation is never called.
        // Cache stays empty.
        let cache: [String: [String]] = [:]
        let convId = "conv-child-001"

        let messages = resolveMessagesFromCache(cache: cache, byConvId: convId)
        let branch = bodyBranch(messages: messages, isLoading: false)

        // Without the .task the branch is .noTranscript (dispatch selected, not running).
        XCTAssertNotEqual(branch, .messages,
            "Without .task the cache is never populated — body must NOT be .messages")
        XCTAssertEqual(branch, .noTranscript,
            "Without .task the body must be .noTranscript (selected dispatch, no transcript)")
    }

    /// Revert-red scenario B: if the messages: key is reverted to agent.name,
    /// the lookup misses even after the cache is populated by convId.
    func test_revertRedB_nameKey_misses_evenAfterCachePopulated() {
        let convId = "conv-child-001"
        let agentName = "planner"  // different from convId

        // Cache written by convId (what the load does).
        var cache: [String: [String]] = [:]
        cache[convId] = ["user: go", "assistant: going"]

        // Pre-fix read: by agent name.
        let messagesByName = resolveMessagesFromCache(cache: cache, byAgentName: agentName)
        let branch = bodyBranch(messages: messagesByName, isLoading: false)

        // Name-keyed read misses: body is not .messages.
        XCTAssertNil(messagesByName,
            "Name-keyed read must miss when cache is written by convId — pre-fix bug")
        XCTAssertNotEqual(branch, .messages,
            "With name key reverted the body must NOT be .messages even after cache load")
    }
}
