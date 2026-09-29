import Foundation

/// One JSON text frame of the Studio wire: the union in
/// `packages/shared/src/studio-wire/types.ts`, every member a client sends or
/// receives. Binary frames are separate (`StudioBinaryFrame`).
enum StudioFrame: Equatable, Sendable {
    case hello(StudioHello)
    case welcome(StudioWelcome)
    case refused(StudioRefused)
    case action(StudioAction)
    case actionResult(StudioActionResult)
    case event(StudioEvent)
    case command(StudioCommand)
    case commandResult(StudioCommandResult)
    /// The full snapshot again, uninterpreted. Never a diff.
    case snapshot(JSONValue)
    /// A refreshed bearer token for a connection that authenticated with one.
    case reauth(token: String)
    case environmentPolicy(StudioEnvironmentPolicy)
    case snapshotRequest
    case bodyRequest(StudioBodyRequest)
    case body(StudioBody)
    /// A latency probe from the server, answered with `pong` carrying the same nonce.
    case ping(StudioPing)
    /// This client's answer to a probe.
    case pong(StudioPing)
    case close(StudioClose)

    /// The frame's `type` member on the wire.
    var wireType: String {
        switch self {
        case .hello: return "studio_hello"
        case .welcome: return "studio_welcome"
        case .refused: return "studio_refused"
        case .action: return "studio_action"
        case .actionResult: return "studio_action_result"
        case .event: return "studio_event"
        case .command: return "studio_command"
        case .commandResult: return "studio_command_result"
        case .snapshot: return "studio_snapshot"
        case .reauth: return "studio_reauth"
        case .environmentPolicy: return "studio_environment_policy"
        case .snapshotRequest: return "studio_snapshot_request"
        case .bodyRequest: return "studio_body_request"
        case .body: return "studio_body"
        case .ping: return "studio_ping"
        case .pong: return "studio_pong"
        case .close: return "studio_close"
        }
    }
}

// MARK: - Codable

extension StudioFrame: Codable {
    private enum CodingKeys: String, CodingKey { case type, snapshot, credential }

    private struct BearerCredential: Codable {
        let kind: String
        let token: String
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "studio_hello": self = .hello(try StudioHello(from: decoder))
        case "studio_welcome": self = .welcome(try StudioWelcome(from: decoder))
        case "studio_refused": self = .refused(try StudioRefused(from: decoder))
        case "studio_action": self = .action(try StudioAction(from: decoder))
        case "studio_action_result": self = .actionResult(try StudioActionResult(from: decoder))
        case "studio_event": self = .event(try StudioEvent(from: decoder))
        case "studio_command": self = .command(try StudioCommand(from: decoder))
        case "studio_command_result": self = .commandResult(try StudioCommandResult(from: decoder))
        case "studio_snapshot":
            let snapshot = try container.decodeJSON(forKey: .snapshot)
            guard snapshot.objectValue != nil else {
                throw DecodingError.dataCorruptedError(forKey: .snapshot, in: container, debugDescription: "snapshot is not an object")
            }
            self = .snapshot(snapshot)
        case "studio_reauth":
            let credential = try container.decode(BearerCredential.self, forKey: .credential)
            guard credential.kind == "bearer" else {
                throw DecodingError.dataCorruptedError(forKey: .credential, in: container, debugDescription: "reauth credential is not a bearer")
            }
            self = .reauth(token: credential.token)
        case "studio_environment_policy": self = .environmentPolicy(try StudioEnvironmentPolicy(from: decoder))
        case "studio_snapshot_request": self = .snapshotRequest
        case "studio_body_request": self = .bodyRequest(try StudioBodyRequest(from: decoder))
        case "studio_body": self = .body(try StudioBody(from: decoder))
        case "studio_ping": self = .ping(try StudioPing(from: decoder))
        case "studio_pong": self = .pong(try StudioPing(from: decoder))
        case "studio_close": self = .close(try StudioClose(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "unknown studio wire frame type \(type)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(wireType, forKey: .type)
        switch self {
        case .hello(let payload): try payload.encode(to: encoder)
        case .welcome(let payload): try payload.encode(to: encoder)
        case .refused(let payload): try payload.encode(to: encoder)
        case .action(let payload): try payload.encode(to: encoder)
        case .actionResult(let payload): try payload.encode(to: encoder)
        case .event(let payload): try payload.encode(to: encoder)
        case .command(let payload): try payload.encode(to: encoder)
        case .commandResult(let payload): try payload.encode(to: encoder)
        case .snapshot(let snapshot): try container.encode(snapshot, forKey: .snapshot)
        case .reauth(let token): try container.encode(BearerCredential(kind: "bearer", token: token), forKey: .credential)
        case .environmentPolicy(let payload): try payload.encode(to: encoder)
        case .snapshotRequest: break
        case .bodyRequest(let payload): try payload.encode(to: encoder)
        case .body(let payload): try payload.encode(to: encoder)
        case .ping(let payload): try payload.encode(to: encoder)
        case .pong(let payload): try payload.encode(to: encoder)
        case .close(let payload): try payload.encode(to: encoder)
        }
    }
}

// MARK: - Text form

/// A text frame that did not parse, or parsed to a shape its `type` does not allow.
struct StudioWireError: Error, LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }
}

extension StudioFrame {
    /// Parses and validates one text frame. Throws `StudioWireError` on anything malformed.
    static func decode(text: String) throws -> StudioFrame {
        do {
            return try JSONDecoder().decode(StudioFrame.self, from: Data(text.utf8))
        } catch {
            throw StudioWireError(message: "studio wire frame did not decode: \(error)")
        }
    }

    /// The frame's wire text.
    func encodedText() throws -> String {
        // `.withoutEscapingSlashes` keeps a path or url byte-identical to what
        // the TypeScript `JSON.stringify` would have produced.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let data = try encoder.encode(self)
        guard let text = String(data: data, encoding: .utf8) else {
            throw StudioWireError(message: "studio wire frame did not encode as UTF-8")
        }
        return text
    }
}
