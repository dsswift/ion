import Foundation

/// What `remote.testRelay` found when the server opened one socket to a relay.
struct RelayTestResult: Decodable, Equatable, Sendable {
    let success: Bool
    let error: String?
}
