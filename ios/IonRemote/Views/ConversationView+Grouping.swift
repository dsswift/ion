import SwiftUI

// MARK: - ConversationView GroupedItem model
//
// Defines GroupedItem, the display-item enum consumed by Transcript when
// rendering a conversation. The grouping algorithm lives in ToolGrouping.swift
// (groupConversationItems); Transcript maps ConversationItems to GroupedItems
// and switches on them to produce rows.

extension ConversationView {

    enum GroupedItem: Identifiable {
        case single(Message)
        case toolGroup([Message])
        case compaction(Message)
        case thinking(Message)
        case agentTurn(tools: [Message], assistantMessages: [Message], isActive: Bool, thinking: Message?)
        var id: String {
            switch self {
            case .single(let msg): return msg.id
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
    }

}
