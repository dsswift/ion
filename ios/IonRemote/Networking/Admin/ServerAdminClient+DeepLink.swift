import Foundation

extension ServerAdminClient {
    /// Asks the server to resolve an `ion://` link this phone opened.
    func openDeepLink(url: String) async throws -> DeepLinkOpenResult {
        try await call(.deeplinkOpen, fields: ["url": .string(url)])
    }

    /// Answers a confirmation `openDeepLink` returned. An approval runs the action now.
    func answerDeepLink(id: String, approved: Bool) async throws -> DeepLinkActionOutcome {
        try await call(.deeplinkConfirmResult, fields: ["id": .string(id), "owner": .string("remote"), "approved": .bool(approved)])
    }
}
