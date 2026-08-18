import XCTest
@testable import IonRemote

/// `GroupedItem.contentHash` is what lets ChatCollectionVC reconfigure only the
/// rows that actually changed, instead of rebuilding every visible row on every
/// apply (which re-measured rows above the viewport and shifted the reading
/// position).
///
/// The hash therefore has two obligations, and both are failure modes:
///   - Too coarse (a rendered field left unhashed) → the row never refreshes.
///   - Too broad (a non-rendered field hashed) → needless reconfigures, and
///     needless re-measurement above the viewport.
///
/// These tests pin both directions.
final class GroupedItemContentHashTests: XCTestCase {

    private func msg(
        id: String,
        role: MessageRole,
        content: String,
        ts: Double = 1_000
    ) -> Message {
        Message(id: id, role: role, content: content, timestamp: ts)
    }

    // MARK: - Stability

    /// The baseline: an unchanged transcript re-grouped produces an identical
    /// hash. `groupConversationItems` rebuilds these value-type enums on every
    /// pass, so without this there is no way to tell "same row" from "changed
    /// row" and every apply would reconfigure everything.
    func testIdenticalContentHashesEqual() {
        let message = msg(id: "m1", role: .assistant, content: "hello")
        XCTAssertEqual(
            ConversationView.GroupedItem.single(message, followsUser: false).contentHash,
            ConversationView.GroupedItem.single(message, followsUser: false).contentHash,
            "re-grouping unchanged content must produce a stable hash"
        )
    }

    /// `followsUser` adds a divider before the message. Its value changes the
    /// rendered row without changing identity, so it must change the content hash.
    func testFollowsUserChangesHashButNotIdentity() {
        let message = msg(id: "m1", role: .assistant, content: "hello")
        let plain = ConversationView.GroupedItem.single(message, followsUser: false)
        let divided = ConversationView.GroupedItem.single(message, followsUser: true)

        XCTAssertEqual(plain.id, divided.id,
            "the divider must not replace the message row")
        XCTAssertNotEqual(plain.contentHash, divided.contentHash,
            "a divider state change must reconfigure the stable message row")
    }

    /// Fields that never reach a pixel must not perturb the hash. `isLive` is
    /// flipped by the history-merge boundary bookkeeping on rows whose rendering
    /// is unaffected; hashing it would reconfigure rows for free.
    func testNonRenderedFieldsDoNotAffectHash() {
        let base = msg(id: "m1", role: .assistant, content: "hello")
        var mutated = base
        mutated.isLive = !base.isLive
        mutated.sealed = !base.sealed
        mutated.clientMsgId = "client-abc"
        mutated.injectionKind = "agent_completion"

        XCTAssertEqual(
            ConversationView.GroupedItem.single(base, followsUser: false).contentHash,
            ConversationView.GroupedItem.single(mutated, followsUser: false).contentHash,
            "bookkeeping fields that no row renders must not trigger a reconfigure"
        )
    }

    // MARK: - Content changes

    /// The streaming case: appended assistant text must change the hash, or the
    /// row would freeze mid-stream.
    func testAppendedStreamingTextChangesHash() {
        let before = msg(id: "m1", role: .assistant, content: "hel")
        var after = before
        after.content = "hello"

        XCTAssertNotEqual(
            ConversationView.GroupedItem.single(before, followsUser: false).contentHash,
            ConversationView.GroupedItem.single(after, followsUser: false).contentHash,
            "streamed text must change the hash so the row re-renders"
        )
    }

    /// A status-only change carries no new text but does change the rendered
    /// dot/spinner, so it must still flip the hash.
    func testToolStatusChangeChangesHash() {
        var running = msg(id: "t1", role: .tool, content: "")
        running.toolName = "Bash"
        running.toolStatus = .running
        var completed = running
        completed.toolStatus = .completed

        XCTAssertNotEqual(
            ConversationView.GroupedItem.toolGroup([running]).contentHash,
            ConversationView.GroupedItem.toolGroup([completed]).contentHash,
            "a running→completed transition must re-render the tool row"
        )
    }

    /// `isActive` drives the agent turn's live activity indicator and is not
    /// part of the item's identity, so only the hash can carry it.
    func testAgentTurnIsActiveFlipChangesHash() {
        let tool = msg(id: "t1", role: .tool, content: "")
        let assistant = msg(id: "a1", role: .assistant, content: "done")

        let active = ConversationView.GroupedItem.agentTurn(
            tools: [tool], assistantMessages: [assistant], isActive: true, thinking: nil
        )
        let idle = ConversationView.GroupedItem.agentTurn(
            tools: [tool], assistantMessages: [assistant], isActive: false, thinking: nil
        )

        XCTAssertNotEqual(active.contentHash, idle.contentHash,
            "the turn's active indicator must re-render when the run settles")
    }

    /// A turn's thinking row is excluded from `id` (identity is tools/assistants)
    /// but IS rendered, so the hash must cover it — otherwise a reasoning block
    /// that starts, streams, and resolves would never repaint.
    func testAgentTurnThinkingChangeChangesHash() {
        let tool = msg(id: "t1", role: .tool, content: "")
        var thinking = msg(id: "th1", role: .thinking, content: "pondering")
        thinking.thinkingActive = true

        var resolved = thinking
        resolved.thinkingActive = false
        resolved.thinkingElapsedSeconds = 4.2

        let streaming = ConversationView.GroupedItem.agentTurn(
            tools: [tool], assistantMessages: [], isActive: true, thinking: thinking
        )
        let settled = ConversationView.GroupedItem.agentTurn(
            tools: [tool], assistantMessages: [], isActive: true, thinking: resolved
        )

        XCTAssertNotEqual(streaming.contentHash, settled.contentHash,
            "a turn's thinking row must re-render when its block resolves")
    }

    /// Standalone thinking rows carry a summary that renders as
    /// "Thought for Ns" — pin the whole summary set, not just the active flag.
    func testThinkingSummaryFieldsChangeHash() {
        var active = msg(id: "th1", role: .thinking, content: "reasoning")
        active.thinkingActive = true

        var done = active
        done.thinkingActive = false
        done.thinkingElapsedSeconds = 12.5
        done.thinkingTotalTokens = 812

        XCTAssertNotEqual(
            ConversationView.GroupedItem.thinking(active).contentHash,
            ConversationView.GroupedItem.thinking(done).contentHash,
            "the thinking summary must re-render when the block ends"
        )

        var redacted = active
        redacted.thinkingRedacted = true
        XCTAssertNotEqual(
            ConversationView.GroupedItem.thinking(active).contentHash,
            ConversationView.GroupedItem.thinking(redacted).contentHash,
            "a redacted reasoning block renders differently and must change the hash"
        )
    }

    /// Steer state changes a user bubble's treatment without changing its text,
    /// and `steerAppliedDividerId` additionally drives the grouping pass to
    /// RELOCATE the bubble to its application point — so a row can move with no
    /// text change at all. All three fields must be hashed.
    func testSteerFieldsChangeHash() {
        var pending = msg(id: "u1", role: .user, content: "do the thing")
        pending.steerPending = true

        var applied = pending
        applied.steerPending = false
        applied.steerApplied = true

        XCTAssertNotEqual(
            ConversationView.GroupedItem.single(pending, followsUser: false).contentHash,
            ConversationView.GroupedItem.single(applied, followsUser: false).contentHash,
            "a steer being applied must re-render its bubble"
        )

        var relocated = applied
        relocated.steerAppliedDividerId = "divider-1"
        XCTAssertNotEqual(
            ConversationView.GroupedItem.single(applied, followsUser: false).contentHash,
            ConversationView.GroupedItem.single(relocated, followsUser: false).contentHash,
            "the divider pairing that relocates the bubble must change the hash"
        )
    }

    /// The slash pill prefers engine-provided provenance over re-parsing the
    /// content, so a late-arriving annotation changes the render with identical
    /// text.
    func testSlashProvenanceChangesHash() {
        let raw = msg(id: "u1", role: .user, content: "/plan ship it")
        var annotated = raw
        annotated.slashCommand = "/plan"
        annotated.slashArgs = "ship it"

        XCTAssertNotEqual(
            ConversationView.GroupedItem.single(raw, followsUser: false).contentHash,
            ConversationView.GroupedItem.single(annotated, followsUser: false).contentHash,
            "slash-command provenance arriving late must re-render the pill"
        )
    }

    /// A plan divider's slug only becomes tappable once a path is present.
    func testPlanFilePathChangesHash() {
        let divider = msg(id: "s1", role: .system, content: "── Plan created")
        var withPath = divider
        withPath.planFilePath = "/tmp/plan.md"

        XCTAssertNotEqual(
            ConversationView.GroupedItem.single(divider, followsUser: false).contentHash,
            ConversationView.GroupedItem.single(withPath, followsUser: false).contentHash,
            "gaining a plan path makes the slug tappable and must re-render"
        )
    }

    /// The intercept banner picks its style from `interceptLevel`.
    func testInterceptLevelChangesHash() {
        var banner = msg(id: "h1", role: .harness, content: "heads up")
        banner.interceptLevel = "banner"
        var redirect = banner
        redirect.interceptLevel = "redirect"

        XCTAssertNotEqual(
            ConversationView.GroupedItem.single(banner, followsUser: false).contentHash,
            ConversationView.GroupedItem.single(redirect, followsUser: false).contentHash,
            "the intercept banner style must re-render when the level changes"
        )
    }

    /// Inline images arrive as structured attachments, often on an
    /// otherwise-empty turn.
    func testAttachmentChangeChangesHash() {
        let bare = msg(id: "a1", role: .assistant, content: "")
        var withImage = bare
        withImage.attachments = [
            MessageAttachment(id: "img1", type: .image, name: "shot.png", path: "/tmp/shot.png")
        ]

        XCTAssertNotEqual(
            ConversationView.GroupedItem.single(bare, followsUser: false).contentHash,
            ConversationView.GroupedItem.single(withImage, followsUser: false).contentHash,
            "an arriving image attachment must re-render the row"
        )
    }

    // MARK: - Identity vs content split

    /// The load-bearing invariant: `id` stays coarse so the diffable data source
    /// treats a streaming row as the SAME row (not delete+insert, which would
    /// destroy scroll position), while `contentHash` carries the difference.
    /// Equal id + different hash is exactly the state a reconfigure exists for.
    func testEqualIdWithDifferentContentHasDifferentHash() {
        let before = msg(id: "m1", role: .assistant, content: "hel")
        var after = before
        after.content = "hello there"

        let a = ConversationView.GroupedItem.single(before, followsUser: false)
        let b = ConversationView.GroupedItem.single(after, followsUser: false)

        XCTAssertEqual(a.id, b.id,
            "identity must stay content-independent so the row is not re-inserted")
        XCTAssertNotEqual(a.contentHash, b.contentHash,
            "content must be distinguishable from identity for selective reconfigure")
    }

    /// A tool group's identity anchors on its first member, so appending a tool
    /// to an in-flight turn keeps the id — the hash is the only signal that the
    /// group grew.
    func testToolGroupGrowthChangesHashButNotId() {
        var first = msg(id: "t1", role: .tool, content: "")
        first.toolName = "Read"
        var second = msg(id: "t2", role: .tool, content: "")
        second.toolName = "Bash"

        let one = ConversationView.GroupedItem.toolGroup([first])
        let two = ConversationView.GroupedItem.toolGroup([first, second])

        XCTAssertEqual(one.id, two.id,
            "a growing tool group keeps its identity anchor")
        XCTAssertNotEqual(one.contentHash, two.contentHash,
            "a growing tool group must re-render")
    }

    /// Distinct kinds wrapping the same message must not collide: `.single` and
    /// `.compaction` render completely different rows.
    func testDifferentKindsWithSameMessageDoNotCollide() {
        let message = msg(id: "m1", role: .system, content: "[Compaction]")

        XCTAssertNotEqual(
            ConversationView.GroupedItem.single(message, followsUser: false).contentHash,
            ConversationView.GroupedItem.compaction(message).contentHash,
            "different row kinds must not produce the same content hash"
        )
    }
}
