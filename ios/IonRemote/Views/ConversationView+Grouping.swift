import SwiftUI

// MARK: - ConversationView GroupedItem model
//
// Defines GroupedItem, the display-item enum consumed by Transcript when
// rendering a conversation. The grouping algorithm lives in ToolGrouping.swift
// (groupConversationItems); Transcript maps ConversationItems to GroupedItems
// and switches on them to produce rows.

extension ConversationView {

    enum GroupedItem: Identifiable {
        case single(Message, followsUser: Bool)
        case toolGroup([Message])
        case compaction(Message)
        case thinking(Message)
        case agentTurn(tools: [Message], assistantMessages: [Message], isActive: Bool, thinking: Message?)
        var id: String {
            switch self {
            case .single(let msg, _): return msg.id
            case .toolGroup(let msgs): return "tg-\(msgs.first?.id ?? "")"
            case .compaction(let msg): return "cp-\(msg.id)"
            case .thinking(let msg): return "th-\(msg.id)"
            case .agentTurn(let tools, let assistants, _, _):
                // thinking excluded from identity anchor — turn identity is
                // driven by tools/assistants, not reasoning content.
                let anchor = tools.first?.id ?? assistants.first?.id ?? ""
                return "at-\(anchor)"
            }
        }

        /// Every message id this row renders.
        ///
        /// A row's `id` is a GROUP identity (`at-<anchor>`, `tg-<anchor>`), so
        /// a member message — a chart's tool row inside a unified turn — is
        /// never its own data-source row. A jump that looks up a bare message
        /// id therefore finds nothing, which is exactly why tapping a chart in
        /// the attachments panel resolved the right row and then went nowhere.
        ///
        /// Mirrors the desktop's `findRowIndexForMessage`, which was
        /// generalized from "the row with this id" to "the row that CONTAINS
        /// this id" for the same reason.
        var containedMessageIds: [String] {
            switch self {
            case .single(let msg, _): return [msg.id]
            case .toolGroup(let msgs): return msgs.map(\.id)
            case .compaction(let msg): return [msg.id]
            case .thinking(let msg): return [msg.id]
            case .agentTurn(let tools, let assistants, _, let thinking):
                return tools.map(\.id) + assistants.map(\.id) + (thinking.map { [$0.id] } ?? [])
            }
        }

        /// Hash of everything a row actually renders, used by ChatCollectionVC
        /// to reconfigure ONLY the rows whose content moved.
        ///
        /// `id` above is deliberately coarse (turn identity), and it must stay
        /// that way: the diffable data source keys structural identity off it,
        /// so folding content into `id` would make every streamed chunk look
        /// like a delete+insert and destroy scroll position. This hash is the
        /// separate, finer signal — same row, different content.
        ///
        /// Why a hash and not reference equality: `GroupedItem` is a value-type
        /// enum that `groupConversationItems` rebuilds on every pass, so there
        /// is no stable object identity to compare. The desktop solves the same
        /// problem with a behavioral comparator (`groupedItemsEqual` in
        /// `TranscriptRows.tsx`) and can lean on React's reference equality for
        /// unchanged messages; it drops to field-by-field comparison exactly
        /// where a row is synthesized fresh each pass (merged thinking). Every
        /// iOS case is in that synthesized situation, hence hashing throughout.
        ///
        /// Contract for future edits: when a row view starts rendering a new
        /// `Message` field, add it to `Message.renderHash` below. A field that
        /// is rendered but unhashed produces a row that never refreshes; a
        /// field that is hashed but not rendered produces needless reconfigures
        /// (and, above the viewport, needless re-measurement).
        var contentHash: Int {
            var hasher = Hasher()
            switch self {
            case .single(let msg, let followsUser):
                hasher.combine(0)
                msg.renderHash(into: &hasher)
                // Transcript renders a divider before this row when this is
                // true, so the flag must reconfigure this stable row too.
                hasher.combine(followsUser)
            case .toolGroup(let msgs):
                hasher.combine(1)
                hasher.combine(msgs.count)
                for msg in msgs { msg.renderHash(into: &hasher) }
            case .compaction(let msg):
                hasher.combine(2)
                msg.renderHash(into: &hasher)
            case .thinking(let msg):
                hasher.combine(3)
                msg.renderHash(into: &hasher)
            case .agentTurn(let tools, let assistants, let isActive, let thinking):
                hasher.combine(4)
                // isActive drives the turn's live activity indicator.
                hasher.combine(isActive)
                hasher.combine(tools.count)
                for msg in tools { msg.renderHash(into: &hasher) }
                hasher.combine(assistants.count)
                for msg in assistants { msg.renderHash(into: &hasher) }
                // thinking is excluded from `id` but IS rendered, so it must be
                // hashed — otherwise a reasoning block that starts, streams, and
                // resolves would never refresh its row.
                if let thinking {
                    hasher.combine(true)
                    thinking.renderHash(into: &hasher)
                } else {
                    hasher.combine(false)
                }
            }
            return hasher.finalize()
        }
    }

}

// MARK: - Message render hash

extension Message {
    /// Mix every field a transcript row renders into `hasher`.
    ///
    /// The field set is derived from what the row views actually read, verified
    /// against `EngineMessageRow` (+`ToolBubble`/`SlashBubble` extensions),
    /// `ThinkingRowView`, `CompactionRowView`, `EngineToolGroupRow`, and
    /// `AgentTurnRow` — not from the full `Message` surface. Fields that exist
    /// but never reach a pixel (`isLive`, `sealed`, `isInternal`, `injectionKind`,
    /// `clientMsgId`, `dedupKey`/`dedupMode`, `slashSource`) are deliberately
    /// omitted: they change on paths that must NOT trigger a re-measure.
    func renderHash(into hasher: inout Hasher) {
        hasher.combine(id)
        hasher.combine(role.rawValue)
        hasher.combine(content)
        hasher.combine(source?.rawValue)
        hasher.combine(timestamp)

        // Tool rows: name, input preview, and the running/completed/error dot.
        hasher.combine(toolName)
        hasher.combine(toolInput)
        hasher.combine(toolStatus?.rawValue)

        // Inline images. Identity + count is the render-relevant part; the
        // bytes are fetched separately by MessageAttachmentImages.
        hasher.combine(attachments?.count ?? 0)
        for attachment in attachments ?? [] {
            hasher.combine(attachment.id)
            hasher.combine(attachment.type.rawValue)
            hasher.combine(attachment.name)
        }

        // Slash-command pill: the row prefers these fields over re-parsing
        // content, so a late-arriving provenance annotation changes the render.
        hasher.combine(slashCommand)
        hasher.combine(slashArgs)

        // Harness intercept banner style ("banner" vs "redirect").
        hasher.combine(interceptLevel)

        // Plan-lifecycle divider: presence of a path makes the slug tappable.
        hasher.combine(planFilePath)
        hasher.combine(markerKind)

        // Steer state. steerPending/steerApplied change the bubble's treatment;
        // steerAppliedDividerId drives the grouping pass's relocation of the
        // bubble to its application point, so a row can move without any text
        // changing. All three were added by the steer-render fix and are read
        // by EngineMessageRow / ToolGrouping.
        hasher.combine(steerPending)
        hasher.combine(steerApplied)
        hasher.combine(steerAppliedDividerId)

        // Extended-thinking summary (ThinkingRowView).
        hasher.combine(thinkingActive)
        hasher.combine(thinkingElapsedSeconds)
        hasher.combine(thinkingTotalTokens)
        hasher.combine(thinkingRedacted)
    }
}
