import Foundation

// MARK: - OIDCAccountIdentity

/// The account behind a pairing's OIDC tokens, for **display only**.
///
/// A phone paired with desktops in two different tenants needs to tell the user
/// which account each pairing is bound to — "this desktop is signed in as the
/// work account, that one as the personal account" — and to explain a relay
/// refusal when the wrong account is bound. That is the entire purpose of this
/// type.
///
/// ## Not a security boundary
///
/// `parse(idToken:)` reads the JWT payload **without verifying the signature**.
/// That is deliberate and safe here for two reasons: the token arrives directly
/// in the TLS-protected response body from the OIDC token endpoint (it is never
/// accepted from the relay, the desktop, or any other peer), and nothing in the
/// app makes an authorization decision from these values. The relay is the only
/// component that validates identity, and it does so against the *access* token
/// it receives, with full signature and issuer verification.
///
/// Never use these fields to grant, deny, or scope access.
struct OIDCAccountIdentity: Codable, Sendable, Equatable {
    /// UPN / email, from `preferred_username`, `upn`, or `email`. May be empty
    /// for account types that publish none of them.
    let username: String
    /// Human-readable display name, from the `name` claim.
    let displayName: String
    /// Stable subject identifier, from `oid` (Entra object ID) or `sub`.
    let subject: String
    /// Tenant identifier, from `tid`. Empty for issuers that do not emit it.
    let tenantId: String
    /// When this identity was captured on THIS device (local clock, not a token
    /// claim) — shown as "signed in <relative time>".
    let issuedAt: Date

    /// Best available label for the account, preferring the UPN because it is
    /// what disambiguates two accounts belonging to the same person.
    var label: String {
        if !username.isEmpty { return username }
        if !displayName.isEmpty { return displayName }
        if !subject.isEmpty { return subject }
        return "Unknown account"
    }

    // MARK: - Parsing

    /// Decode the payload segment of an OIDC `id_token`.
    ///
    /// Returns `nil` for anything that is not a three-segment JWT with a
    /// base64url-decodable JSON payload. Callers treat `nil` as "identity
    /// unavailable" and carry on — a missing display name never blocks a
    /// connection.
    nonisolated static func parse(idToken: String) -> OIDCAccountIdentity? {
        let segments = idToken.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3 else { return nil }
        guard let payloadData = base64URLDecode(String(segments[1])) else { return nil }
        guard let json = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any] else {
            return nil
        }

        let username = firstString(in: json, keys: ["preferred_username", "upn", "email"])
        let displayName = firstString(in: json, keys: ["name"])
        let subject = firstString(in: json, keys: ["oid", "sub"])
        let tenantId = firstString(in: json, keys: ["tid"])

        // A payload carrying none of the four is not a usable identity; treat it
        // as absent rather than surfacing an all-blank account row.
        if username.isEmpty, displayName.isEmpty, subject.isEmpty, tenantId.isEmpty {
            return nil
        }

        return OIDCAccountIdentity(
            username: username,
            displayName: displayName,
            subject: subject,
            tenantId: tenantId,
            issuedAt: Date()
        )
    }

    /// First non-empty string value among the given claim names.
    private nonisolated static func firstString(in json: [String: Any], keys: [String]) -> String {
        for key in keys {
            if let value = json[key] as? String, !value.isEmpty {
                return value
            }
        }
        return ""
    }

    /// Decode a base64url segment, restoring the padding JWT omits.
    private nonisolated static func base64URLDecode(_ segment: String) -> Data? {
        var base64 = segment
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 {
            base64.append(String(repeating: "=", count: 4 - remainder))
        }
        return Data(base64Encoded: base64)
    }
}
