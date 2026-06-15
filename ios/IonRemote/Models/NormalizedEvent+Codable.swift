import Foundation

// Codable conformance for RemoteEvent.
//
// The conformance is declared on this extension (the primary `enum
// RemoteEvent` declaration in NormalizedEvent.swift is `Sendable`-only) so
// that the manual init(from:) / encode(to:) here satisfy the protocol
// directly — declaring `Codable` on the primary type plus manual methods in
// a separate file makes the compiler attempt (and fail) to synthesize
// Codable for an enum with associated values. Declaring conformance on the
// extension that also provides the methods is the supported pattern.
//
// CodingKeys and TypeKey remain nested in the primary type (NormalizedEvent.swift)
// because the per-family helpers reference them by bare name; they resolve
// here as members of RemoteEvent regardless of which file these methods live
// in. Extracted from NormalizedEvent.swift to keep that file under the
// 600-line cap. These two methods are thin dispatchers that fan out to the
// per-family decode/encode helpers in NormalizedEvent+<Family>.swift.
extension RemoteEvent: Codable {

    // MARK: - Decoder

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(TypeKey.self, forKey: .type)

        if let event = try Self.decodeLifecycle(type: type, container: container) {
            self = event
            return
        }
        if let event = try Self.decodeStream(type: type, container: container) {
            self = event
            return
        }
        if let event = try Self.decodePermission(type: type, container: container) {
            self = event
            return
        }
        if let event = try Self.decodeTerminal(type: type, container: container) {
            self = event
            return
        }
        if let event = try Self.decodeEngine(type: type, container: container) {
            self = event
            return
        }
        if let event = try Self.decodeResource(type: type, container: container) {
            self = event
            return
        }
        if let event = try Self.decodeGit(type: type, container: container) {
            self = event
            return
        }
        if let event = try Self.decodeFiles(type: type, container: container) {
            self = event
            return
        }
        // Should be unreachable: every TypeKey must be handled by exactly one family.
        throw DecodingError.dataCorruptedError(
            forKey: .type,
            in: container,
            debugDescription: "Unhandled event type: \(type.rawValue)"
        )
    }

    // MARK: - Encoder

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        if try encodeLifecycle(into: &container) { return }
        if try encodeStream(into: &container) { return }
        if try encodePermission(into: &container) { return }
        if try encodeTerminal(into: &container) { return }
        if try encodeEngine(into: &container) { return }
        if try encodeResource(into: &container) { return }
        if try encodeGit(into: &container) { return }
        if try encodeFiles(into: &container) { return }
        // Unreachable: every case must be encoded by exactly one family.
    }
}
