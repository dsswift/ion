import Foundation
import Observation

/// How one server looks and is reached on phones: the name and icon it shows
/// them, and the relay that reaches them off its network.
@MainActor
@Observable
final class PhoneRelayAdminModel {

    private(set) var display: RemoteDisplay?
    private(set) var displayLoaded = false
    private(set) var displayError: String?
    private(set) var relay: RelaySettings?
    private(set) var relayError: String?
    /// How the configured relay authenticates. Nil until probed, or when it did not answer.
    private(set) var relayAuth: RelayAuthConfig?
    private(set) var savingDisplay = false
    private(set) var removingRelay = false

    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let serverId: String
    /// Whether this connection may probe the relay (an admin verb).
    @ObservationIgnored private let canProbeRelay: () -> Bool

    init(client: ServerAdminClient, serverId: String, canProbeRelay: @escaping () -> Bool) {
        self.client = client
        self.serverId = serverId
        self.canProbeRelay = canProbeRelay
    }

    func load() async {
        async let display: Void = loadDisplay()
        async let relay: Void = loadRelay()
        _ = await (display, relay)
    }

    func loadDisplay() async {
        do {
            display = try await client.remoteDisplay()
            displayLoaded = true
            displayError = nil
        } catch {
            displayError = AdminFailureText.describe(error)
            DiagnosticLog.log("phone and relay: display read failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
        }
    }

    func loadRelay() async {
        do {
            let settings = try await client.relaySettings()
            relay = settings
            relayError = nil
            await probe(settings)
        } catch {
            relayError = AdminFailureText.describe(error)
            DiagnosticLog.log("phone and relay: relay settings read failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
        }
    }

    /// Saves the name and icon. Returns true when the server took them.
    @discardableResult
    func saveDisplay(name: String?, icon: String?, now: Date = Date()) async -> Bool {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        savingDisplay = true
        displayError = nil
        defer { savingDisplay = false }
        do {
            let stored = try await client.setRemoteDisplay(name: (trimmed?.isEmpty ?? true) ? nil : trimmed, icon: icon, updatedAt: now)
            display = stored
            displayLoaded = true
            DiagnosticLog.log("phone and relay: display saved", tag: "admin.access", fields: [
                "server_id": serverId, "has_name": String(stored.customName != nil), "icon": stored.customIcon ?? ""
            ])
            return true
        } catch {
            displayError = AdminFailureText.describe(error)
            DiagnosticLog.log("phone and relay: display save failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
            return false
        }
    }

    /// Clears the relay: the server reaches phones on its own network only.
    func removeRelay() async {
        removingRelay = true
        relayError = nil
        defer { removingRelay = false }
        do {
            let cleared = RelaySettings(relayUrl: "", relayApiKey: "")
            try await client.saveRelaySettings(cleared)
            relay = cleared
            relayAuth = nil
            DiagnosticLog.log("phone and relay: relay removed", tag: "admin.access", fields: ["server_id": serverId])
        } catch {
            relayError = AdminFailureText.describe(error)
            DiagnosticLog.log("phone and relay: relay remove failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
        }
    }

    /// Takes the relay the edit sheet saved.
    func relaySaved(_ settings: RelaySettings, auth: RelayAuthConfig?) {
        relay = settings
        relayAuth = auth
        relayError = nil
    }

    private func probe(_ settings: RelaySettings) async {
        guard settings.isConfigured, canProbeRelay() else {
            relayAuth = nil
            return
        }
        do {
            relayAuth = try await client.relayAuthConfig(url: settings.relayUrl)
        } catch {
            relayAuth = nil
            DiagnosticLog.log("phone and relay: relay auth probe failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
        }
    }
}
