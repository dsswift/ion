import Foundation

// MARK: - Conversation lifecycle events

extension RemoteEvent {

    /// Decode task completion, copied transcripts, the prompt queue, and input
    /// prefill events.
    static func decodeStream(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {

        case .taskComplete:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let result = try container.decode(String.self, forKey: .result)
            let costUsd = try container.decode(Double.self, forKey: .costUsd)
            let durationMs = try container.decodeIfPresent(Int.self, forKey: .durationMs)
            let reason = try container.decodeIfPresent(TaskCompletionReason.self, forKey: .reason)
            return .taskComplete(tabId: tabId, result: result, costUsd: costUsd, durationMs: durationMs, reason: reason)

        case .transcript:
            return .transcript(
                tabId: try container.decode(String.self, forKey: .tabId),
                requestId: try container.decode(String.self, forKey: .requestId),
                transcript: try container.decode(String.self, forKey: .transcript),
                error: try container.decodeIfPresent(String.self, forKey: .error)
            )

        case .queueUpdate:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let prompts = try container.decode([String].self, forKey: .prompts)
            return .queueUpdate(tabId: tabId, prompts: prompts)

        case .inputPrefill:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let text = try container.decode(String.self, forKey: .text)
            let switchTo = try container.decodeIfPresent(Bool.self, forKey: .switchTo) ?? false
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            return .inputPrefill(tabId: tabId, text: text, switchTo: switchTo, instanceId: instanceId)

        default:
            return nil
        }
    }

    /// Encode these events. Returns `true` if the receiver was one of them.
    func encodeStream(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {

        case .taskComplete(let tabId, let result, let costUsd, let durationMs, let reason):
            try container.encode(TypeKey.taskComplete, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(result, forKey: .result)
            try container.encode(costUsd, forKey: .costUsd)
            try container.encodeIfPresent(durationMs, forKey: .durationMs)
            try container.encodeIfPresent(reason, forKey: .reason)
            return true

        case .transcript(let tabId, let requestId, let transcript, let error):
            try container.encode(TypeKey.transcript, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(transcript, forKey: .transcript)
            try container.encodeIfPresent(error, forKey: .error)
            return true

        case .queueUpdate(let tabId, let prompts):
            try container.encode(TypeKey.queueUpdate, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(prompts, forKey: .prompts)
            return true

        case .inputPrefill(let tabId, let text, let switchTo, let instanceId):
            try container.encode(TypeKey.inputPrefill, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(text, forKey: .text)
            if switchTo { try container.encode(true, forKey: .switchTo) }
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            return true

        default:
            return false
        }
    }
}
