import Foundation

/// `environment.git.hostKeys`: one public key in the server host's `~/.ssh`,
/// which git uses when no Ion credential matches a remote's host.
struct HostSshKey: Decodable, Equatable, Sendable, Identifiable {
    let file: String
    let type: String
    let comment: String

    var id: String { file }
}
