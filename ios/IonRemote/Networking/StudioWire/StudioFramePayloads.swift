import Foundation

// The payload of each `StudioFrame` case, one struct per frame type in
// `packages/shared/src/studio-wire/types.ts`. Members this client does not
// interpret (snapshots, policies, action values) stay `JSONValue`.

/// The Studio wire protocol version this client speaks (`studio-wire/version.ts`).
let studioProtocolVersion = 1

/// The one channel a thin connection's conversation and tab state rides (`studio-wire/channels.ts`).
let studioThinEventChannel = "studio:thin-event"

/// The channel the server asks for this client's own diagnostic log lines on
/// (`studio-wire/channels.ts`). Its payload is `{ sinceSeq }`; the answer is the
/// `clientLog.append` action.
let studioClientLogRequestChannel = "studio:client-log-request"

// MARK: - Hello

/// How a client proves who it is in `studio_hello`.
enum StudioCredential: Equatable, Sendable {
    case local
    case paired(clientId: String, proof: String)
    case bearer(token: String)
    case session

    var kind: String {
        switch self {
        case .local: return "local"
        case .paired: return "paired"
        case .bearer: return "bearer"
        case .session: return "session"
        }
    }
}

extension StudioCredential: Codable {
    private enum CodingKeys: String, CodingKey { case kind, clientId, proof, token }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "local": self = .local
        case "session": self = .session
        case "bearer": self = .bearer(token: try container.decode(String.self, forKey: .token))
        case "paired":
            self = .paired(
                clientId: try container.decode(String.self, forKey: .clientId),
                proof: try container.decode(String.self, forKey: .proof)
            )
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "unknown credential kind \(kind)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        switch self {
        case .local, .session: break
        case .bearer(let token): try container.encode(token, forKey: .token)
        case .paired(let clientId, let proof):
            try container.encode(clientId, forKey: .clientId)
            try container.encode(proof, forKey: .proof)
        }
    }
}

/// The capability a client advertises to say it answers `studio_ping`.
/// Mirrors `WIRE_PING_CAPABILITY` in `packages/shared/src/studio-wire/types.ts`.
let studioWirePingCapability = "wire-ping"

/// `studio_ping` and `studio_pong`: the same shape both ways.
///
/// The server times the round trip on ITS clock, so `t` is never differenced
/// against a local reading -- two machines' clocks disagree, and that is
/// exactly the correction this measure exists to avoid needing.
struct StudioPing: Codable, Equatable, Sendable {
    var nonce: String
    var t: Double
}

struct StudioHello: Codable, Equatable, Sendable {
    var protocolVersion: Int
    var clientId: String
    /// `desktop`, `web`, `mobile-bridge`, or `mobile`.
    var clientKind: String
    var capabilities: [String]
    var credential: StudioCredential
    /// `mirror` or `thin`. Absent means `mirror`.
    var view: String?

    /// The hello this app sends: a phone asking for the thin view.
    static func thinMobile(clientId: String, credential: StudioCredential) -> StudioHello {
        StudioHello(
            protocolVersion: studioProtocolVersion,
            clientId: clientId,
            clientKind: "mobile",
            // This client answers no reverse commands, so the only capability
            // it claims is `wire-ping`: it answers the server's latency probe.
            // A client that does not claim it is never probed, because a frame
            // it could not decode would close its connection.
            capabilities: [studioWirePingCapability],
            credential: credential,
            view: "thin"
        )
    }
}

// MARK: - Welcome

struct StudioPrincipalSummary: Codable, Equatable, Sendable {
    var subject: String
    var displayName: String?
    var provider: String?
    var kind: String?
    var username: String?
    var email: String?
}

struct StudioWelcome: Equatable, Sendable {
    var protocolVersion: Int
    var environmentId: String
    var label: String
    var platform: String
    var serverVersion: String
    var engineVersion: String
    var capabilities: [String]
    var principal: StudioPrincipalSummary
    var scopes: [String]
    /// The pairing this connection authenticated through. Absent for every door but `paired`.
    var pairedClientId: String?
    /// The relays the server is reachable through, repeated at every connect.
    var relays: [StudioEnvironmentRelay]?
    /// The LAN addresses the server answers on, repeated at every connect.
    /// Absent from a server that predates the field, which is why the direct
    /// route still works without it — it just cannot be learned over a relay.
    var directAddresses: [String]?
    /// An object, or `.null` when the environment has no enterprise policy.
    var enterprisePolicy: JSONValue
    var settingsHiddenGroups: [String]
    /// The developer surfaces this server offers this connection. Absent from
    /// a server that predates the field, which offers them all.
    var developerSurfaces: DeveloperSurfaces?
    /// Hash of `enterprisePolicy`. Absent from a server that predates the field.
    var policyHash: String?
    /// Whether this connection runs on the server's own host. Absent from a
    /// server that predates the field, which reads as not on the host.
    var onHost: Bool?
    /// The first-paint snapshot, uninterpreted. A thin view's snapshot carries no tabs.
    var snapshot: JSONValue
}

extension StudioWelcome: Codable {
    private enum CodingKeys: String, CodingKey {
        case protocolVersion, environmentId, label, platform, serverVersion, engineVersion
        case capabilities, principal, scopes, pairedClientId, relays, directAddresses
        case enterprisePolicy, settingsHiddenGroups, developerSurfaces, policyHash, onHost, snapshot
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
        environmentId = try container.decode(String.self, forKey: .environmentId)
        label = try container.decode(String.self, forKey: .label)
        platform = try container.decode(String.self, forKey: .platform)
        serverVersion = try container.decode(String.self, forKey: .serverVersion)
        engineVersion = try container.decode(String.self, forKey: .engineVersion)
        capabilities = try container.decode([String].self, forKey: .capabilities)
        principal = try container.decode(StudioPrincipalSummary.self, forKey: .principal)
        scopes = try container.decode([String].self, forKey: .scopes)
        pairedClientId = try container.decodeIfPresent(String.self, forKey: .pairedClientId)
        if container.contains(.relays) {
            // One unusable relay entry must not cost the whole welcome.
            relays = try container.decode([StudioEnvironmentRelay.Lenient].self, forKey: .relays).compactMap(\.relay)
        } else {
            relays = nil
        }
        directAddresses = try container.decodeIfPresent([String].self, forKey: .directAddresses)
        enterprisePolicy = try container.decodeJSON(forKey: .enterprisePolicy)
        settingsHiddenGroups = try container.decode([String].self, forKey: .settingsHiddenGroups)
        developerSurfaces = try container.decodeIfPresent(DeveloperSurfaces.self, forKey: .developerSurfaces)
        policyHash = try container.decodeIfPresent(String.self, forKey: .policyHash)
        onHost = try container.decodeIfPresent(Bool.self, forKey: .onHost)
        snapshot = try container.decodeJSON(forKey: .snapshot)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(protocolVersion, forKey: .protocolVersion)
        try container.encode(environmentId, forKey: .environmentId)
        try container.encode(label, forKey: .label)
        try container.encode(platform, forKey: .platform)
        try container.encode(serverVersion, forKey: .serverVersion)
        try container.encode(engineVersion, forKey: .engineVersion)
        try container.encode(capabilities, forKey: .capabilities)
        try container.encode(principal, forKey: .principal)
        try container.encode(scopes, forKey: .scopes)
        try container.encodeIfPresent(pairedClientId, forKey: .pairedClientId)
        try container.encodeIfPresent(relays, forKey: .relays)
        try container.encodeIfPresent(directAddresses, forKey: .directAddresses)
        try container.encode(enterprisePolicy, forKey: .enterprisePolicy)
        try container.encode(settingsHiddenGroups, forKey: .settingsHiddenGroups)
        try container.encodeIfPresent(developerSurfaces, forKey: .developerSurfaces)
        try container.encodeIfPresent(policyHash, forKey: .policyHash)
        try container.encodeIfPresent(onHost, forKey: .onHost)
        try container.encode(snapshot, forKey: .snapshot)
    }
}

// MARK: - Refused and close

/// Why a hello was refused. A reason this build does not know is kept, not dropped.
enum StudioRefusalReason: Equatable, Sendable {
    case protocolVersion, unauthorized, notReady, engineIncompatible, duplicateClient, scope
    case unknown(String)

    init(wire: String) {
        switch wire {
        case "protocol_version": self = .protocolVersion
        case "unauthorized": self = .unauthorized
        case "not_ready": self = .notReady
        case "engine_incompatible": self = .engineIncompatible
        case "duplicate_client": self = .duplicateClient
        case "scope": self = .scope
        default: self = .unknown(wire)
        }
    }

    var wire: String {
        switch self {
        case .protocolVersion: return "protocol_version"
        case .unauthorized: return "unauthorized"
        case .notReady: return "not_ready"
        case .engineIncompatible: return "engine_incompatible"
        case .duplicateClient: return "duplicate_client"
        case .scope: return "scope"
        case .unknown(let wire): return wire
        }
    }

    /// Whether dialing again with the same credential can succeed. A server
    /// that is still starting will be ready later; a rejected credential, a
    /// version outside the window, or a missing scope will be rejected again.
    var isRetryable: Bool {
        switch self {
        case .notReady, .engineIncompatible, .duplicateClient: return true
        case .protocolVersion, .unauthorized, .scope, .unknown: return false
        }
    }
}

struct StudioRefused: Equatable, Sendable {
    var reason: StudioRefusalReason
    var detail: String?
    var requiredProtocolVersion: Int?
}

extension StudioRefused: Codable {
    private enum CodingKeys: String, CodingKey { case reason, detail, requiredProtocolVersion }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        reason = StudioRefusalReason(wire: try container.decode(String.self, forKey: .reason))
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
        requiredProtocolVersion = try container.decodeIfPresent(Int.self, forKey: .requiredProtocolVersion)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(reason.wire, forKey: .reason)
        try container.encodeIfPresent(detail, forKey: .detail)
        try container.encodeIfPresent(requiredProtocolVersion, forKey: .requiredProtocolVersion)
    }
}

/// Why the server is closing this connection.
enum StudioCloseReason: Equatable, Sendable {
    case slowClient, tokenExpired, revoked, shutdown, engineLost, displaced
    case unknown(String)

    init(wire: String) {
        switch wire {
        case "slow_client": self = .slowClient
        case "token_expired": self = .tokenExpired
        case "revoked": self = .revoked
        case "shutdown": self = .shutdown
        case "engine_lost": self = .engineLost
        case "displaced": self = .displaced
        default: self = .unknown(wire)
        }
    }

    var wire: String {
        switch self {
        case .slowClient: return "slow_client"
        case .tokenExpired: return "token_expired"
        case .revoked: return "revoked"
        case .shutdown: return "shutdown"
        case .engineLost: return "engine_lost"
        case .displaced: return "displaced"
        case .unknown(let wire): return wire
        }
    }

    /// Whether this client should dial again by itself. `revoked` means the
    /// pairing is gone. `displaced` means this same client already holds a
    /// newer connection, and dialing again would only displace that one.
    var shouldReconnect: Bool {
        switch self {
        case .revoked, .displaced: return false
        case .slowClient, .tokenExpired, .shutdown, .engineLost, .unknown: return true
        }
    }
}

struct StudioClose: Equatable, Sendable {
    var reason: StudioCloseReason
    var detail: String?
}

extension StudioClose: Codable {
    private enum CodingKeys: String, CodingKey { case reason, detail }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        reason = StudioCloseReason(wire: try container.decode(String.self, forKey: .reason))
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(reason.wire, forKey: .reason)
        try container.encodeIfPresent(detail, forKey: .detail)
    }
}
