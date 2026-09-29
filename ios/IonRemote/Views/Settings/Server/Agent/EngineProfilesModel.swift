import Foundation
import Observation

/// One server's engine profiles: named sets of extensions a conversation can
/// start with. They live in the server's `engineProfiles` Environment
/// setting, so every change saves the whole list and needs admin there.
@MainActor
@Observable
final class EngineProfilesModel {

    /// Nil until the first load lands.
    private(set) var profiles: [EngineProfile]?
    private(set) var loading = false
    private(set) var busy = false
    /// The last failure, in plain words.
    var error: String?

    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let serverId: String

    init(client: ServerAdminClient, serverId: String) {
        self.client = client
        self.serverId = serverId
    }

    func profile(id: String) -> EngineProfile? { profiles?.first { $0.id == id } }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            let settings = try await client.loadSettings()
            if let value = settings["engineProfiles"], !value.isNull {
                profiles = try value.decoded(as: [EngineProfile].self)
            } else {
                profiles = []
            }
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("engine profiles: load failed", tag: "admin.agent", level: .warn, fields: [
                "server_id": serverId, "error": String(describing: error)
            ])
        }
    }

    /// Adds `profile`, or replaces the one with its id.
    @discardableResult
    func save(_ profile: EngineProfile) async -> Bool {
        let current = profiles ?? []
        let exists = current.contains { $0.id == profile.id }
        let next = exists ? current.map { $0.id == profile.id ? profile : $0 } : current + [profile]
        return await persist(next, verb: exists ? "update" : "add", profileId: profile.id)
    }

    @discardableResult
    func remove(id: String) async -> Bool {
        await persist((profiles ?? []).filter { $0.id != id }, verb: "delete", profileId: id)
    }

    /// A short id for a new profile, as the desktop makes them.
    static func newId() -> String {
        String(UUID().uuidString.lowercased().prefix(8))
    }

    private func persist(_ next: [EngineProfile], verb: String, profileId: String) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            try await client.saveEngineProfiles(next)
            profiles = next
            error = nil
            DiagnosticLog.log("engine profiles: saved", tag: "admin.agent", fields: [
                "server_id": serverId, "verb": verb, "profile_id": profileId, "count": String(next.count)
            ])
            return true
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("engine profiles: save failed", tag: "admin.agent", level: .warn, fields: [
                "server_id": serverId, "verb": verb, "profile_id": profileId, "error": String(describing: error)
            ])
            return false
        }
    }
}
