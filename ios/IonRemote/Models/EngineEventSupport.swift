import Foundation

// Engine-event supporting types.
//
// Extracted from NormalizedEvent+Engine.swift to keep that file under the
// 600-line cap. The structs and helpers in this file are reused by the
// engine-event decoder/encoder living next door, but they are not
// engine-specific: AgentStateUpdate is a wire type, StatusFields is a
// wire type, AnyCodable is a generic JSON helper, etc. Splitting them
// out cleans up the codec file (which is the part that grows when the
// engine adds new event variants) and isolates these long-lived wire
// types so they can be unit-tested independently if needed.
//
// No behavior changed in the move. The types are exposed at the same
// access level (internal) and live in the same module, so existing
// callers compile unchanged.

// MARK: - AgentStateUpdate

/// Structured dispatch info for a single agent dispatch.
/// Decoded from the `dispatches` array inside agent metadata.
struct DispatchInfo: Identifiable, Sendable {
    let id: String
    let task: String
    let model: String
    let conversationId: String
    let elapsed: Double?
    let status: String
    let startTime: Double?

    init(from dict: [String: Any]) {
        id = dict["id"] as? String ?? ""
        task = dict["task"] as? String ?? ""
        model = dict["model"] as? String ?? ""
        conversationId = dict["conversationId"] as? String ?? ""
        status = dict["status"] as? String ?? ""
        if let e = dict["elapsed"] as? Double { elapsed = e }
        else if let e = dict["elapsed"] as? Int { elapsed = Double(e) }
        else { elapsed = nil }
        if let st = dict["startTime"] as? Double { startTime = st }
        else if let st = dict["startTime"] as? Int { startTime = Double(st) }
        else { startTime = nil }
    }
}

/// Structured agent state sent from the desktop engine runtime.
/// The wire format has `name`, `status`, and a `metadata` map containing
/// all other fields (displayName, type, visibility, invited, etc.).
struct AgentStateUpdate: Codable, Identifiable, Sendable {
    /// Engine-generated unique identifier per dispatch. Falls back to name
    /// for extension-managed roster entries that don't carry an id.
    var id: String { agentId ?? name }
    let agentId: String?
    let name: String
    let displayName: String
    let type: String          // "chief", "specialist", "staff", "consultant"
    let visibility: String    // "always", "sticky", "ephemeral"
    let status: String        // "idle", "running", "done", "error"
    let invited: Bool
    let task: String?
    let lastWork: String?
    let fullOutput: String?
    let elapsed: Double?
    let cost: Double?
    let color: String?
    let model: String?
    let startTime: Double?   // Unix timestamp in seconds
    /// Derived from `dispatches[]` — single source of truth for conversation IDs.
    /// Deduplicated: when multiple dispatches share a session, the ID appears once.
    var conversationIds: [String] {
        var seen = Set<String>()
        return dispatches.compactMap { d in
            guard !d.conversationId.isEmpty, !seen.contains(d.conversationId) else { return nil }
            seen.insert(d.conversationId)
            return d.conversationId
        }
    }
    let dispatches: [DispatchInfo]

    /// Whether this agent should be shown in the UI based on visibility rules.
    var isVisible: Bool {
        switch visibility {
        case "always": return true
        case "sticky": return invited
        case "ephemeral": return status == "running"
        default: return true
        }
    }

    private enum CodingKeys: String, CodingKey {
        case name, status, metadata
        case agentId = "id"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        agentId = try container.decodeIfPresent(String.self, forKey: .agentId)
        status = try container.decode(String.self, forKey: .status)
        let meta = try container.decodeIfPresent([String: AnyCodable].self, forKey: .metadata) ?? [:]

        displayName = (meta["displayName"]?.value as? String) ?? name
        type = (meta["type"]?.value as? String) ?? "specialist"
        visibility = (meta["visibility"]?.value as? String) ?? "ephemeral"
        task = meta["task"]?.value as? String
        lastWork = meta["lastWork"]?.value as? String
        fullOutput = meta["fullOutput"]?.value as? String
        color = meta["color"]?.value as? String
        model = meta["model"]?.value as? String
        if let st = meta["startTime"]?.value as? Double {
            startTime = st
        } else if let st = meta["startTime"]?.value as? Int {
            startTime = Double(st)
        } else {
            startTime = nil
        }
        if let rawDispatches = meta["dispatches"]?.value as? [AnyCodable] {
            dispatches = rawDispatches.compactMap { item -> DispatchInfo? in
                guard let dict = item.value as? [String: AnyCodable] else { return nil }
                let plain = dict.mapValues { $0.value }
                return DispatchInfo(from: plain)
            }
        } else {
            dispatches = []
        }

        // Bool and numeric values may arrive as various types
        if let inv = meta["invited"]?.value as? Bool {
            invited = inv
        } else if let inv = meta["invited"]?.value as? Int {
            invited = inv != 0
        } else {
            invited = false
        }
        if let e = meta["elapsed"]?.value as? Double {
            elapsed = e
        } else if let e = meta["elapsed"]?.value as? Int {
            elapsed = Double(e)
        } else {
            elapsed = nil
        }
        if let c = meta["cost"]?.value as? Double {
            cost = c
        } else if let c = meta["cost"]?.value as? Int {
            cost = Double(c)
        } else {
            cost = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(status, forKey: .status)
        var meta: [String: AnyCodable] = [
            "displayName": AnyCodable(displayName),
            "type": AnyCodable(type),
            "visibility": AnyCodable(visibility),
            "invited": AnyCodable(invited),
        ]
        if let task { meta["task"] = AnyCodable(task) }
        if let lastWork { meta["lastWork"] = AnyCodable(lastWork) }
        if let fullOutput { meta["fullOutput"] = AnyCodable(fullOutput) }
        if let elapsed { meta["elapsed"] = AnyCodable(elapsed) }
        if let cost { meta["cost"] = AnyCodable(cost) }
        if let color { meta["color"] = AnyCodable(color) }
        if let model { meta["model"] = AnyCodable(model) }
        if let startTime { meta["startTime"] = AnyCodable(startTime) }
        // dispatches are read-only from the engine; no need to encode back
        try container.encode(meta, forKey: .metadata)
    }
}

// MARK: - StatusFields

/// Structured status bar fields from the desktop engine runtime.
/// Mirrors `StatusFields` in `src/shared/types.ts`.
struct StatusFields: Codable, Sendable {
    var label: String
    let state: String
    let sessionId: String?       // omitempty in Go — may be absent
    let team: String?            // omitempty in Go — may be absent
    let model: String
    let contextPercent: Double
    let contextWindow: Int
    let totalCostUsd: Double?
    let permissionDenials: [PermissionDenialEntry]?
    /// Friendly display name broadcast by the extension (e.g. "Chief of Staff").
    let extensionName: String?
    /// Number of background dispatch agents still running when the parent LLM
    /// turn ends. When > 0, the engine is "idle" but background work is in
    /// progress. Clients use this to keep the tab status active and the
    /// interrupt button visible.
    let backgroundAgents: Int?

    /// Returns a copy with the label replaced.
    func withLabel(_ newLabel: String) -> StatusFields {
        var copy = self
        copy.label = newLabel
        return copy
    }
}

/// A permission denial record within StatusFields.
struct PermissionDenialEntry: Codable, Sendable {
    let toolName: String
    let toolUseId: String
    let toolInput: [String: AnyCodable]?
}

/// Phase 3 of the state-management overhaul. Typed counterpart to
/// `StatusFields` that carries the engine's authoritative per-session
/// status in one payload. Mirrors `types.SessionStatus` in Go;
/// `desktop/src/shared/types-engine.ts` SessionStatus is the desktop
/// mirror.
///
/// Why a new type exists. The legacy `engine_status` event packs
/// state + costs + denials + model into `StatusFields`, and consumers
/// must infer "is this session running" from `state` alone. The new
/// type adds:
///   - `lastEmittedAt`: freshness contract; consumers can tell engine
///     silence apart from stable idle.
///   - `hasInflightRun`: distinguishes "engine has no live run" from
///     "no event received yet". The engine cross-checks this against
///     its backend's run set so the flag cannot drift.
///   - `stateSince`: reserved for the Phase 5 state-machine; currently
///     emitted as zero.
///
/// Wire identity: emitted via `engine_session_status` events alongside
/// the legacy `engine_status`. Both events carry the same authoritative
/// state; Phase 4 removes the legacy emission once every in-repo
/// consumer has migrated to read this type.
struct SessionStatus: Codable, Sendable {
    let key: String
    let state: String
    let stateSince: Int64?
    let lastEmittedAt: Int64
    let hasInflightRun: Bool?
    let backgroundAgentCount: Int?
    let permissionDenialsPending: [PermissionDenialEntry]?
    let model: String?
    let contextPercent: Int?
    let contextWindow: Int?
    let totalCostUsd: Double?
    let sessionId: String?
    let extensionName: String?
}

// MARK: - ConversationInstancePayload

/// Wire type for engine instance added/removed events.
struct ConversationInstancePayload: Codable, Sendable {
    let id: String
    let label: String
}

// MARK: - EngineMessageEndUsage

/// Nested usage stats within an engine_message_end event.
struct EngineMessageEndUsage: Codable, Sendable {
    let inputTokens: Int
    let outputTokens: Int
    let contextPercent: Double
    let cost: Double
}

// MARK: - EngineCommandListing

/// One entry in an engine_command_registry snapshot. Mirrors the Go
/// `types.EngineCommandListing` shape exactly: a bare slash-command
/// name (e.g. "clear", "ion--review-changes") plus an optional human-
/// readable description the autocomplete UI can surface.
///
/// Snapshot semantics: every `engine_command_registry` event carries a
/// COMPLETE list of the session's extension-registered slash commands.
/// Consumers REPLACE their cached set with the payload; never merge.
/// An empty `commands: []` array is the authoritative "no extension
/// commands" signal — drop every entry. See
/// docs/architecture/agent-state.md for the canonical snapshot-replace
/// pattern.
///
/// iOS does not yet consume the registry for autocomplete; this type
/// exists so the wire stays uniform with the desktop (every engine
/// event the desktop sees, iOS sees) and so future iOS work can adopt
/// it without a Swift contract change. The desktop's prompt pipeline
/// is the only consumer that acts on the listing today.
struct EngineCommandListing: Codable, Equatable, Sendable {
    let name: String
    let description: String?
}

// MARK: - AnyCodable

/// Type-erased Codable wrapper for arbitrary JSON values.
struct AnyCodable: Codable, Sendable {
    let value: any Sendable

    init(_ value: any Sendable) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let str = try? container.decode(String.self) { value = str }
        else if let int = try? container.decode(Int.self) { value = int }
        else if let double = try? container.decode(Double.self) { value = double }
        else if let bool = try? container.decode(Bool.self) { value = bool }
        else if let dict = try? container.decode([String: AnyCodable].self) { value = dict }
        else if let arr = try? container.decode([AnyCodable].self) { value = arr }
        else if container.decodeNil() { value = NSNull() }
        else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Unsupported JSON type")
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let s as String: try container.encode(s)
        case let i as Int: try container.encode(i)
        case let d as Double: try container.encode(d)
        case let b as Bool: try container.encode(b)
        case let dict as [String: AnyCodable]: try container.encode(dict)
        case let arr as [AnyCodable]: try container.encode(arr)
        case is NSNull: try container.encodeNil()
        default:
            throw EncodingError.invalidValue(
                value,
                .init(codingPath: encoder.codingPath, debugDescription: "Unsupported type for encoding")
            )
        }
    }
}
