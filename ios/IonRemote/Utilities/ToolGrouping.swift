import Foundation

// MARK: - ConversationItem

/// Groups a flat `[Message]` into display items, collapsing consecutive tool
/// messages into a single `.toolGroup`.  Mirrors the desktop's
/// `groupMessages()` in `tool-helpers.ts`.
enum ConversationItem: Identifiable {
    case user(Message)
    case assistant(Message)
    case system(Message)
    case toolGroup([Message])
    case compaction(Message)
    case agentTurn(tools: [Message], assistantMessages: [Message], isActive: Bool)

    var id: String {
        switch self {
        case .user(let m):      return m.id
        case .assistant(let m): return m.id
        case .system(let m):    return m.id
        case .toolGroup(let msgs):
            // Stable ID based on the first tool in the group.
            return "tg-\(msgs.first?.id ?? "empty")"
        case .compaction(let m): return m.id
        case .agentTurn(let tools, let assistants, _):
            let anchor = tools.first?.id ?? assistants.first?.id ?? "empty"
            return "at-\(anchor)"
        }
    }
}

// MARK: - Grouping

/// Buffer-and-flush: accumulate consecutive `.tool` messages, flush them as a
/// single `.toolGroup` whenever a non-tool message appears (or at the end).
///
/// When `unifiedTurnView` is true, groups tool + assistant messages between
/// user boundaries into `.agentTurn` items (mirroring the desktop's
/// turn-grouping algorithm).
func groupConversationItems(_ messages: [Message], unifiedTurnView: Bool = false) -> [ConversationItem] {
    if unifiedTurnView {
        return groupConversationItemsUnified(messages)
    }
    return groupConversationItemsClassic(messages)
}

/// Classic grouping: consecutive tools → `.toolGroup`, everything else standalone.
private func groupConversationItemsClassic(_ messages: [Message]) -> [ConversationItem] {
    var result: [ConversationItem] = []
    var toolBuf: [Message] = []

    func flushTools() {
        if !toolBuf.isEmpty {
            result.append(.toolGroup(toolBuf))
            toolBuf = []
        }
    }

    for msg in messages {
        if msg.role == .tool {
            toolBuf.append(msg)
        } else {
            flushTools()
            switch msg.role {
            case .user:      result.append(.user(msg))
            case .assistant: result.append(.assistant(msg))
            case .system, .harness:
                if msg.content.hasPrefix("[Compaction]") {
                    result.append(.compaction(msg))
                } else {
                    result.append(.system(msg))
                }
            case .tool:      break // already handled above
            }
        }
    }
    flushTools()
    return result
}

/// Unified turn grouping: accumulate tool + assistant messages between user
/// boundaries and emit `.agentTurn` when tools are present.
private func groupConversationItemsUnified(_ messages: [Message]) -> [ConversationItem] {
    var result: [ConversationItem] = []
    var turnTools: [Message] = []
    var turnAssistants: [Message] = []

    func flushTurn() {
        if !turnTools.isEmpty {
            let isActive = turnTools.contains { $0.toolStatus == .running }
            result.append(.agentTurn(tools: turnTools, assistantMessages: turnAssistants, isActive: isActive))
        } else {
            for m in turnAssistants {
                result.append(.assistant(m))
            }
        }
        turnTools = []
        turnAssistants = []
    }

    for msg in messages {
        // System messages and compaction markers flush the turn and emit standalone.
        if msg.role == .system || msg.role == .harness || msg.content.hasPrefix("[Compaction]") {
            flushTurn()
            if msg.content.hasPrefix("[Compaction]") {
                result.append(.compaction(msg))
            } else {
                result.append(.system(msg))
            }
            continue
        }

        if msg.role == .user {
            flushTurn()
            result.append(.user(msg))
            continue
        }

        if msg.role == .tool {
            turnTools.append(msg)
        } else if msg.role == .assistant {
            turnAssistants.append(msg)
        }
    }
    flushTurn()
    return result
}

// MARK: - Consecutive assistant content

/// Returns the combined content of all consecutive assistant messages around
/// the message with the given ID.  Stops at any non-assistant boundary (tool,
/// user, system), so text is never merged across tool groups.
func consecutiveAssistantContent(for messageId: String, in messages: [Message]) -> String {
    guard let idx = messages.firstIndex(where: { $0.id == messageId }) else { return "" }

    // Expand backward.
    var start = idx
    while start > 0 && messages[start - 1].role == .assistant {
        start -= 1
    }
    // Expand forward.
    var end = idx
    while end < messages.count - 1 && messages[end + 1].role == .assistant {
        end += 1
    }

    return messages[start...end]
        .map(\.content)
        .filter { !$0.isEmpty }
        .joined(separator: "\n\n")
}

// MARK: - Tool description (ported from desktop getToolDescription)

/// Human-readable one-liner for a single tool invocation.
func toolDescription(name: String, input: String?) -> String {
    guard let input, !input.isEmpty else { return name }

    // Try full JSON parse first.
    if let data = input.data(using: .utf8),
       let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        return toolDescriptionFromDict(name: name, dict: dict)
    }

    // Fallback: regex extraction for partial/streaming JSON.
    return toolDescriptionFromRegex(name: name, raw: input)
}

/// Summary line for a group of tool messages.
/// Examples: "Read foo.ts", "Read foo.ts and 4 more tools".
func toolGroupSummary(_ tools: [Message]) -> String {
    guard let first = tools.first else { return "" }
    let desc = toolDescription(name: first.toolName ?? "Tool", input: first.toolInput)
    if tools.count == 1 { return desc }
    let remaining = tools.count - 1
    return "\(desc) and \(remaining) more tool\(remaining > 1 ? "s" : "")"
}

// MARK: - Private helpers

private func toolDescriptionFromDict(name: String, dict: [String: Any]) -> String {
    let str = { (key: String) -> String in (dict[key] as? String) ?? "" }

    switch name {
    case "Read":
        let fp = str("file_path").isEmpty ? str("path") : str("file_path")
        return fp.isEmpty ? name : "Read \(fp)"
    case "Edit":
        let fp = str("file_path")
        return fp.isEmpty ? name : "Edit \(fp)"
    case "Write":
        let fp = str("file_path")
        return fp.isEmpty ? name : "Write \(fp)"
    case "Glob":
        let p = str("pattern")
        return p.isEmpty ? name : "Search files: \(p)"
    case "Grep":
        let p = str("pattern")
        return p.isEmpty ? name : "Search: \(p)"
    case "Bash":
        let cmd = str("command")
        if cmd.isEmpty { return "Bash" }
        return cmd.count > 60 ? String(cmd.prefix(57)) + "..." : cmd
    case "WebSearch", "web_search":
        let q = str("query").isEmpty ? str("search_query") : str("query")
        return q.isEmpty ? name : "Search: \(q)"
    case "WebFetch":
        let u = str("url")
        return u.isEmpty ? name : "Fetch: \(u)"
    case "Agent":
        let v = str("prompt").isEmpty ? str("description") : str("prompt")
        return v.isEmpty ? name : "Agent: \(String(v.prefix(50)))"
    default:
        return name
    }
}

private func toolDescriptionFromRegex(name: String, raw: String) -> String {
    let str = { (key: String) -> String in
        let pattern = "\"\(key)\"\\s*:\\s*\"([^\"]*)\""
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
              let range = Range(match.range(at: 1), in: raw)
        else { return "" }
        return String(raw[range])
    }

    switch name {
    case "Read", "Edit", "Write":
        let fp = str("file_path").isEmpty ? str("path") : str("file_path")
        return fp.isEmpty ? name : "\(name) \(fp)"
    case "Glob":
        let v = str("pattern")
        return v.isEmpty ? name : "Search files: \(v)"
    case "Grep":
        let v = str("pattern")
        return v.isEmpty ? name : "Search: \(v)"
    case "Bash":
        let v = str("command")
        if v.isEmpty { return name }
        return v.count > 60 ? String(v.prefix(57)) + "..." : v
    case "WebSearch", "web_search":
        let v = str("query").isEmpty ? str("search_query") : str("query")
        return v.isEmpty ? name : "Search: \(v)"
    case "WebFetch":
        let v = str("url")
        return v.isEmpty ? name : "Fetch: \(v)"
    case "Agent":
        let v = str("description").isEmpty ? str("prompt") : str("description")
        return v.isEmpty ? name : "Agent: \(String(v.prefix(50)))"
    default:
        return name
    }
}
