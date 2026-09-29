import Foundation

/// How a server names and pictures itself on every paired phone, as
/// `remote.getDisplay` and `remote.setDisplay` answer it. This is the server's
/// own setting, distinct from the label this phone keeps for the server.
struct RemoteDisplay: Decodable, Equatable, Sendable {
    /// Nil shows the host name.
    let customName: String?
    /// An icon identifier (`PairedDevice.iconSymbol(for:)`). Nil is the default.
    let customIcon: String?
    /// Unix ms of the edit that set it. The newest edit wins.
    let updatedAt: Double
}
