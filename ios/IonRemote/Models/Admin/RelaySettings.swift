import Foundation

/// The relay a server reaches its phones through, read from its settings
/// document (`settings.load`). An empty URL means LAN only.
struct RelaySettings: Decodable, Equatable, Sendable {
    let relayUrl: String
    let relayApiKey: String

    init(relayUrl: String, relayApiKey: String) {
        self.relayUrl = relayUrl
        self.relayApiKey = relayApiKey
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        relayUrl = try container.decodeIfPresent(String.self, forKey: .relayUrl) ?? ""
        relayApiKey = try container.decodeIfPresent(String.self, forKey: .relayApiKey) ?? ""
    }

    private enum CodingKeys: String, CodingKey {
        case relayUrl, relayApiKey
    }

    var isConfigured: Bool { !relayUrl.trimmingCharacters(in: .whitespaces).isEmpty }
}
