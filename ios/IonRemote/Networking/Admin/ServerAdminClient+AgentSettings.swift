import Foundation

/// The server settings the models and agent pages keep outside the projected
/// list: engine profiles, AI workflow prompt overrides, and the default
/// models. Read with `settings.load`, written with `settings.save`.
extension ServerAdminClient {

    /// This connection's settings document on the server: the Environment
    /// document with the caller's Account values over it.
    func loadSettings() async throws -> [String: JSONValue] {
        try await call(.settingsLoad)
    }

    /// Saves `patch`. The server refuses a change to an Environment key
    /// (`engineProfiles`, `aiAssistPromptOverrides`) without the admin scope.
    func saveSettings(_ patch: [String: JSONValue]) async throws {
        try await callVoid(.settingsSave, args: [.object(patch)])
    }

    func saveEngineProfiles(_ profiles: [EngineProfile]) async throws {
        try await saveSettings(["engineProfiles": try JSONValue.encoding(profiles)])
    }

    func saveAIWorkflowPromptOverrides(_ overrides: [String: String]) async throws {
        try await saveSettings(["aiAssistPromptOverrides": .object(overrides.mapValues(JSONValue.string))])
    }

    /// The fixed AI-assisted workflows and their built-in prompts.
    func aiWorkflows() async throws -> [AIWorkflow] {
        try await call(.aiAssistWorkflows)
    }
}
