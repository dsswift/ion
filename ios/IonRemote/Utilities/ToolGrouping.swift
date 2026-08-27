import Foundation

// MARK: - ConversationItem

/// Groups a flat `[Message]` into display items, collapsing consecutive tool
/// messages into a single `.toolGroup`.  Mirrors the desktop's
/// `groupMessages()` in `tool-helpers.ts`.
enum ConversationItem: Identifiable {
    case user(Message)
    case assistant(Message)
    case system(Message)
    /// Extended-thinking reasoning block (issue #158). Rendered as its own
    /// collapsed-by-default row (ThinkingRowView) inline in turn order,
    /// before the assistant text it preceded.
    case thinking(Message)
    case toolGroup([Message])
    case compaction(Message)
    case agentTurn(tools: [Message], assistantMessages: [Message], isActive: Bool, thinking: Message?)

    var id: String {
        switch self {
        case .user(let m):      return m.id
        case .assistant(let m): return m.id
        case .system(let m):    return m.id
        case .thinking(let m):  return m.id
        case .toolGroup(let msgs):
            // Stable ID based on the first tool in the group.
            return "tg-\(msgs.first?.id ?? "empty")"
        case .compaction(let m): return m.id
        case .agentTurn(let tools, let assistants, _, _):
            // thinking intentionally excluded from identity anchor — the turn
            // is identified by its tools/assistants, not by reasoning content.
            let anchor = tools.first?.id ?? assistants.first?.id ?? "empty"
            return "at-\(anchor)"
        }
    }
}

// MARK: - Steer relocation

/// A mid-turn steer is inserted optimistically where the user typed it, but the
/// engine applies it later and emits a "── Steer applied" divider at the point
/// it took effect. Rendering the bubble at its send position strands the text
/// rows above the divider that announces it.
///
/// `handleEngineSteerInjected` stamps the resolved bubble and its divider with a
/// shared `steerAppliedDividerId`. The grouping pass uses that key to HOLD the
/// bubble back and re-emit it immediately after its divider.
///
/// Pure render-time relocation: the stored conversation is untouched and the
/// pairing fields are client-only. On a history reload the engine's file already
/// carries the turn at its applied position, the ids are absent, and grouping
/// emits everything in natural order. Desktop parity: `isRelocatableSteer` in
/// `tool-helpers.ts` — the two implementations are lockstep.
private func isRelocatableSteer(_ msg: Message) -> Bool {
    msg.role == .user && msg.steerAppliedDividerId != nil
}

/// Emit any steer bubbles still held when the list ends. Their divider never
/// arrived (the run died before the drain, or the divider fell outside the
/// loaded window), so they are emitted in insertion order rather than dropped —
/// a steer must never vanish from the scrollback.
private func flushHeldSteers(_ held: inout [(key: String, msg: Message)], into result: inout [ConversationItem]) {
    for entry in held {
        result.append(.user(entry.msg))
    }
    held.removeAll()
}

/// Remove and return the steer held for `dividerId`, if any.
private func takeHeldSteer(_ held: inout [(key: String, msg: Message)], dividerId: String) -> Message? {
    guard let idx = held.firstIndex(where: { $0.key == dividerId }) else { return nil }
    return held.remove(at: idx).msg
}

// MARK: - Prior-user image deduplication

/// Removes later image attachments that exactly match an earlier user-image
/// content hash. Providers can return an input image in a later tool or
/// assistant message; rendering both copies duplicates one user-supplied image.
///
/// This is display-only. It returns copies of affected messages and never
/// mutates the source transcript, so history reconciliation keeps full data.
/// Only non-empty hashes match. Paths and names are deliberately ignored: they
/// are transport details, not image identity.
func filterPriorUserContentHashAttachments(_ messages: [Message]) -> [Message] {
    var priorUserHashes = Set<String>()
    var visible: [Message] = []

    for message in messages {
        var filtered = message
        var removedEcho = false
        if (message.role == .assistant || message.role == .tool), let attachments = message.attachments {
            let remaining = attachments.filter { attachment in
                guard attachment.type == .image,
                      let contentHash = attachment.contentHash,
                      contentHash.range(of: "^[A-Fa-f0-9]{64}$", options: .regularExpression) != nil else {
                    return true
                }
                let keep = !priorUserHashes.contains(contentHash.lowercased())
                if !keep { removedEcho = true }
                return keep
            }
            filtered.attachments = remaining.isEmpty ? nil : remaining
        }

        if message.role == .user {
            for attachment in message.attachments ?? [] where attachment.type == .image {
                if let contentHash = attachment.contentHash,
                   contentHash.range(of: "^[A-Fa-f0-9]{64}$", options: .regularExpression) != nil {
                    priorUserHashes.insert(contentHash.lowercased())
                }
            }
        }

        // An image-only provider row exists solely to carry its attachment. If
        // every attachment repeated a prior user image, remove this display row
        // too; otherwise iOS leaves blank vertical space after deduplication.
        if message.role == .assistant, removedEcho, filtered.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           filtered.attachments == nil {
            continue
        }
        visible.append(filtered)
    }
    return visible
}

// MARK: - Plan implementation boundary

private func isImplementationDivider(_ message: Message) -> Bool {
    message.role == .system && message.content.hasPrefix("── Implementing plan")
}

private func planPath(at timestamp: Double, in messages: [Message]) -> String? {
    messages
        .filter { ($0.timestamp ?? 0) <= timestamp && $0.planFilePath?.isEmpty == false }
        .max { ($0.timestamp ?? 0) < ($1.timestamp ?? 0) }?
        .planFilePath
}

/// Materialize the plan implementation divider from the durable user-turn flag.
/// Older live clients can already supply this renderer-only divider, so keep it
/// and do not add a duplicate. This matches the Desktop grouping behavior.
func materializePlanImplementationDividers(_ messages: [Message]) -> [Message] {
    var result: [Message] = []
    var hasDividerInTurn = false

    for message in messages {
        if message.role == .user, message.implementationPhase == true, !hasDividerInTurn {
            let timestamp = message.timestamp ?? Date().timeIntervalSince1970 * 1000
            let path = planPath(at: timestamp, in: messages)
            let slug = path.map { URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent }
            let formatter = DateFormatter()
            formatter.dateStyle = .none
            formatter.timeStyle = .short
            let time = formatter.string(from: Date(timeIntervalSince1970: timestamp / 1000))
            let suffix = slug.flatMap { $0.isEmpty ? nil : " · \($0)" } ?? ""
            var divider = Message(
                id: "\(message.id):implementation-divider",
                role: .system,
                content: "── Implementing plan at \(time)\(suffix) ──",
                timestamp: timestamp
            )
            divider.planFilePath = path
            result.append(divider)
        }

        result.append(message)
        if message.role == .user {
            hasDividerInTurn = false
        } else if isImplementationDivider(message) {
            hasDividerInTurn = true
        }
    }
    return result
}

// MARK: - Grouping

/// Buffer-and-flush: accumulate consecutive `.tool` messages, flush them as a
/// single `.toolGroup` whenever a non-tool message appears (or at the end).
///
/// When `unifiedTurnView` is true, groups tool + assistant messages between
/// user boundaries into `.agentTurn` items (mirroring the desktop's
/// turn-grouping algorithm).
func groupConversationItems(_ messages: [Message], unifiedTurnView: Bool = false) -> [ConversationItem] {
    let displayMessages = materializePlanImplementationDividers(
        filterPriorUserContentHashAttachments(messages)
    )
    if unifiedTurnView {
        return groupConversationItemsUnified(displayMessages)
    }
    return groupConversationItemsClassic(displayMessages)
}

/// Classic grouping: consecutive tools → `.toolGroup`, everything else standalone.
private func groupConversationItemsClassic(_ messages: [Message]) -> [ConversationItem] {
    var result: [ConversationItem] = []
    var toolBuf: [Message] = []
    // Steer bubbles held until their "Steer applied" divider is reached, in
    // insertion order, keyed by the shared steerAppliedDividerId.
    var heldSteers: [(key: String, msg: Message)] = []

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
            case .user:
                // Hold an applied steer until its divider; emit anything else here.
                if isRelocatableSteer(msg), let key = msg.steerAppliedDividerId {
                    heldSteers.append((key: key, msg: msg))
                } else {
                    result.append(.user(msg))
                }
            case .assistant: result.append(.assistant(msg))
            case .thinking:  result.append(.thinking(msg))
            case .system, .harness:
                if msg.backgroundWork != nil {
                    continue
                }
                if msg.content.hasPrefix("[Compaction]") {
                    result.append(.compaction(msg))
                } else {
                    result.append(.system(msg))
                    if let steer = takeHeldSteer(&heldSteers, dividerId: msg.id) {
                        result.append(.user(steer))
                    }
                }
            case .tool:      break // already handled above
            }
        }
    }
    flushTools()
    flushHeldSteers(&heldSteers, into: &result)
    return result
}

/// Unified turn grouping: accumulate tool + assistant messages between user
/// boundaries and emit `.agentTurn` when tools are present.
/// A turn's thinking rows are MERGED into a single display row
/// (mergeThinkingMessages) and hoisted into the turn header when tools are
/// present, matching the desktop's `flushTurn` behavior in `tool-helpers.ts`.
private func groupConversationItemsUnified(_ messages: [Message]) -> [ConversationItem] {
    var result: [ConversationItem] = []
    var turnTools: [Message] = []
    var turnAssistants: [Message] = []
    // All thinking rows for the current turn, in stream order. A single run
    // makes many API rounds and each opens its own thinking block, so a turn
    // routinely accumulates many `.thinking` rows. They merge into ONE
    // display row per turn at flush time — one continuous thought stream
    // pinned at the top of the turn, mirroring the desktop's grouping.
    var turnThinking: [Message] = []
    // Steer bubbles held until their "Steer applied" divider is reached, in
    // insertion order, keyed by the shared steerAppliedDividerId.
    var heldSteers: [(key: String, msg: Message)] = []

    func flushTurn() {
        // One merged thought row per turn (or nil when the model did not
        // reason this turn).
        let merged = turnThinking.isEmpty ? nil : mergeThinkingMessages(turnThinking)
        if !turnTools.isEmpty {
            let isActive = turnTools.contains { $0.toolStatus == .running }
            result.append(.agentTurn(
                tools: turnTools,
                assistantMessages: turnAssistants,
                isActive: isActive,
                thinking: merged
            ))
        } else {
            // No tools — emit the merged thinking row standalone first (if
            // any), then each assistant message. Thinking precedes assistant
            // output, matching the engine's block_start → text ordering
            // within a turn.
            if let t = merged {
                result.append(.thinking(t))
            }
            for m in turnAssistants {
                result.append(.assistant(m))
            }
        }
        turnTools = []
        turnAssistants = []
        turnThinking = []
    }

    for msg in messages {
        // System messages and compaction markers flush the turn and emit standalone.
        // Background completion records are machine context: matching work folds
        // onto its source tool row before grouping; unmatched legacy records drop.
        if msg.role == .system || msg.role == .harness || msg.content.hasPrefix("[Compaction]") {
            if msg.backgroundWork != nil {
                continue
            }
            flushTurn()
            if msg.content.hasPrefix("[Compaction]") {
                result.append(.compaction(msg))
            } else {
                result.append(.system(msg))
                if let steer = takeHeldSteer(&heldSteers, dividerId: msg.id) {
                    result.append(.user(steer))
                }
            }
            continue
        }

        if msg.role == .user {
            // An applied steer belongs at its divider, not at its send
            // position, so hold it back. It does NOT flush the turn here — the
            // steer landed mid-turn, and flushing on it would split the agent
            // turn at the wrong point.
            if isRelocatableSteer(msg), let key = msg.steerAppliedDividerId {
                heldSteers.append((key: key, msg: msg))
            } else {
                flushTurn()
                result.append(.user(msg))
            }
            continue
        }

        // Accumulate the turn's thinking rows; they merge into one display
        // row per turn at flush time (see flushTurn). Never emitted
        // standalone mid-turn — that is what fragmented a turn into dozens
        // of independent "Thought" rows (desktop parity: tool-helpers.ts).
        if msg.role == .thinking {
            turnThinking.append(msg)
            continue
        }

        if msg.role == .tool {
            turnTools.append(msg)
        } else if msg.role == .assistant {
            turnAssistants.append(msg)
        }
    }
    flushTurn()
    flushHeldSteers(&heldSteers, into: &result)
    return result
}

// MARK: - Thinking merge (one thought row per turn)

/// Merge all of a turn's thinking rows into ONE display message (unified
/// turn view). Display-level only — the underlying messages are never
/// mutated. Mirrors the desktop's `mergeThinkingMessages` in
/// `thinking-block-helpers.ts`; the two implementations are lockstep.
///
/// Field rules:
///   - id: the FIRST row's id (stable identity — no re-render churn as
///     later blocks arrive).
///   - content: non-empty contents joined with a blank line, in order.
///   - thinkingActive: true if ANY row is still active.
///   - thinkingElapsedSeconds / thinkingTotalTokens: summed across rows
///     (nil when no row carried the field).
///   - thinkingRedacted: true only when EVERY row is redacted.
///
/// Single-row input returns the row unchanged.
func mergeThinkingMessages(_ msgs: [Message]) -> Message {
    guard msgs.count > 1 else { return msgs[0] }

    let contents = msgs.map(\.content).filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var elapsed: Double?
    var tokens: Int?
    for m in msgs {
        if let s = m.thinkingElapsedSeconds { elapsed = (elapsed ?? 0) + s }
        if let t = m.thinkingTotalTokens { tokens = (tokens ?? 0) + t }
    }

    var merged = msgs[0]
    merged.content = contents.joined(separator: "\n\n")
    merged.thinkingActive = msgs.contains { $0.thinkingActive }
    merged.thinkingElapsedSeconds = elapsed
    merged.thinkingTotalTokens = tokens
    merged.thinkingRedacted = msgs.allSatisfy { $0.thinkingRedacted }
    return merged
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
    if let data = input.data(using: .utf8) {
        do {
            if let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return toolDescriptionFromDict(name: name, dict: dict)
            }
            DiagnosticLog.log("tool input JSON has unexpected shape", tag: "model.tool", level: .debug,
                              fields: ["tool": name])
        } catch {
            DiagnosticLog.log("tool input JSON decode failed; using regex fallback", tag: "model.tool", level: .debug,
                              fields: ["tool": name, "error": error.localizedDescription])
        }
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

/// Live progress for a collapsed tool group. The last running row is current
/// because message order matches tool event order. Failed tools count as used.
func activeToolProgress(_ tools: [Message]) -> (currentToolDescription: String, usedCount: Int)? {
    guard let currentTool = tools.last(where: { $0.toolStatus == .running }) else {
        return nil
    }

    return (
        currentToolDescription: toolDescription(
            name: currentTool.toolName ?? "Tool",
            input: currentTool.toolInput
        ),
        usedCount: tools.filter { $0.toolStatus != .running }.count
    )
}

/// Failure summary for a collapsed tool group.
///
/// Returns the count of tools with `.error` status, the total tool count,
/// and whether any tool is still `.running`.
///
/// Callers use these values to choose the three-state icon/color and to
/// build the failure suffix string:
///   - running == true  → spinner wins; suppress the suffix.
///   - failed == 0      → all-success: `checkmark.circle.fill` / `statusDone`.
///   - failed == settled (total - runningCount) → all-failed: `xmark.circle.fill` / `statusError`.
///   - otherwise        → mixed: `exclamationmark.triangle.fill` / `statusWarning`, append ", N failed".
///
/// `settled` excludes running tools because a running tool hasn't produced
/// an outcome yet — counting it against the denominator would make partial
/// failures look worse than they are.
func toolGroupFailureSummary(_ tools: [Message]) -> (failed: Int, total: Int, running: Bool) {
    let total = tools.count
    let failedCount = tools.filter { $0.toolStatus == .error }.count
    let runningCount = tools.filter { $0.toolStatus == .running }.count
    return (failed: failedCount, total: total, running: runningCount > 0)
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
        let regex: NSRegularExpression
        do {
            regex = try NSRegularExpression(pattern: pattern)
        } catch {
            DiagnosticLog.log("tool description regex construction failed", tag: "model.tool", level: .warn,
                              fields: ["tool": name, "key": key, "error": error.localizedDescription])
            return ""
        }
        guard let match = regex.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
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
