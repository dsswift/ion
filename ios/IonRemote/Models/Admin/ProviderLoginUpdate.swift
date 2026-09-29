import Foundation

/// One stage of a delegated-CLI sign-in, as `ion:provider-login-event`
/// carries it. Mirrors `ProviderLoginUpdate` in `@ion/shared/types-engine-event-model`.
struct ProviderLoginUpdate: Decodable, Equatable, Sendable {

    enum Stage: String, Decodable, Sendable {
        case started
        case awaitBrowser = "await_browser"
        case awaitDeviceCode = "await_device_code"
        case awaitAuthCode = "await_auth_code"
        case completed, failed, cancelled
    }

    let provider: String
    let backend: String
    /// The raw stage; `knownStage` is nil for one this build does not know.
    let stage: String
    let authUrl: String?
    let userCode: String?
    let verificationUrl: String?
    let loginError: String?

    var knownStage: Stage? { Stage(rawValue: stage) }
}
