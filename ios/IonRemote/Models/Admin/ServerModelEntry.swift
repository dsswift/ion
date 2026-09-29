import Foundation

/// One model a server's engine offers, as `model.list` lists it. Only the
/// fields the settings pages read; mirrors `ModelEntry` in
/// `@ion/shared/types-models`.
struct ServerModelEntry: Decodable, Equatable, Sendable, Identifiable {
    let id: String
    let providerId: String
    /// The engine's friendly name. Absent means the engine could not name it.
    let displayName: String?
    let contextWindow: Int?

    /// What a person reads: the engine's name, else the id without the
    /// `<providerId>/` routing prefix the engine adds to a shared bare id.
    var label: String {
        if let displayName, !displayName.isEmpty { return displayName }
        let qualifier = "\(providerId)/"
        return id.hasPrefix(qualifier) ? String(id.dropFirst(qualifier.count)) : id
    }
}
