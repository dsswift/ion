import Foundation

// MARK: - System Metrics summary event
//
// Decode/encode for `desktop_system_metrics`: the connected Environment's
// load, sent every 10 s while this phone watches. The payload's fields decode
// through `EnvironmentLoadSummary`'s own keys (EnvironmentLoadSummary.swift)
// rather than the shared flat `CodingKeys`, so four new wire names do not
// crowd that enum.

extension RemoteEvent {

    /// Decode the System Metrics summary. Returns nil for any other type.
    static func decodeSystemMetrics(type: TypeKey, decoder: Decoder) throws -> RemoteEvent? {
        guard type == .systemMetrics else { return nil }
        return .systemMetrics(try EnvironmentLoadSummary(from: decoder))
    }

    /// Encode the System Metrics summary. iOS never sends this, but Codable
    /// conformance requires the path.
    func encodeSystemMetrics(to encoder: Encoder) throws -> Bool {
        guard case .systemMetrics(let summary) = self else { return false }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(TypeKey.systemMetrics, forKey: .type)
        try summary.encode(to: encoder)
        return true
    }
}
