import Foundation

/// One of the operator's own Quick Tools, as the server lists it for a
/// conversation. The command stays on the server: running the tool sends
/// only `id` (`RemoteCommand.runQuickTool`). Mirrors the `quickTools` entries
/// of `RemoteTabState` in `server/src/remote/protocol-remote-tab.ts`.
struct RemoteQuickTool: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let name: String
    /// A Phosphor icon name from Studio.
    let icon: String

    /// The menu icon. A name Studio does not know gets Studio's lightning.
    var systemImage: String { PhosphorSymbol.systemName(for: icon, fallback: "bolt") }
}
