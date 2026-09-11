import Foundation

/// The engine's `engine_dispatch_lost` payload, forwarded verbatim by the
/// desktop's generic engine→wire projection as `desktop_dispatch_lost`.
///
/// A dispatch is "lost" when the engine process died while it was running: the
/// child is unrecoverable, and the engine announces one of these per orphan
/// during dispatch-state rehydration. Every field beyond the identity pair is
/// optional because the engine omits what it cannot attribute.
struct DispatchLostPayload: Codable, Sendable, Equatable {
    let dispatchId: String
    let agentName: String
    let task: String?
    let childConversationId: String?

    private enum CodingKeys: String, CodingKey {
        case dispatchId, agentName, task, childConversationId
    }

    init(dispatchId: String, agentName: String, task: String? = nil, childConversationId: String? = nil) {
        self.dispatchId = dispatchId
        self.agentName = agentName
        self.task = task
        self.childConversationId = childConversationId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        dispatchId = try container.decode(String.self, forKey: .dispatchId)
        agentName = try container.decodeIfPresent(String.self, forKey: .agentName) ?? ""
        task = try container.decodeIfPresent(String.self, forKey: .task)
        childConversationId = try container.decodeIfPresent(String.self, forKey: .childConversationId)
    }
}
