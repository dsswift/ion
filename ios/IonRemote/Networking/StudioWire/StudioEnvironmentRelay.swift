import Foundation

/// One relay a server is reachable through, and how a client authenticates to
/// it (`EnvironmentRelay` in `studio-wire/relay-envelope.ts`). A pair response
/// carries the list once and every welcome repeats it.
struct StudioEnvironmentRelay: Codable, Equatable, Sendable {

    enum Auth: Equatable, Sendable {
        /// A pre-shared key, presented as the join's bearer.
        case psk(key: String)
        /// An OIDC token from the named issuer.
        case oidc(issuer: String, audience: String, scope: String)
        /// The relay names its own issuers at `GET /v1/auth/config`. `issuer`
        /// is the tenant the server joins the relay with: the relay binds the
        /// channel to that account, so this client signs in there too. Nil
        /// from a server that has not joined yet, or predates the field.
        /// `clientId` is the app the server signs in with in that tenant, and
        /// so the app this client signs in as. Nil with `issuer`, and from a
        /// server that has none configured or predates the field.
        case relayOIDC(issuer: String?, clientId: String?)
    }

    let url: String
    let auth: Auth

    /// One array element that decodes to `nil` instead of failing the array,
    /// so a relay entry in a shape this build does not know is skipped.
    struct Lenient: Decodable {
        let relay: StudioEnvironmentRelay?

        init(from decoder: Decoder) throws {
            do {
                let decoded = try StudioEnvironmentRelay(from: decoder)
                relay = decoded.url.isEmpty ? nil : decoded
            } catch {
                DiagnosticLog.log("relay entry skipped: not a usable shape", tag: "studio.wire", level: .warn, fields: [
                    "error": String(describing: error)
                ])
                relay = nil
            }
        }
    }
}

extension StudioEnvironmentRelay.Auth: Codable {
    private enum CodingKeys: String, CodingKey { case mode, key, issuer, audience, scope, clientId }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let mode = try container.decode(String.self, forKey: .mode)
        switch mode {
        case "psk":
            self = .psk(key: try container.decode(String.self, forKey: .key))
        case "oidc":
            self = .oidc(
                issuer: try container.decode(String.self, forKey: .issuer),
                audience: try container.decode(String.self, forKey: .audience),
                scope: try container.decode(String.self, forKey: .scope)
            )
        case "relay-oidc":
            self = .relayOIDC(
                issuer: try container.decodeIfPresent(String.self, forKey: .issuer),
                clientId: try container.decodeIfPresent(String.self, forKey: .clientId)
            )
        default:
            throw DecodingError.dataCorruptedError(forKey: .mode, in: container, debugDescription: "unknown relay auth mode \(mode)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .psk(let key):
            try container.encode("psk", forKey: .mode)
            try container.encode(key, forKey: .key)
        case .oidc(let issuer, let audience, let scope):
            try container.encode("oidc", forKey: .mode)
            try container.encode(issuer, forKey: .issuer)
            try container.encode(audience, forKey: .audience)
            try container.encode(scope, forKey: .scope)
        case .relayOIDC(let issuer, let clientId):
            try container.encode("relay-oidc", forKey: .mode)
            try container.encodeIfPresent(issuer, forKey: .issuer)
            try container.encodeIfPresent(clientId, forKey: .clientId)
        }
    }
}

/// One OIDC issuer a relay accepts, from its `GET /v1/auth/config`.
struct RelayIssuerEntry: Equatable, Sendable {
    let issuer: String
    /// The relay's app registration in that tenant: the API a token is for.
    let audience: String
    let requiredScope: String

    /// The app this phone signs in as for this entry: the server's sign-in app
    /// when it named one. Without it, the app this pairing already signs in
    /// with for the same tenant is kept. The relay's own app is the last
    /// resort; it works only where one registration is both the relay API and
    /// a sign-in app.
    func signInClientId(serverClientId: String?, storedIssuer: String?, storedClientId: String?) -> String {
        if let serverClientId, !serverClientId.isEmpty { return serverClientId }
        if storedIssuer == issuer, let storedClientId, !storedClientId.isEmpty { return storedClientId }
        return audience
    }

    /// The scope a token is minted for: `api://<audience>/<requiredScope>`,
    /// unless the relay already sent a full one.
    var scope: String { OIDCScope.compose(audience: audience, requiredScope: requiredScope) }
}

/// Turns a server or relay's short scope name into the one a token is minted for.
enum OIDCScope {
    /// `api://<audience>/<scope>`, unless the scope is already qualified. An
    /// audience that already carries `api://` is not prefixed twice.
    static func compose(audience: String, requiredScope: String) -> String {
        if requiredScope.contains("/") || requiredScope.hasPrefix("api://") { return requiredScope }
        if audience.hasPrefix("api://") { return "\(audience)/\(requiredScope)" }
        return "api://\(audience)/\(requiredScope)"
    }
}

enum RelayIssuerChoiceError: Error, LocalizedError, Equatable {
    case noneAccepted(relayURL: String)
    case serverTenantNotAccepted(relayURL: String, issuer: String)
    case serverTenantUnknown(relayURL: String)

    var errorDescription: String? {
        switch self {
        case .noneAccepted(let url): return "The relay \(url) accepts no OIDC sign-in"
        case .serverTenantNotAccepted(let url, let issuer): return "The relay \(url) does not accept the server's tenant \(issuer)"
        case .serverTenantUnknown(let url): return "The relay \(url) accepts several tenants and the server has not said which it uses; connect once on the same network to learn it"
        }
    }
}

/// Reads which issuers a relay accepts and picks the one a server's channel uses.
enum RelayIssuerDirectory {

    /// `https://<relay>/v1/auth/config` for a `wss://` relay URL (`http` for `ws`).
    static func configURL(relayURL: String) -> URL? {
        guard var components = URLComponents(string: relayURL) else { return nil }
        switch components.scheme {
        case "wss": components.scheme = "https"
        case "ws": components.scheme = "http"
        case "https", "http": break
        default: return nil
        }
        components.path = "/v1/auth/config"
        components.query = nil
        return components.url
    }

    /// Every issuer the relay accepts, primary first. A relay that lists none
    /// accepts exactly its top-level one.
    static func parse(_ data: Data) -> [RelayIssuerEntry] {
        let body: JSONValue
        do {
            body = try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            DiagnosticLog.log("relay issuers: auth config body is not JSON", tag: "studio.relay", level: .warn, fields: [
                "bytes": String(data.count), "error": String(describing: error)
            ])
            return []
        }
        func entry(_ value: JSONValue?) -> RelayIssuerEntry? {
            guard let issuer = value?["issuer"]?.stringValue, !issuer.isEmpty,
                  let audience = value?["audience"]?.stringValue, !audience.isEmpty else { return nil }
            return RelayIssuerEntry(issuer: issuer, audience: audience, requiredScope: value?["requiredScope"]?.stringValue ?? "")
        }
        if case .array(let list)? = body["issuers"] {
            let parsed = list.compactMap { entry($0) }
            if !parsed.isEmpty { return parsed }
        }
        guard body["oidc"]?.boolValue == true, let top = entry(body) else { return [] }
        return [top]
    }

    /// The entry for the server's tenant. A relay with one issuer leaves no
    /// choice. With several, the server must have named its tenant: any other
    /// is refused by the relay, and could claim the channel before the server.
    static func choose(_ entries: [RelayIssuerEntry], serverIssuer: String?, relayURL: String) throws -> RelayIssuerEntry {
        guard !entries.isEmpty else { throw RelayIssuerChoiceError.noneAccepted(relayURL: relayURL) }
        if let serverIssuer, !serverIssuer.isEmpty {
            let wanted = trimmed(serverIssuer)
            guard let match = entries.first(where: { trimmed($0.issuer) == wanted }) else {
                throw RelayIssuerChoiceError.serverTenantNotAccepted(relayURL: relayURL, issuer: serverIssuer)
            }
            return match
        }
        if entries.count == 1 { return entries[0] }
        throw RelayIssuerChoiceError.serverTenantUnknown(relayURL: relayURL)
    }

    /// Fetches and parses the relay's issuers.
    static func fetch(relayURL: String) async throws -> [RelayIssuerEntry] {
        guard let url = configURL(relayURL: relayURL) else { throw StudioRouteError.malformedURL(relayURL) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return parse(data)
    }

    private static func trimmed(_ issuer: String) -> String {
        issuer.hasSuffix("/") ? String(issuer.dropLast()) : issuer
    }
}
