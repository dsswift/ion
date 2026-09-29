import Foundation
import CryptoKit

/// Decides, for every dial, which way a paired environment is reached:
/// directly when its address answers `GET /auth/config`, through a relay the
/// server reported when it does not.
///
/// The answer of that probe is also what the direct route needs: the nonce the
/// hello's proof is computed over. While a connection is on the relay the
/// address is probed again on a timer, and the first answer asks the owner to
/// dial again, which lands on the direct route. Nothing here depends on
/// Bonjour: the stored address and the stored relays are the whole input.
///
/// The address may be unknown (a pairing carried over from the older wire
/// never stored one). Such a route goes straight to a relay until its owner
/// supplies an address with `setServerURL`.
///
/// "The address" is not only the stored one. Every welcome reports where the
/// server answers directly: its current addresses, then its own `.local`
/// name, which follows the machine to any network. The stored address and
/// every reported one are probed together, and the first that answers as
/// this server wins and becomes the stored address. That is what finds a
/// laptop that moved to another network when no relay can carry the phone.
actor StudioRoute {

    /// What `GET /auth/config` said, reduced to what routing needs.
    struct AuthConfig: Equatable, Sendable {
        let nonce: String
        let environmentId: String?
        let label: String?
        /// Whether the server opens sealed frames on its TCP listener.
        let sealedTcp: Bool
        /// The sign-in the server offers. Nil when it has none.
        var oidc: StudioServerSignIn? = nil
    }

    enum Resolution: Equatable, Sendable {
        case tcp(AuthConfig)
        case relay(StudioEnvironmentRelay)

        var kind: StudioRouteKind {
            switch self {
            case .tcp: return .tcp
            case .relay: return .relay
            }
        }
    }

    /// The injectable edges: the probe, the two socket builders, and the OIDC token source.
    struct Dependencies: Sendable {
        /// Probes a server address. Nil means it did not answer usably.
        var probe: @Sendable (URL) async -> AuthConfig? = { await StudioRoute.probeAuthConfig(serverURL: $0) }
        var makeTCPSocket: @Sendable (URL, String, SymmetricKey) -> any StudioSocket = { url, clientId, key in
            StudioTCPSocket.make(serverURL: url, clientId: clientId, key: key)
        }
        var makeRelaySocket: @Sendable (URL, SymmetricKey, @escaping @Sendable () async throws -> String) -> any StudioSocket = { url, key, bearer in
            StudioRelaySocket.make(relayURL: url, key: key, bearer: bearer)
        }
        /// A token for a relay that authenticates with OIDC. Nil means this
        /// client has no identity to present, and such a relay is unusable.
        var oidcToken: (@Sendable (StudioEnvironmentRelay) async throws -> String)?
        var reprobeIntervalSeconds: Double = 60
    }

    private var serverURL: URL?
    private let clientId: String
    private let secret: SymmetricKey
    private var relays: [StudioEnvironmentRelay]
    /// Where the server said it answers directly, as of its last welcome.
    private var directAddresses: [URL]
    /// The server's environment id. A reported address is used only when it
    /// answers with this id; nil means none is known yet.
    private var environmentId: String?
    private let dependencies: Dependencies
    private var onServerURLAdopted: (@Sendable (URL) async -> Void)?

    private(set) var lastResolution: Resolution?
    private var reprobeTask: Task<Void, Never>?
    private var onDirectRouteReturned: (@Sendable () async -> Void)?

    init(
        serverURL: URL?, clientId: String, secret: SymmetricKey, relays: [StudioEnvironmentRelay],
        directAddresses: [URL] = [], environmentId: String? = nil, dependencies: Dependencies = Dependencies()
    ) {
        self.serverURL = serverURL
        self.clientId = clientId
        self.secret = secret
        self.relays = relays
        self.directAddresses = directAddresses
        self.environmentId = environmentId
        self.dependencies = dependencies
    }

    // MARK: - Owner surface

    /// The `dial` a `StudioConnection` is built with.
    nonisolated var dial: StudioConnection.Dial {
        { [weak self] in
            guard let self else { throw StudioRouteError.routeReleased }
            return try await self.dialPlan()
        }
    }

    /// Called when the server's address answers again while the last dial went
    /// through a relay. The owner dials again (`StudioConnection.restart()`).
    func setOnDirectRouteReturned(_ handler: (@Sendable () async -> Void)?) {
        onDirectRouteReturned = handler
    }

    /// Replaces the relay list, from a welcome. Returns whether it changed, so
    /// the owner knows to store it.
    @discardableResult
    func updateRelays(_ next: [StudioEnvironmentRelay]) -> Bool {
        guard next != relays else { return false }
        relays = next
        DiagnosticLog.log("studio route: relay list updated", tag: "studio.route", fields: [
            "client_id": clientId, "relay_count": String(next.count)
        ])
        return true
    }

    /// Replaces the addresses the server reported, from a welcome. Returns
    /// whether they changed, so the owner knows to store them.
    @discardableResult
    func updateDirectAddresses(_ next: [URL]) -> Bool {
        guard next != directAddresses else { return false }
        directAddresses = next
        DiagnosticLog.log("studio route: direct addresses updated", tag: "studio.route", fields: [
            "client_id": clientId, "count": String(next.count),
            "hosts": next.compactMap { $0.host(percentEncoded: false) }.joined(separator: ",")
        ])
        return true
    }

    /// Records the server's environment id, from a welcome.
    func setEnvironmentId(_ next: String) {
        guard !next.isEmpty, next != environmentId else { return }
        environmentId = next
    }

    /// Called when a dial lands on a reported address instead of the stored
    /// one, so the owner can store it.
    func setOnServerURLAdopted(_ handler: (@Sendable (URL) async -> Void)?) {
        onServerURLAdopted = handler
    }

    /// Supplies or replaces the server's address, once discovery has found it.
    /// A route on a relay picks it up at its next timer probe.
    func setServerURL(_ next: URL) {
        guard next != serverURL else { return }
        serverURL = next
        DiagnosticLog.log("studio route: server address set", tag: "studio.route", fields: [
            "client_id": clientId, "host": host
        ])
    }

    /// Stops the return-to-direct probe. Call when the connection is stopped.
    func stop() {
        disarmReprobe(why: "stopped")
    }

    // MARK: - Resolution

    /// Picks the route for one dial.
    func resolve() async throws -> Resolution {
        let probed = await probeCandidates()
        let resolution: Resolution
        if let found = probed.found {
            if found.url != serverURL {
                let previous = host
                serverURL = found.url
                DiagnosticLog.log("studio route: stored address silent, server answers at an address it reported", tag: "studio.route", fields: [
                    "client_id": clientId, "previous_host": previous, "host": host
                ])
                await onServerURLAdopted?(found.url)
            }
            DiagnosticLog.log("studio route: address answers, dialing tcp", tag: "studio.route", fields: [
                "client_id": clientId, "host": host
            ])
            resolution = .tcp(found.config)
        } else {
            if probed.sawUnsealed {
                // This client always seals. A listener that cannot open sealed
                // frames would close the socket over the first one.
                DiagnosticLog.log("studio route: address answers but does not open sealed frames, not usable directly", tag: "studio.route", level: .warn, fields: [
                    "client_id": clientId, "host": host
                ])
            }
            guard let relay = relays.first else {
                DiagnosticLog.log("studio route: address silent and no relay is stored", tag: "studio.route", level: .warn, fields: [
                    "client_id": clientId, "host": host
                ])
                throw StudioRouteError.unreachable(host: host)
            }
            DiagnosticLog.log("studio route: address silent, falling back to relay", tag: "studio.route", fields: [
                "client_id": clientId, "host": host, "relay_host": URL(string: relay.url)?.host(percentEncoded: false) ?? "unknown"
            ])
            resolution = .relay(relay)
        }
        lastResolution = resolution
        switch resolution {
        case .relay: armReprobe()
        case .tcp: disarmReprobe(why: "on the direct route")
        }
        return resolution
    }

    /// Resolves the route and builds that route's socket and hello credential.
    func dialPlan() async throws -> StudioDialPlan {
        switch try await resolve() {
        case .tcp(let config):
            guard let serverURL else { throw StudioRouteError.unreachable(host: host) }
            guard let proof = StudioAuthProof.proof(nonceBase64: config.nonce, secret: secret) else {
                DiagnosticLog.log("studio route: server nonce is not base64", tag: "studio.route", level: .error, fields: [
                    "client_id": clientId, "host": host
                ])
                // An address that answers but cannot be dialled must not cost
                // the client its connection. `resolve()` already falls back
                // when the address is silent or will not seal; a plan that
                // cannot be built is the same outcome one step later, and
                // without this the client retried the same unusable address
                // forever while a working relay sat unused — offline, on a
                // network where it had just been told the server was up.
                return try relayFallbackPlan(because: "the server's nonce could not be read")
            }
            return StudioDialPlan(
                socket: dependencies.makeTCPSocket(serverURL, clientId, secret),
                credential: .paired(clientId: clientId, proof: proof)
            )
        case .relay(let relay):
            return try relayPlan(for: relay)
        }
    }

    /// The relay plan for a direct route that resolved and then could not be
    /// dialled. Throws the direct route's own error when there is no relay to
    /// fall back to, because that is the failure worth reporting.
    private func relayFallbackPlan(because reason: String) throws -> StudioDialPlan {
        guard let relay = relays.first else {
            DiagnosticLog.log("studio route: the direct route is unusable and no relay is stored", tag: "studio.route", level: .error, fields: [
                "client_id": clientId, "host": host, "reason": reason
            ])
            throw StudioRouteError.unusableNonce
        }
        DiagnosticLog.log("studio route: the direct route is unusable, falling back to relay", tag: "studio.route", level: .warn, fields: [
            "client_id": clientId, "host": host, "reason": reason,
            "relay_host": URL(string: relay.url)?.host(percentEncoded: false) ?? "unknown"
        ])
        // The address may become dialable again (a server upgrade fixes the
        // handshake), so keep probing for the way back exactly as a silent
        // address does.
        armReprobe()
        lastResolution = .relay(relay)
        return try relayPlan(for: relay)
    }

    private func relayPlan(for relay: StudioEnvironmentRelay) throws -> StudioDialPlan {
        guard let relayURL = URL(string: relay.url) else { throw StudioRouteError.malformedURL(relay.url) }
        let bearer = try bearerSource(for: relay)
        return StudioDialPlan(
            socket: dependencies.makeRelaySocket(relayURL, secret, bearer),
            credential: .paired(clientId: clientId, proof: StudioAuthProof.relayProof(secret: secret))
        )
    }

    private func bearerSource(for relay: StudioEnvironmentRelay) throws -> @Sendable () async throws -> String {
        switch relay.auth {
        case .psk(let key):
            return { key }
        case .oidc, .relayOIDC:
            guard let oidcToken = dependencies.oidcToken else {
                DiagnosticLog.log("studio route: relay needs an OIDC token and no token source is set", tag: "studio.route", level: .warn, fields: [
                    "client_id": clientId, "relay_host": URL(string: relay.url)?.host(percentEncoded: false) ?? "unknown"
                ])
                throw StudioRouteError.relayNeedsIdentity(relayURL: relay.url)
            }
            return { try await oidcToken(relay) }
        }
    }

    private var host: String { serverURL?.host(percentEncoded: false) ?? "unknown" }

    /// The stored address first, then each reported one not already listed.
    private func candidateURLs() -> [URL] {
        var seen = Set<String>()
        var out: [URL] = []
        for url in [serverURL].compactMap({ $0 }) + directAddresses {
            let key = url.absoluteString.hasSuffix("/") ? String(url.absoluteString.dropLast()) : url.absoluteString
            guard seen.insert(key).inserted else { continue }
            out.append(url)
        }
        return out
    }

    /// What probing every candidate address found.
    private struct ProbeOutcome {
        var found: (url: URL, config: AuthConfig)?
        /// Some address answered but does not open sealed frames.
        var sawUnsealed = false
    }

    /// Probes the stored address and every reported one together. The first
    /// that answers with sealed frames AS THIS SERVER wins. The stored address
    /// is also accepted when no id is known, or the server reports none (a
    /// server older than the field); a reported address never is, since an
    /// address that answers with another id is someone else's server.
    private func probeCandidates() async -> ProbeOutcome {
        let candidates = candidateURLs()
        guard !candidates.isEmpty else {
            DiagnosticLog.log("studio route: no server address stored, nothing to probe", tag: "studio.route", level: .debug, fields: [
                "client_id": clientId
            ])
            return ProbeOutcome()
        }
        let probe = dependencies.probe
        let primary = serverURL
        let expected = environmentId
        let clientId = clientId
        return await withTaskGroup(of: (URL, AuthConfig?).self) { group in
            for url in candidates {
                group.addTask { (url, await probe(url)) }
            }
            var outcome = ProbeOutcome()
            for await (url, config) in group {
                guard let config else { continue }
                guard config.sealedTcp else {
                    outcome.sawUnsealed = true
                    continue
                }
                let isPrimary = url == primary
                let matches = config.environmentId == expected && expected != nil
                    || isPrimary && (expected == nil || config.environmentId == nil)
                guard matches else {
                    DiagnosticLog.log("studio route: an address answers as a different server, skipped", tag: "studio.route", level: .warn, fields: [
                        "client_id": clientId, "host": url.host(percentEncoded: false) ?? "unknown",
                        "reported_environment_id": config.environmentId ?? "none"
                    ])
                    continue
                }
                outcome.found = (url, config)
                group.cancelAll()
                break
            }
            if outcome.found == nil, candidates.count > 1 {
                DiagnosticLog.log("studio route: no address answers as this server", tag: "studio.route", fields: [
                    "client_id": clientId, "candidates": String(candidates.count)
                ])
            }
            return outcome
        }
    }

    // MARK: - Return to the direct route

    private func armReprobe() {
        guard reprobeTask == nil else { return }
        let interval = dependencies.reprobeIntervalSeconds
        DiagnosticLog.log("studio route: on a relay, probing the address on a timer", tag: "studio.route", fields: [
            "client_id": clientId, "interval_s": String(interval)
        ])
        reprobeTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(interval))
                } catch {
                    // Cancelled by disarmReprobe.
                    return
                }
                guard let self, await self.reprobeOnce() == false else { return }
            }
        }
    }

    /// One timer tick. Returns true when the direct route is back and the loop should end.
    private func reprobeOnce() async -> Bool {
        let probed = await probeCandidates()
        guard !Task.isCancelled else { return true }
        guard probed.found != nil else {
            DiagnosticLog.log("studio route: address still silent, staying on the relay", tag: "studio.route", level: .debug, fields: [
                "client_id": clientId, "host": host
            ])
            return false
        }
        DiagnosticLog.log("studio route: address answers again, asking the owner to dial directly", tag: "studio.route", fields: [
            "client_id": clientId, "host": host
        ])
        reprobeTask = nil
        await onDirectRouteReturned?()
        return true
    }

    private func disarmReprobe(why: String) {
        guard let task = reprobeTask else { return }
        task.cancel()
        reprobeTask = nil
        DiagnosticLog.log("studio route: address probe timer stopped", tag: "studio.route", level: .debug, fields: [
            "client_id": clientId, "why": why
        ])
    }

    // MARK: - Probe

    private static let probeTimeoutSeconds: TimeInterval = 3

    /// `GET <server>/auth/config`. Nil for anything but a 200 with a nonce in it.
    static func probeAuthConfig(serverURL: URL) async -> AuthConfig? {
        guard let url = ServerAuthConfigClient.authConfigURL(for: serverURL) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = probeTimeoutSeconds
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return parseAuthConfig(data)
        } catch {
            // An unreachable address is the case this probe exists to detect; resolve() logs the decision.
            return nil
        }
    }

    static func parseAuthConfig(_ data: Data) -> AuthConfig? {
        let body: JSONValue
        do {
            body = try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            DiagnosticLog.log("studio route: /auth/config body is not JSON", tag: "studio.route", level: .warn, fields: [
                "bytes": String(data.count)
            ])
            return nil
        }
        guard let nonce = body["nonce"]?.stringValue, !nonce.isEmpty else { return nil }
        return AuthConfig(
            nonce: nonce,
            environmentId: body["environmentId"]?.stringValue,
            label: body["label"]?.stringValue,
            sealedTcp: body["sealedTcp"]?.boolValue == true,
            oidc: parseSignIn(body["oidc"])
        )
    }

    /// `oidc` from `/auth/config`: nil when absent, null, or missing a field a token needs.
    private static func parseSignIn(_ value: JSONValue?) -> StudioServerSignIn? {
        guard let issuer = value?["issuer"]?.stringValue, !issuer.isEmpty,
              let audience = value?["audience"]?.stringValue, !audience.isEmpty,
              let scope = value?["scope"]?.stringValue, !scope.isEmpty else { return nil }
        return StudioServerSignIn(issuer: issuer, audience: audience, scope: scope, clientId: value?["clientId"]?.stringValue ?? "")
    }
}

enum StudioRouteError: Error, LocalizedError, Equatable {
    case malformedURL(String)
    case unreachable(host: String)
    case unusableNonce
    case relayNeedsIdentity(relayURL: String)
    case routeReleased

    var errorDescription: String? {
        switch self {
        case .malformedURL(let url): return "Malformed URL: \(url)"
        case .unreachable(let host): return "\(host) does not answer and no relay is stored for it"
        case .unusableNonce: return "The server's auth nonce is not usable"
        case .relayNeedsIdentity(let relayURL): return "The relay \(relayURL) needs a signed-in identity"
        case .routeReleased: return "The route was released before the dial"
        }
    }
}
