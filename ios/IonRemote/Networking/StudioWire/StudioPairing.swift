import Foundation
import CryptoKit

/// The sign-in a server publishes on `GET /auth/config`.
struct StudioServerSignIn: Equatable, Sendable {
    let issuer: String
    /// The server's API: the audience its tokens must carry.
    let audience: String
    /// The scope name the server requires, qualified or short.
    let scope: String
    /// The app a client signs in as. Empty when the server named none.
    let clientId: String

    var signInClientId: String { clientId.isEmpty ? audience : clientId }
    var tokenScope: String { OIDCScope.compose(audience: audience, requiredScope: scope) }
}

/// Completes a pairing link against an Ion Studio Server over its own address:
/// `GET /auth/config`, then `POST /auth/pair` with this device's X25519 public
/// key and the link's one-time code. A server that offers sign-in gets the
/// person's token with the pairing, so the device acts as that person rather
/// than as itself. The server answers with its public key and the client id it
/// registered; both ends derive the same shared secret.
enum StudioPairing {

    /// What a completed pairing produced. All of it must be stored: the secret
    /// in the Keychain, the rest beside the paired environment.
    struct Record: Equatable, Sendable {
        /// The id the server registered this pairing under. Every hello must carry it.
        let clientId: String
        /// The 32-byte shared secret: seals every frame, keys the hello proof,
        /// and derives the relay channel id.
        let secret: Data
        /// The server base URL the pairing was completed against.
        let url: String
        let environmentId: String
        /// The server's own label, when it reported one.
        let label: String?
        let scopes: [String]
        /// The relays the server said it can be reached through afterward.
        let relays: [StudioEnvironmentRelay]

        var key: SymmetricKey { SymmetricKey(data: secret) }
    }

    struct Request: Sendable {
        /// The server's base URL, from the pairing link.
        var serverURL: URL
        /// The link's one-time code.
        var code: String
        /// What the server's device list shows for this phone.
        var label: String
        /// Stable for this install, so pairing again replaces the earlier record.
        var deviceId: String
    }

    enum Failure: Error, LocalizedError, Equatable {
        case unreachable(String)
        /// The server answered and said no: `expired`, `used`, `not_found`, or another reason.
        case refused(reason: String)
        case malformedResponse
        /// The client id the server registered is not the one this side derives,
        /// so the two ends do not hold the same secret.
        case secretMismatch
        case identityUnavailable(String)
        /// The server offers sign-in and signing in did not produce a token.
        case signInFailed(String)

        var errorDescription: String? {
            switch self {
            case .unreachable(let detail): return "Could not reach the server: \(detail)"
            case .refused(let reason):
                switch reason {
                case "expired": return "The pairing link has expired (links last five minutes). Mint a new one."
                case "used": return "That pairing link was already used. Mint a new one."
                case "not_found": return "The server does not recognise this pairing code. Mint a new one."
                case "invalid_bearer": return "The server did not accept your sign-in. Try again, and sign in with the account this server belongs to."
                case "bearer_unverifiable": return "The server cannot check sign-ins right now. Ask its owner to check its sign-in settings."
                default: return "The server refused the pairing: \(reason)"
                }
            case .malformedResponse: return "The server answered the pairing with an unexpected payload."
            case .secretMismatch: return "The pairing did not produce a shared secret. Try again with a new link."
            case .identityUnavailable(let detail): return "Could not read the server identity: \(detail)"
            case .signInFailed(let detail): return "This server needs you to sign in before pairing: \(detail)"
            }
        }
    }

    /// One HTTP exchange: the request, and the status and body that came back.
    typealias Transport = @Sendable (URLRequest) async throws -> (status: Int, body: Data)

    /// Signs the person in against a server's sign-in and returns an access token.
    typealias SignIn = @Sendable (StudioServerSignIn) async throws -> String

    private static let timeoutSeconds: TimeInterval = 10

    private struct PairBody: Encodable {
        let code: String
        let peerPublicKey: String
        let label: String
        let kind: String
        let deviceId: String
    }

    private struct PairResponse: Decodable {
        let clientId: String
        let ourPublicKey: String
        let scopes: [String]?
        let relays: [StudioEnvironmentRelay.Lenient]?
    }

    private struct RefusalBody: Decodable {
        let error: String
    }

    // MARK: - Pair

    static func pair(
        _ request: Request,
        privateKey: Curve25519.KeyAgreement.PrivateKey = E2ECrypto.generateKeyPair(),
        transport: Transport = StudioPairing.urlSessionTransport,
        signIn: SignIn = StudioPairing.interactiveSignIn
    ) async throws -> Record {
        let host = request.serverURL.host(percentEncoded: false) ?? "unknown"
        guard let pairURL = endpoint("/auth/pair", on: request.serverURL),
              let configURL = ServerAuthConfigClient.authConfigURL(for: request.serverURL) else {
            throw Failure.unreachable("malformed server URL")
        }
        DiagnosticLog.log("studio pairing: started", tag: "studio.pair", fields: ["host": host, "label": request.label])

        // The config comes first: it says whether the server wants a sign-in
        // with the pairing, and a server that cannot name itself is refused
        // before the one-time code is spent.
        let config = try await fetchConfig(configURL, host: host, transport: transport)
        guard let environmentId = config.environmentId, !environmentId.isEmpty else {
            DiagnosticLog.log("studio pairing: the server reported no environment id", tag: "studio.pair", level: .warn, fields: ["host": host])
            throw Failure.identityUnavailable("the server reported no environment id")
        }

        var bearer: String?
        if let serverSignIn = config.oidc {
            DiagnosticLog.log("studio pairing: server offers sign-in; signing in", tag: "studio.pair", fields: [
                "host": host, "issuer": serverSignIn.issuer, "client_id": serverSignIn.signInClientId
            ])
            do {
                bearer = try await signIn(serverSignIn)
            } catch {
                DiagnosticLog.log("studio pairing: sign-in failed", tag: "studio.pair", level: .warn, fields: [
                    "host": host, "error": error.localizedDescription
                ])
                throw Failure.signInFailed(error.localizedDescription)
            }
        } else {
            DiagnosticLog.log("studio pairing: server offers no sign-in; pairing as this device", tag: "studio.pair", fields: ["host": host])
        }

        var post = URLRequest(url: pairURL)
        post.httpMethod = "POST"
        post.timeoutInterval = timeoutSeconds
        post.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let bearer { post.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        post.httpBody = try JSONEncoder().encode(PairBody(
            code: request.code,
            peerPublicKey: privateKey.publicKey.rawRepresentation.base64EncodedString(),
            label: request.label,
            kind: "mobile",
            deviceId: request.deviceId
        ))

        let answer: (status: Int, body: Data)
        do {
            answer = try await transport(post)
        } catch {
            DiagnosticLog.log("studio pairing: POST /auth/pair unreachable", tag: "studio.pair", level: .warn, fields: [
                "host": host, "error": error.localizedDescription
            ])
            throw Failure.unreachable(error.localizedDescription)
        }
        guard answer.status == 200 else {
            let reason = refusalReason(in: answer.body) ?? "HTTP \(answer.status)"
            DiagnosticLog.log("studio pairing: refused by server", tag: "studio.pair", level: .warn, fields: [
                "host": host, "status": String(answer.status), "reason": reason, "signed_in": String(bearer != nil)
            ])
            throw Failure.refused(reason: reason)
        }

        let response: PairResponse
        let peerKey: Curve25519.KeyAgreement.PublicKey
        do {
            response = try JSONDecoder().decode(PairResponse.self, from: answer.body)
            guard let peerBytes = Data(base64Encoded: response.ourPublicKey) else { throw Failure.malformedResponse }
            peerKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerBytes)
        } catch {
            DiagnosticLog.log("studio pairing: malformed /auth/pair response", tag: "studio.pair", level: .warn, fields: [
                "host": host, "error": String(describing: error)
            ])
            throw Failure.malformedResponse
        }

        let key: SymmetricKey
        do {
            key = try E2ECrypto.deriveSharedSecret(privateKey: privateKey, peerPublicKey: peerKey)
        } catch {
            DiagnosticLog.log("studio pairing: key agreement failed", tag: "studio.pair", level: .error, fields: [
                "host": host, "error": error.localizedDescription
            ])
            throw Failure.secretMismatch
        }
        // The server names a pairing by the first 16 characters of the channel
        // id its secret derives. Deriving another id here means another secret.
        let derivedClientId = String(E2ECrypto.deriveChannelId(sharedSecret: key).prefix(16))
        guard derivedClientId == response.clientId else {
            DiagnosticLog.log("studio pairing: registered client id does not match the derived one", tag: "studio.pair", level: .error, fields: [
                "host": host, "registered": response.clientId, "derived": derivedClientId
            ])
            throw Failure.secretMismatch
        }

        let relays = (response.relays ?? []).compactMap(\.relay)
        DiagnosticLog.log("studio pairing: completed", tag: "studio.pair", fields: [
            "host": host,
            "client_id": response.clientId,
            "environment_id": environmentId,
            "relay_count": String(relays.count),
            "scope_count": String(response.scopes?.count ?? 0),
            "signed_in": String(bearer != nil)
        ])
        return Record(
            clientId: response.clientId,
            secret: key.withUnsafeBytes { Data($0) },
            url: request.serverURL.absoluteString,
            environmentId: environmentId,
            label: config.label,
            scopes: response.scopes ?? [],
            relays: relays
        )
    }

    // MARK: - Helpers

    private static func fetchConfig(_ url: URL, host: String, transport: Transport) async throws -> StudioRoute.AuthConfig {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeoutSeconds
        let answer: (status: Int, body: Data)
        do {
            answer = try await transport(request)
        } catch {
            DiagnosticLog.log("studio pairing: GET /auth/config unreachable", tag: "studio.pair", level: .warn, fields: [
                "host": host, "error": error.localizedDescription
            ])
            throw Failure.unreachable(error.localizedDescription)
        }
        guard answer.status == 200, let config = StudioRoute.parseAuthConfig(answer.body) else {
            DiagnosticLog.log("studio pairing: /auth/config was unusable", tag: "studio.pair", level: .warn, fields: [
                "host": host, "status": String(answer.status)
            ])
            throw Failure.identityUnavailable("GET /auth/config answered HTTP \(answer.status)")
        }
        return config
    }

    /// Opens the sign-in sheet for the server's app and returns the token. The
    /// refresh token is not kept: the pairing names the person once, and the
    /// paired secret carries the device after that.
    static let interactiveSignIn: SignIn = { serverSignIn in
        let deviceId = "studio-pairing-\(UUID().uuidString)"
        let manager = OIDCTokenManager(
            clientId: serverSignIn.signInClientId,
            issuer: serverSignIn.issuer,
            scope: serverSignIn.tokenScope,
            deviceId: deviceId
        )
        defer { KeychainHelper.delete(OIDCTokenManager.refreshKey(deviceId: deviceId)) }
        return try await manager.forceInteractiveReauth()
    }

    private static func refusalReason(in body: Data) -> String? {
        do {
            return try JSONDecoder().decode(RefusalBody.self, from: body).error
        } catch {
            // A refusal with no JSON body; the caller reports the HTTP status instead.
            return nil
        }
    }

    /// `http(s)://host:port<path>` for a server base given as `http(s)` or `ws(s)`.
    static func endpoint(_ path: String, on serverURL: URL) -> URL? {
        guard let base = ServerAuthConfigClient.authConfigURL(for: serverURL),
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        components.path = path
        return components.url
    }

    static let urlSessionTransport: Transport = { request in
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (http.statusCode, data)
    }
}
