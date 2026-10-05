import Foundation

/// What running an approved `ion://` action produced. Mirrors
/// `DeepLinkActionOutcome` in `packages/shared/src/types-ipc-deeplink.ts`.
struct DeepLinkActionOutcome: Decodable, Equatable, Sendable {
    let ok: Bool
    /// Why it did not run. "declined" when the person said no.
    let error: String?
    /// The conversation the action ran in, when it ran in one.
    let tabId: String?
}
