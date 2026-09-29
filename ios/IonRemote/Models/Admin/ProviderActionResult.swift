import Foundation

/// What a provider, model, or sign-in write answers: `{ ok, error? }`. The
/// action succeeds on the wire either way, so `ok` is the real outcome.
struct ProviderActionResult: Decodable, Equatable, Sendable {
    let ok: Bool
    let error: String?
}
