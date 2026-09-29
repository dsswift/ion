import Foundation
import Observation

/// The prompt each AI-assisted workflow sends on one server: the built-in
/// one, or the override saved in the server's `aiAssistPromptOverrides`
/// Environment setting. Saving needs admin there.
@MainActor
@Observable
final class AIWorkflowPromptsModel {

    /// Nil until the first load lands.
    private(set) var workflows: [AIWorkflow]?
    private(set) var overrides: [String: String] = [:]
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

    func workflow(id: String) -> AIWorkflow? { workflows?.first { $0.id == id } }

    func isCustomized(_ id: String) -> Bool {
        !(overrides[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The prompt the workflow sends now.
    func effectivePrompt(_ workflow: AIWorkflow) -> String {
        isCustomized(workflow.id) ? overrides[workflow.id] ?? workflow.defaultTemplate : workflow.defaultTemplate
    }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            async let workflows = client.aiWorkflows()
            async let settings = client.loadSettings()
            let (loadedWorkflows, loadedSettings) = try await (workflows, settings)
            self.workflows = loadedWorkflows
            overrides = (loadedSettings["aiAssistPromptOverrides"]?.objectValue ?? [:]).compactMapValues(\.stringValue)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("ai workflows: load failed", tag: "admin.agent", level: .warn, fields: [
                "server_id": serverId, "error": String(describing: error)
            ])
        }
    }

    /// Saves `prompt` for the workflow. The built-in prompt saves as no override.
    @discardableResult
    func save(_ workflow: AIWorkflow, prompt: String) async -> Bool {
        if let problem = workflow.validationError(prompt) {
            error = problem
            DiagnosticLog.log("ai workflows: save blocked by validation", tag: "admin.agent", level: .warn, fields: [
                "server_id": serverId, "workflow": workflow.id
            ])
            return false
        }
        var next = overrides
        next[workflow.id] = prompt == workflow.defaultTemplate ? nil : prompt
        return await persist(next, workflow: workflow.id)
    }

    @discardableResult
    func reset(_ workflow: AIWorkflow) async -> Bool {
        var next = overrides
        next[workflow.id] = nil
        return await persist(next, workflow: workflow.id)
    }

    private func persist(_ next: [String: String], workflow: String) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            try await client.saveAIWorkflowPromptOverrides(next)
            overrides = next
            error = nil
            DiagnosticLog.log("ai workflows: prompt saved", tag: "admin.agent", fields: [
                "server_id": serverId, "workflow": workflow, "overridden": String(next[workflow] != nil)
            ])
            return true
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("ai workflows: save failed", tag: "admin.agent", level: .warn, fields: [
                "server_id": serverId, "workflow": workflow, "error": String(describing: error)
            ])
            return false
        }
    }
}
