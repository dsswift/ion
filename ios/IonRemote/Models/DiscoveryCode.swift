import Foundation

/// The short one-time code typed to pair with an Ion Studio Server found on
/// the LAN.
///
/// Eight characters from a 31-symbol alphabet with no look-alikes (no I, L,
/// O, 0, 1), shown grouped as `XXXX-XXXX`. The server accepts the code with
/// or without its dash, in any case; this type is what lets the phone show
/// the canonical form while it is being typed, and refuse a code that cannot
/// be one before a request is sent.
///
/// The same rules live in `packages/shared/src/discovery-code.ts`, which is
/// where the server reads a typed code back. `IonRemoteTests/DiscoveryCodeTests`
/// pins this copy against the alphabet that file defines; the two must agree,
/// or a phone would refuse a code its server considers valid.
enum DiscoveryCode {
    static let alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    static let length = 8

    /// The canonical form of what a person typed: dashes and spaces dropped,
    /// upper-cased, illegal characters removed, capped at the code's length.
    static func normalize(_ input: String) -> String {
        String(input.uppercased().filter { alphabet.contains($0) }.prefix(length))
    }

    /// True when `code` is a complete, legal code (already normalized).
    static func isComplete(_ code: String) -> Bool {
        code.count == length && code.allSatisfy { alphabet.contains($0) }
    }

    /// `ABCD-EFGH` for display, from however much has been typed so far.
    static func grouped(_ code: String) -> String {
        let normalized = normalize(code)
        guard normalized.count > 4 else { return normalized }
        let split = normalized.index(normalized.startIndex, offsetBy: 4)
        return "\(normalized[..<split])-\(normalized[split...])"
    }
}
