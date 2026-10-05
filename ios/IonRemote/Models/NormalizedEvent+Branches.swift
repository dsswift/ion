import Foundation

// MARK: - Conversation branch events

extension RemoteEvent {

    /// Decode the replies to `listBranches` / `switchBranch`.
    static func decodeBranches(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .conversationBranches:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let listing = try container.decode(ConversationBranches.self, forKey: .listing)
            return .conversationBranches(tabId: tabId, listing: listing)
        case .branchSwitchResult:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            return .branchSwitchResult(tabId: tabId, error: error)
        default:
            return nil
        }
    }

    func encodeBranches(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .conversationBranches(let tabId, let listing):
            try container.encode(TypeKey.conversationBranches, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(listing, forKey: .listing)
            return true
        case .branchSwitchResult(let tabId, let error):
            try container.encode(TypeKey.branchSwitchResult, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(error, forKey: .error)
            return true
        default:
            return false
        }
    }
}
