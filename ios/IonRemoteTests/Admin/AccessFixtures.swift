import Foundation
@testable import IonRemote

/// Access & pairing results in the shapes the server's action handlers
/// return them (`server/src/auth/actions.ts`, `environment/actions.ts`,
/// `protocol/remote-actions.ts`).
enum AccessFixtures {

    static func client(_ id: String, label: String? = "Pixel desk", kind: String = "mobile", scopes: [String] = ["conversations:read"],
                       lastSeen: Int = 1_700_000_500_000, revokedAt: Int? = nil, connected: Bool? = nil) -> JSONValue {
        var fields: [String: JSONValue] = [
            "clientId": .string(id), "scopes": .array(scopes.map(JSONValue.string)), "subject": .string("local:owner"),
            "createdAt": .int(1_700_000_000_000), "lastSeen": .int(lastSeen),
            "revokedAt": revokedAt.map(JSONValue.int) ?? .null, "kind": .string(kind),
        ]
        if let label { fields["label"] = .string(label) }
        if let connected { fields["connected"] = .bool(connected) }
        return .object(fields)
    }

    static func discovery(_ mode: String, until: Int? = nil, code: String? = nil) -> JSONValue {
        .object([
            "mode": .string(mode), "advertising": .bool(mode != "off" && mode != "sealed"),
            "until": until.map(JSONValue.int) ?? .null, "code": code.map(JSONValue.string) ?? .null,
        ])
    }

    static func link(expiresAt: Int = 1_700_000_900_000) -> JSONValue {
        .object(["url": .string("ion-studio://pair?code=ABCD2345&host=192.0.2.4"), "code": .string("ABCD2345"), "expiresAt": .int(expiresAt)])
    }

    static let pskRelay: JSONValue = .object(["oidc": .bool(false), "psk": .bool(true), "issuer": .string(""), "audience": .string(""), "requiredScope": .string("")])
    static let entraRelay: JSONValue = .object([
        "oidc": .bool(true), "psk": .bool(false), "issuer": .string("https://login.example.org/tenant/v2.0"),
        "audience": .string("api://relay"), "requiredScope": .string("Relay.Access"),
    ])
}
