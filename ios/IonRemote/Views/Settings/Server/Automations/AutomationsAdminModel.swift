import Foundation
import Observation

/// One server's automations as the Automations screens show them: the
/// source-aware listing for an optional project, the recent runs, and the
/// verbs those screens run. The server evaluates and stores everything; each
/// change is one call, then a reload.
@MainActor
@Observable
final class AutomationsAdminModel {

    let serverId: String
    let serverLabel: String
    /// Nil until the first listing lands.
    private(set) var listing: AutomationListing?
    /// Nil until the first read lands.
    private(set) var history: [AutomationHistoryEntry]?
    /// Whether enterprise policy pre-authorizes AI actions. Nil while unknown.
    private(set) var aiActionsAuthorized: Bool?
    /// The server's registered projects, offered as the project scope.
    private(set) var projects: [EnvironmentProject] = []
    private(set) var loadError: String?
    private(set) var busy = false
    /// Why the last verb failed, in plain words.
    var operationError: String?
    /// The project whose `.ion/automation` rules are listed too. Empty for none.
    private(set) var projectPath = ""

    @ObservationIgnored private let client: ServerAdminClient

    init(serverId: String, serverLabel: String, client: ServerAdminClient) {
        self.serverId = serverId
        self.serverLabel = serverLabel
        self.client = client
    }

    convenience init(session: ServerAdminSession) {
        self.init(serverId: session.serverId, serverLabel: session.serverLabel, client: session.client)
    }

    var locked: Bool { listing?.locked ?? false }

    /// The last ten runs, newest first.
    var recentRuns: [AutomationHistoryEntry]? {
        history.map { Array($0.suffix(10).reversed()) }
    }

    func name(for automationId: String) -> String {
        listing?.entries.first { $0.definition.id == automationId }?.definition.name ?? automationId
    }

    /// Whether a saved entry is one of the listing's own, rather than a new draft.
    func isSaved(_ definition: AutomationDefinition) -> Bool {
        listing?.entries.contains { $0.definition.id == definition.id } ?? false
    }

    static func isEnabled(_ entry: AutomationSourceEntry) -> Bool {
        entry.source == .project ? entry.locallyDisabled != true : entry.definition.enabled
    }

    /// Only the person's own and project rules can be switched, and never while locked.
    func canToggle(_ entry: AutomationSourceEntry) -> Bool {
        !locked && (entry.source == .user || entry.source == .project)
    }

    /// Only the person's own rules are edited in place; the rest open read-only.
    func isEditable(_ entry: AutomationSourceEntry) -> Bool {
        entry.source == .user && !locked
    }

    // MARK: - Loading

    func load() async {
        let scope = projectPath
        do {
            async let listed = client.automationListing(projectPath: scope)
            async let runs = client.automationHistory()
            let (nextListing, nextHistory) = try await (listed, runs)
            guard scope == projectPath else { return } // the scope changed while this read ran
            listing = nextListing
            history = nextHistory
            loadError = nil
            DiagnosticLog.log("automations: listed", tag: "admin.automations", level: .debug, fields: [
                "server_id": serverId, "entries": String(nextListing.entries.count), "runs": String(nextHistory.count),
                "locked": String(nextListing.locked), "project_scoped": String(!scope.isEmpty)
            ])
        } catch is CancellationError {
            return
        } catch {
            loadError = error.localizedDescription
            DiagnosticLog.log("automations: listing failed", tag: "admin.automations", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
        await loadSupporting()
    }

    /// The AI authorization and the project list; neither blocks the listing.
    private func loadSupporting() async {
        do {
            aiActionsAuthorized = try await client.automationAiActionsAuthorized()
        } catch is CancellationError {
            return
        } catch {
            DiagnosticLog.log("automations: policy read failed", tag: "admin.automations", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
        do {
            projects = try await client.listProjects()
        } catch is CancellationError {
            return
        } catch {
            DiagnosticLog.log("automations: project list failed", tag: "admin.automations", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
    }

    func setProjectPath(_ path: String) async {
        guard path != projectPath else { return }
        projectPath = path
        listing = nil
        DiagnosticLog.log("automations: project scope changed", tag: "admin.automations", fields: [
            "server_id": serverId, "project_scoped": String(!path.isEmpty)
        ])
        await load()
    }

    // MARK: - Verbs

    /// Saves one of the person's own automations; true when the server stored it.
    func save(_ definition: AutomationDefinition) async -> Bool {
        await run("saved", id: definition.id) { try await $0.upsertAutomation(definition) }
    }

    func delete(id: String) async -> Bool {
        await run("deleted", id: id) { try await $0.deleteAutomation(id: id) }
    }

    /// Copies any rule into a new, switched-off one of the person's own; answers the copy.
    func duplicate(id: String) async -> AutomationDefinition? {
        var copy: AutomationDefinition?
        let scope = projectPath
        let done = await run("duplicated", id: id) { copy = try await $0.duplicateAutomation(id: id, projectPath: scope) }
        return done ? copy : nil
    }

    func toggle(_ entry: AutomationSourceEntry) async {
        guard canToggle(entry) else { return }
        if entry.source == .user {
            var next = entry.definition
            next.enabled.toggle()
            next.updatedAt = AutomationDraft.timestamp()
            _ = await save(next)
        } else {
            let enabled = !Self.isEnabled(entry)
            let scope = projectPath
            _ = await run(enabled ? "project rule enabled" : "project rule disabled", id: entry.definition.id) {
                try await $0.setProjectAutomationEnabled(projectPath: scope, id: entry.definition.id, enabled: enabled)
            }
        }
    }

    private func run(_ outcome: String, id: String, _ body: (ServerAdminClient) async throws -> Void) async -> Bool {
        busy = true
        operationError = nil
        defer { busy = false }
        do {
            try await body(client)
            DiagnosticLog.log("automations: operation done", tag: "admin.automations", fields: ["server_id": serverId, "automation_id": id, "operation": outcome])
            await load()
            return true
        } catch {
            operationError = error.localizedDescription
            DiagnosticLog.log("automations: verb failed", tag: "admin.automations", level: .warn, fields: [
                "server_id": serverId, "automation_id": id, "verb": outcome, "error": error.localizedDescription
            ])
            return false
        }
    }
}
