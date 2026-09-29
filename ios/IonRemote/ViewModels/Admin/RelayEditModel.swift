import Foundation
import Observation

/// Adds or changes the relay a server reaches its phones through. It can
/// have the server look for relays on its own network, asks the relay how it
/// authenticates, and then either tests a shared key before saving or, for a
/// Microsoft Entra relay, saves with no key once the server is signed in.
@MainActor
@Observable
final class RelayEditModel {

    var url: String
    var apiKey: String
    /// How the relay at `url` authenticates. Nil until probed, or when it did not answer.
    private(set) var auth: RelayAuthConfig?
    private(set) var probing = false
    /// The URL `auth` describes.
    private(set) var probedURL: String?
    /// Who the server is signed in to Microsoft Entra as. Read for an Entra relay.
    private(set) var signedInUser: String?
    private(set) var discovered: [DiscoveredRelay] = []
    private(set) var discovering = false
    private(set) var saving = false
    private(set) var error: String?

    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let serverId: String
    @ObservationIgnored private let events: ServerAdminEvents

    init(client: ServerAdminClient, serverId: String, current: RelaySettings, events: ServerAdminEvents = .shared) {
        self.client = client
        self.serverId = serverId
        self.events = events
        url = current.relayUrl
        apiKey = current.relayApiKey
    }

    var trimmedURL: String { url.trimmingCharacters(in: .whitespacesAndNewlines) }
    var isEntra: Bool { auth?.oidc == true && probedURL == trimmedURL }
    /// The probe answered for the URL on screen.
    var probeCurrent: Bool { !probing && probedURL == trimmedURL }

    // MARK: - Probe

    /// Asks the relay at the current URL how it authenticates.
    func probe() async {
        let target = trimmedURL
        guard !target.isEmpty else {
            auth = nil
            probedURL = nil
            return
        }
        probing = true
        defer { probing = false }
        do {
            let config = try await client.relayAuthConfig(url: target)
            guard target == trimmedURL else { return }
            auth = config
            probedURL = target
            DiagnosticLog.log("relay edit: probed", tag: "admin.access", level: .debug, fields: [
                "server_id": serverId, "answered": String(config != nil), "oidc": String(config?.oidc ?? false)
            ])
            signedInUser = config?.oidc == true ? await readSignedInUser() : nil
        } catch {
            guard target == trimmedURL else { return }
            auth = nil
            probedURL = target
            DiagnosticLog.log("relay edit: probe failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
        }
    }

    // MARK: - Discovery

    func startDiscovery() async {
        discovering = true
        discovered = []
        error = nil
        do {
            discovered = try await client.discoverRelays()
            DiagnosticLog.log("relay edit: discovery started", tag: "admin.access", fields: [
                "server_id": serverId, "found_so_far": String(discovered.count)
            ])
        } catch {
            discovering = false
            self.error = AdminFailureText.describe(error)
            DiagnosticLog.log("relay edit: discovery failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
        }
    }

    /// Stops the server looking. Safe to call when it is not looking.
    func stopDiscovery() async {
        let wasDiscovering = discovering
        discovering = false
        discovered = []
        guard wasDiscovering else { return }
        do {
            try await client.stopRelayDiscovery()
            DiagnosticLog.log("relay edit: discovery stopped", tag: "admin.access", fields: ["server_id": serverId])
        } catch {
            DiagnosticLog.log("relay edit: stopping discovery failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
        }
    }

    /// Takes relays the server finds after discovery started, until the caller's task is cancelled.
    func watch() async {
        for await event in events.events(for: serverId) where event.channel == ServerAdminEvent.remoteRelaysChanged {
            guard discovering else { continue }
            do {
                discovered = try event.payload.decoded(as: [DiscoveredRelay].self)
            } catch {
                DiagnosticLog.log("relay edit: discovered relays did not decode", tag: "admin.access", level: .warn, fields: [
                    "server_id": serverId, "error": String(String(describing: error).prefix(300))
                ])
            }
        }
    }

    func pick(_ relay: DiscoveredRelay) async {
        url = relay.url
        await stopDiscovery()
        await probe()
    }

    // MARK: - Save

    /// Tests a shared-key relay from the server, then saves it. For an Entra
    /// relay, saves it with no key once the server is signed in. Returns what
    /// was saved, or nil with `error` set.
    func save() async -> RelaySettings? {
        let target = trimmedURL
        guard !target.isEmpty else {
            error = "Enter the relay's URL."
            return nil
        }
        saving = true
        error = nil
        defer { saving = false }
        do {
            let settings: RelaySettings
            if isEntra {
                guard signedInUser != nil else {
                    error = "Sign the server in to Microsoft Entra first, under Integrations."
                    return nil
                }
                settings = RelaySettings(relayUrl: target, relayApiKey: "")
            } else {
                let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
                let test = try await client.testRelay(url: target, apiKey: key)
                guard test.success else {
                    error = test.error.map { "The server could not connect: \($0)" } ?? "The server could not connect to that relay."
                    DiagnosticLog.log("relay edit: test failed", tag: "admin.access", level: .warn, fields: [
                        "server_id": serverId, "error": String((test.error ?? "").prefix(200))
                    ])
                    return nil
                }
                settings = RelaySettings(relayUrl: target, relayApiKey: key)
            }
            try await client.saveRelaySettings(settings)
            await stopDiscovery()
            DiagnosticLog.log("relay edit: relay saved", tag: "admin.access", fields: [
                "server_id": serverId, "mode": isEntra ? "oidc" : "psk", "has_key": String(!settings.relayApiKey.isEmpty)
            ])
            return settings
        } catch {
            self.error = AdminFailureText.describe(error)
            DiagnosticLog.log("relay edit: save failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
            return nil
        }
    }

    /// Who the server is signed in to Microsoft Entra as, or nil when signed
    /// out or unreadable: either way the Entra relay cannot be saved yet.
    private func readSignedInUser() async -> String? {
        do {
            return try await client.relaySignedInIdentity().flatMap(Self.name)
        } catch {
            DiagnosticLog.log("relay edit: signed-in identity read failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
            return nil
        }
    }

    private static func name(_ identity: EntraIdentity) -> String? {
        let name = identity.username.isEmpty ? identity.user : identity.username
        return name.isEmpty ? nil : name
    }
}
