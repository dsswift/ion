import Foundation

// MARK: - Streaming / conversation events

extension RemoteEvent {

    /// Decode text streaming, tool calls/results, conversation history, message
    /// updates, queue, and input prefill events.
    static func decodeStream(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .textChunk:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let text = try container.decode(String.self, forKey: .text)
            return .textChunk(tabId: tabId, text: text)

        case .toolCall:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let toolName = try container.decode(String.self, forKey: .toolName)
            let toolId = try container.decode(String.self, forKey: .toolId)
            return .toolCall(tabId: tabId, toolName: toolName, toolId: toolId)

        case .toolResult:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let toolId = try container.decode(String.self, forKey: .toolId)
            let content = try container.decode(String.self, forKey: .content)
            let isError = try container.decode(Bool.self, forKey: .isError)
            return .toolResult(tabId: tabId, toolId: toolId, content: content, isError: isError)

        case .taskComplete:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let result = try container.decode(String.self, forKey: .result)
            let costUsd = try container.decode(Double.self, forKey: .costUsd)
            return .taskComplete(tabId: tabId, result: result, costUsd: costUsd)

        case .conversationHistory:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let messages = try container.decode([Message].self, forKey: .messages)
            let hasMore = try container.decode(Bool.self, forKey: .hasMore)
            let cursor = try container.decodeIfPresent(String.self, forKey: .cursor)
            return .conversationHistory(tabId: tabId, messages: messages, hasMore: hasMore, cursor: cursor)

        case .messageAdded:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let message = try container.decode(Message.self, forKey: .message)
            return .messageAdded(tabId: tabId, message: message)

        case .messageUpdated:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let messageId = try container.decode(String.self, forKey: .messageId)
            let content = try container.decodeIfPresent(String.self, forKey: .content)
            let toolStatus = try container.decodeIfPresent(ToolStatus.self, forKey: .toolStatus)
            let toolInput = try container.decodeIfPresent(String.self, forKey: .toolInput)
            return .messageUpdated(tabId: tabId, messageId: messageId, content: content, toolStatus: toolStatus, toolInput: toolInput)

        case .queueUpdate:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let prompts = try container.decode([String].self, forKey: .prompts)
            return .queueUpdate(tabId: tabId, prompts: prompts)

        case .inputPrefill:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let text = try container.decode(String.self, forKey: .text)
            let switchTo = try container.decodeIfPresent(Bool.self, forKey: .switchTo) ?? false
            return .inputPrefill(tabId: tabId, text: text, switchTo: switchTo)

        default:
            return nil
        }
    }

    /// Encode stream events. Returns `true` if the receiver was a stream event.
    func encodeStream(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .textChunk(let tabId, let text):
            try container.encode(TypeKey.textChunk, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(text, forKey: .text)
            return true

        case .toolCall(let tabId, let toolName, let toolId):
            try container.encode(TypeKey.toolCall, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(toolName, forKey: .toolName)
            try container.encode(toolId, forKey: .toolId)
            return true

        case .toolResult(let tabId, let toolId, let content, let isError):
            try container.encode(TypeKey.toolResult, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(toolId, forKey: .toolId)
            try container.encode(content, forKey: .content)
            try container.encode(isError, forKey: .isError)
            return true

        case .taskComplete(let tabId, let result, let costUsd):
            try container.encode(TypeKey.taskComplete, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(result, forKey: .result)
            try container.encode(costUsd, forKey: .costUsd)
            return true

        case .conversationHistory(let tabId, let messages, let hasMore, let cursor):
            try container.encode(TypeKey.conversationHistory, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(messages, forKey: .messages)
            try container.encode(hasMore, forKey: .hasMore)
            try container.encodeIfPresent(cursor, forKey: .cursor)
            return true

        case .messageAdded(let tabId, let message):
            try container.encode(TypeKey.messageAdded, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(message, forKey: .message)
            return true

        case .messageUpdated(let tabId, let messageId, let content, let toolStatus, let toolInput):
            try container.encode(TypeKey.messageUpdated, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(messageId, forKey: .messageId)
            try container.encodeIfPresent(content, forKey: .content)
            try container.encodeIfPresent(toolStatus, forKey: .toolStatus)
            try container.encodeIfPresent(toolInput, forKey: .toolInput)
            return true

        case .queueUpdate(let tabId, let prompts):
            try container.encode(TypeKey.queueUpdate, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(prompts, forKey: .prompts)
            return true

        case .inputPrefill(let tabId, let text, let switchTo):
            try container.encode(TypeKey.inputPrefill, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(text, forKey: .text)
            if switchTo { try container.encode(true, forKey: .switchTo) }
            return true

        default:
            return false
        }
    }
}
