import Foundation

// Request/response payloads of `StudioFrame`: actions, reverse commands,
// events, transcript bodies, and the environment policy push.

// MARK: - Actions

struct StudioAction: Codable, Equatable, Sendable {
    var id: String
    var action: String
    var args: [JSONValue]
    /// The tab an action with no tab argument should act on.
    var activeTabId: String?
}

/// The `{code, message}` pair a refusal and an error both carry.
struct StudioActionFault: Codable, Equatable, Sendable {
    var code: String
    var message: String
}

struct StudioActionResult: Equatable, Sendable {
    var id: String
    var ok: Bool
    var value: JSONValue?
    /// The server declined the action (a policy or state answer, not a crash).
    var refusal: StudioActionFault?
    /// The action ran and failed.
    var error: StudioActionFault?
}

extension StudioActionResult: Codable {
    private enum CodingKeys: String, CodingKey { case id, ok, value, refusal, error }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        ok = try container.decode(Bool.self, forKey: .ok)
        value = try container.decodeJSONIfPresent(forKey: .value)
        refusal = try container.decodeIfPresent(StudioActionFault.self, forKey: .refusal)
        error = try container.decodeIfPresent(StudioActionFault.self, forKey: .error)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(ok, forKey: .ok)
        try container.encodeIfPresent(value, forKey: .value)
        try container.encodeIfPresent(refusal, forKey: .refusal)
        try container.encodeIfPresent(error, forKey: .error)
    }
}

// MARK: - Events

struct StudioEvent: Equatable, Sendable {
    var channel: String
    var payload: JSONValue
}

extension StudioEvent: Codable {
    private enum CodingKeys: String, CodingKey { case channel, payload }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        channel = try container.decode(String.self, forKey: .channel)
        payload = try container.decodeJSON(forKey: .payload)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(channel, forKey: .channel)
        try container.encode(payload, forKey: .payload)
    }
}

// MARK: - Reverse commands

struct StudioCommand: Equatable, Sendable {
    var id: String
    var command: String
    var args: JSONValue
    var timeoutMs: Int
}

extension StudioCommand: Codable {
    private enum CodingKeys: String, CodingKey { case id, command, args, timeoutMs }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        command = try container.decode(String.self, forKey: .command)
        args = try container.decodeJSON(forKey: .args)
        timeoutMs = try container.decode(Int.self, forKey: .timeoutMs)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(command, forKey: .command)
        try container.encode(args, forKey: .args)
        try container.encode(timeoutMs, forKey: .timeoutMs)
    }
}

struct StudioCommandResult: Equatable, Sendable {
    var id: String
    var ok: Bool
    var value: JSONValue?
    var error: String?
}

extension StudioCommandResult: Codable {
    private enum CodingKeys: String, CodingKey { case id, ok, value, error }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        ok = try container.decode(Bool.self, forKey: .ok)
        value = try container.decodeJSONIfPresent(forKey: .value)
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(ok, forKey: .ok)
        try container.encodeIfPresent(value, forKey: .value)
        try container.encodeIfPresent(error, forKey: .error)
    }
}

// MARK: - Transcript bodies

struct StudioBodyRequest: Codable, Equatable, Sendable {
    var tabId: String
    var instanceId: String?
    /// The `cursor` a previous page returned. Absent asks for the newest page.
    var before: String?
    /// Rows wanted. With `before` absent too, the whole transcript comes in one frame.
    var limit: Int?
    /// A dispatched agent's transcript instead of the tab's own: the
    /// dispatched conversation, and the dispatch whose activity is laid on it.
    var conversationId: String? = nil
    var dispatchId: String? = nil
}

/// Which request a paged body answers: the newest page, or the page before a row.
/// A client replaces its rows for `.newest` and prepends for `.before`.
enum StudioBodyAnchor: Equatable, Sendable {
    case newest
    case before(String)
}

struct StudioBody: Equatable, Sendable {
    var tabId: String
    var instanceId: String?
    /// A dispatch transcript's request fields, echoed.
    var conversationId: String? = nil
    var dispatchId: String? = nil
    var rows: [JSONValue]
    /// Paged replies only: whether older rows exist behind this page.
    var hasMore: Bool?
    /// Paged replies only: the next request's `before`. Absent on the oldest page.
    var cursor: String?
    /// Paged replies only: the request's own `before`, echoed. `nil` for an unpaged reply.
    var anchor: StudioBodyAnchor?
    /// Thin replies only: the transcript stream `rows` belong to, at revision
    /// `rev` of epoch `epoch`; `rows[0]` is row `startIndex` of `total`.
    /// All absent when the server had no stream to answer from.
    var streamId: String? = nil
    var epoch: String? = nil
    var rev: Int? = nil
    var total: Int? = nil
    var startIndex: Int? = nil
}

extension StudioBody: Codable {
    private enum CodingKeys: String, CodingKey { case tabId, instanceId, conversationId, dispatchId, rows, hasMore, cursor, before, streamId, epoch, rev, total, startIndex }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tabId = try container.decode(String.self, forKey: .tabId)
        instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
        conversationId = try container.decodeIfPresent(String.self, forKey: .conversationId)
        dispatchId = try container.decodeIfPresent(String.self, forKey: .dispatchId)
        rows = try container.decode([JSONValue].self, forKey: .rows)
        hasMore = try container.decodeIfPresent(Bool.self, forKey: .hasMore)
        cursor = try container.decodeIfPresent(String.self, forKey: .cursor)
        if !container.contains(.before) {
            anchor = nil
        } else if try container.decodeNil(forKey: .before) {
            anchor = .newest
        } else {
            anchor = .before(try container.decode(String.self, forKey: .before))
        }
        streamId = try container.decodeIfPresent(String.self, forKey: .streamId)
        epoch = try container.decodeIfPresent(String.self, forKey: .epoch)
        rev = try container.decodeIfPresent(Int.self, forKey: .rev)
        total = try container.decodeIfPresent(Int.self, forKey: .total)
        startIndex = try container.decodeIfPresent(Int.self, forKey: .startIndex)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(tabId, forKey: .tabId)
        try container.encodeIfPresent(instanceId, forKey: .instanceId)
        try container.encodeIfPresent(conversationId, forKey: .conversationId)
        try container.encodeIfPresent(dispatchId, forKey: .dispatchId)
        try container.encode(rows, forKey: .rows)
        try container.encodeIfPresent(hasMore, forKey: .hasMore)
        try container.encodeIfPresent(cursor, forKey: .cursor)
        switch anchor {
        case .none: break
        case .newest: try container.encodeNil(forKey: .before)
        case .before(let row): try container.encode(row, forKey: .before)
        }
        try container.encodeIfPresent(streamId, forKey: .streamId)
        try container.encodeIfPresent(epoch, forKey: .epoch)
        try container.encodeIfPresent(rev, forKey: .rev)
        try container.encodeIfPresent(total, forKey: .total)
        try container.encodeIfPresent(startIndex, forKey: .startIndex)
    }
}

// MARK: - Environment policy

struct StudioEnvironmentPolicy: Equatable, Sendable {
    /// An object, or `.null` when the environment has no enterprise policy.
    var enterprisePolicy: JSONValue
    var settingsHiddenGroups: [String]
    /// The developer surfaces this server offers this connection under the new policy.
    var developerSurfaces: DeveloperSurfaces?
    var policyHash: String
}

extension StudioEnvironmentPolicy: Codable {
    private enum CodingKeys: String, CodingKey { case enterprisePolicy, settingsHiddenGroups, developerSurfaces, policyHash }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        enterprisePolicy = try container.decodeJSON(forKey: .enterprisePolicy)
        settingsHiddenGroups = try container.decode([String].self, forKey: .settingsHiddenGroups)
        developerSurfaces = try container.decodeIfPresent(DeveloperSurfaces.self, forKey: .developerSurfaces)
        policyHash = try container.decode(String.self, forKey: .policyHash)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(enterprisePolicy, forKey: .enterprisePolicy)
        try container.encode(settingsHiddenGroups, forKey: .settingsHiddenGroups)
        try container.encodeIfPresent(developerSurfaces, forKey: .developerSurfaces)
        try container.encode(policyHash, forKey: .policyHash)
    }
}
