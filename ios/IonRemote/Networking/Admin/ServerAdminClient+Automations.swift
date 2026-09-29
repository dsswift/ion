import Foundation

/// The automations section's calls. The server evaluates and stores every
/// automation; the phone reads the listing and asks for one change at a time.
extension ServerAdminClient {

    /// Every source layer's automations. With `projectPath`, that project's too.
    func automationListing(projectPath: String? = nil) async throws -> AutomationListing {
        let args: [JSONValue] = projectPath.map { $0.isEmpty ? [] : [.string($0)] } ?? []
        return try await call(.automationListing, args: args)
    }

    func automationHistory() async throws -> [AutomationHistoryEntry] {
        try await call(.automationHistory)
    }

    /// Creates or replaces one of the person's own automations; answers the stored copy.
    @discardableResult
    func upsertAutomation(_ definition: AutomationDefinition) async throws -> AutomationDefinition? {
        try await mutateAutomation(.automationUpsert, args: [try JSONValue.encoding(definition)]).definition
    }

    func deleteAutomation(id: String) async throws {
        _ = try await mutateAutomation(.automationDelete, args: [.string(id)])
    }

    /// Copies any readable automation into a new, switched-off one of the person's own.
    func duplicateAutomation(id: String, projectPath: String? = nil) async throws -> AutomationDefinition {
        var fields: [String: JSONValue] = ["id": .string(id)]
        if let projectPath, !projectPath.isEmpty { fields["projectPath"] = .string(projectPath) }
        guard let copy = try await mutateAutomation(.automationDuplicate, args: [.object(fields)]).definition else {
            throw StudioActionFailure.failed(code: "bad_result", message: "\(serverLabel) did not return the copy it made.")
        }
        return copy
    }

    /// Switches a project automation on or off for this server only.
    func setProjectAutomationEnabled(projectPath: String, id: String, enabled: Bool) async throws {
        _ = try await mutateAutomation(.automationSetProjectEnabled, args: [.object([
            "projectPath": .string(projectPath), "id": .string(id), "enabled": .bool(enabled),
        ])])
    }

    /// Whether the server's enterprise policy pre-authorizes automations that run AI actions.
    func automationAiActionsAuthorized() async throws -> Bool {
        let policy = try await callValue(.policyGetFull)
        return policy["customFields"]?["ion-desktop"]?["automation"]?["authorizeAiActions"]?.boolValue == true
    }

    private func mutateAutomation(_ action: PhoneAction, args: [JSONValue]) async throws -> AutomationMutationResult {
        let result: AutomationMutationResult = try await call(action, args: args)
        guard result.ok else {
            let reason = result.error ?? "\(serverLabel) did not complete \(action.rawValue)."
            DiagnosticLog.log("admin client: automation change refused", tag: "admin.client", level: .warn, fields: [
                "server": serverLabel, "action": action.rawValue, "error": String(reason.prefix(300))
            ])
            throw StudioActionFailure.failed(code: "declined", message: reason)
        }
        return result
    }
}
