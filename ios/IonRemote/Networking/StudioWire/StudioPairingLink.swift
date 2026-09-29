import Foundation

/// A pairing link a server mints: `ion-studio://pair?code=…&url=…&env=…`, plus
/// `relay`, `channel`, and `relayKey` when the server also opened a relay
/// pairing channel for a client that cannot reach `url`.
struct StudioPairingLink: Equatable, Sendable {

    struct RelayChannel: Equatable, Sendable {
        let relayURL: String
        let channelId: String
        /// The relay's pre-shared key, when it runs in that mode.
        let key: String?
    }

    static let scheme = "ion-studio"

    let code: String
    /// The server's base URL. Nil for a link that names only a relay channel.
    let serverURL: URL?
    /// The server's own label.
    let label: String?
    let relay: RelayChannel?

    enum ParseError: Error, LocalizedError, Equatable {
        case notALink
        case wrongScheme(String)
        case notAPairingLink
        case missingCode
        case noDestination

        var errorDescription: String? {
            switch self {
            case .notALink: return "That is not a pairing link."
            case .wrongScheme: return "That link is not an Ion Studio pairing link."
            case .notAPairingLink: return "That Ion Studio link is not a pairing link."
            case .missingCode: return "That pairing link has no code in it."
            case .noDestination: return "That pairing link does not say which server to pair with."
            }
        }
    }

    static func parse(_ text: String) throws -> StudioPairingLink {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed), let scheme = components.scheme else {
            throw ParseError.notALink
        }
        // The server writes the query in form encoding, where a space is `+`
        // and a literal plus is `%2B`. URLComponents only undoes percent escapes.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%20")
        guard scheme.lowercased() == Self.scheme else { throw ParseError.wrongScheme(scheme) }
        guard components.host?.lowercased() == "pair" else { throw ParseError.notAPairingLink }

        var values: [String: String] = [:]
        for item in components.queryItems ?? [] {
            if let value = item.value, !value.isEmpty { values[item.name] = value }
        }
        guard let code = values["code"] else { throw ParseError.missingCode }

        let serverURL = values["url"].flatMap { URL(string: $0) }.flatMap { url -> URL? in
            guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", url.host != nil else { return nil }
            return url
        }
        var relay: RelayChannel?
        if let relayURL = values["relay"], let channelId = values["channel"] {
            relay = RelayChannel(relayURL: relayURL, channelId: channelId, key: values["relayKey"])
        }
        guard serverURL != nil || relay != nil else { throw ParseError.noDestination }
        return StudioPairingLink(code: code, serverURL: serverURL, label: values["env"], relay: relay)
    }

    /// Whether `text` starts like one of these links, so a scanner can tell it
    /// apart from the other payloads it reads before trying to parse it.
    static func looksLikeLink(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("\(scheme)://")
    }
}
