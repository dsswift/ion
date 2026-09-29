import Foundation

/// Another paired server a settings page reads from: Copy from another
/// server lists its projects, Commit author copies its author.
struct PairedServerSource: Sendable {
    let serverId: String
    let label: String
    let client: ServerAdminClient

    /// Every paired server other than `serverId`, each through its own admin session.
    @MainActor
    static func others(than serverId: String, in viewModel: SessionViewModel) -> [PairedServerSource] {
        var seen: Set<String> = [serverId]
        return viewModel.pairedDevices.compactMap { device in
            guard let other = viewModel.adminSession(for: device), seen.insert(other.serverId).inserted else { return nil }
            return PairedServerSource(serverId: other.serverId, label: other.serverLabel, client: other.client)
        }
    }
}
