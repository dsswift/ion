import Foundation

// MARK: - Fleet
//
// What one server reports about itself for the Fleet screen
// (`server/src/fleet/actions.ts`).

extension ServerAdminClient {

    func fleetReport() async throws -> FleetReport {
        try await call(.fleetReport, timeoutSeconds: 20)
    }

    /// Has the server read its provider CLIs' accounts and usage limits again.
    func refreshFleetAccounts() async throws {
        try await callVoid(.fleetRefreshAccounts, timeoutSeconds: 60)
    }

    /// The Fleet Hubs the server reports to.
    func fleetHubs() async throws -> FleetHubsList {
        try await call(.fleetHubsList, timeoutSeconds: 20)
    }

    /// Puts the server on a hub. The answer says how joining went: the server waits for the hub's reply.
    /// `label` is the name the hub shows the server under: the one this phone knows it by.
    func addFleetHub(url: String, enrollmentToken: String, manage: Bool, label: String) async throws -> FleetHubsList {
        try await call(.fleetHubsAdd, fields: ["url": .string(url), "enrollmentToken": .string(enrollmentToken), "manage": .bool(manage), "label": .string(label)], timeoutSeconds: 30)
    }

    func removeFleetHub(url: String) async throws -> FleetHubsList {
        try await call(.fleetHubsRemove, fields: ["url": .string(url)], timeoutSeconds: 20)
    }
}
