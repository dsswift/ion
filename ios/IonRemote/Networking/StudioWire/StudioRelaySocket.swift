import Foundation
import CryptoKit

/// The relay route: this client joins the channel `deriveChannelId(secret)`
/// in the `mobile` role, the server holds the `ion` role on the same channel,
/// and the relay forwards sealed envelopes it cannot read.
///
/// The join carries a bearer (the relay's pre-shared key, or an OIDC token).
/// It carries no push address: the phone registers that with each server
/// (`device.registerPush`), and the server hands it to the relay per push.
enum StudioRelaySocket {

    /// - Parameter bearer: resolved at every dial, so an OIDC token is fresh.
    static func make(
        relayURL: URL,
        key: SymmetricKey,
        taskFactory: RelayWebSocketTaskFactory = URLSessionRelayWebSocketTaskFactory(),
        bearer: @escaping @Sendable () async throws -> String
    ) -> StudioSealedSocket {
        let channelId = E2ECrypto.deriveChannelId(sharedSecret: key)
        return StudioSealedSocket(
            routeKind: .relay,
            key: key,
            options: .init(label: relayURL.host(percentEncoded: false) ?? "unknown", skipRelayControlFrames: true),
            taskFactory: taskFactory
        ) {
            guard let url = joinURL(relayURL: relayURL, channelId: channelId) else {
                throw StudioRouteError.malformedURL(relayURL.absoluteString)
            }
            var request = URLRequest(url: url)
            request.setValue("Bearer \(try await bearer())", forHTTPHeaderField: "Authorization")
            return request
        }
    }

    /// `{relay}/v1/channel/{channelId}?role=mobile`, with `http(s)` mapped to `ws(s)`.
    static func joinURL(relayURL: URL, channelId: String) -> URL? {
        guard var components = URLComponents(url: relayURL, resolvingAgainstBaseURL: false) else { return nil }
        switch components.scheme {
        case "https", "wss": components.scheme = "wss"
        case "http", "ws": components.scheme = "ws"
        default: return nil
        }
        var base = components.path
        if base.hasSuffix("/") { base.removeLast() }
        components.path = "\(base)/v1/channel/\(channelId)"
        components.queryItems = [URLQueryItem(name: "role", value: "mobile")]
        components.fragment = nil
        return components.url
    }
}

/// The Apple push environment that issued this build's device token.
///
/// A development-signed build (Xcode, `make ios`) registers with the sandbox;
/// a distribution-signed build (TestFlight, App Store) registers with
/// production. Apple refuses a token sent to the other one, so the relay must
/// be told. The raw values are the `env` the phone registers with a server
/// (`device.registerPush`).
enum APNsEnvironment: String, Sendable {
    case sandbox
    case production

    /// This build's environment, read once from its signing.
    static let current: APNsEnvironment = {
        #if targetEnvironment(simulator)
        return .sandbox
        #else
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision") else {
            DiagnosticLog.log("apns environment resolved", tag: "apns", fields: ["apns_env": "production", "source": "no_embedded_profile"])
            return .production
        }
        do {
            let environment = fromProvisioningProfile(try Data(contentsOf: url))
            DiagnosticLog.log("apns environment resolved", tag: "apns", fields: ["apns_env": environment.rawValue, "source": "embedded_profile"])
            return environment
        } catch {
            // The profile exists, so this is a development-signed build.
            DiagnosticLog.log("apns environment profile unreadable", tag: "apns", level: .warn, fields: ["error": error.localizedDescription])
            return .sandbox
        }
        #endif
    }()

    /// Reads `aps-environment` from a provisioning profile.
    ///
    /// Distribution builds carry no embedded profile (App Store processing
    /// strips it), so a missing profile means production. A profile is a
    /// signed envelope around a plain XML plist, which is read in place.
    static func fromProvisioningProfile(_ data: Data?) -> APNsEnvironment {
        guard let data else { return .production }
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex) else {
            DiagnosticLog.log("apns environment profile has no plist", tag: "apns", level: .warn)
            return .sandbox
        }
        let plist: Any
        do {
            plist = try PropertyListSerialization.propertyList(from: data[start.lowerBound..<end.upperBound], format: nil)
        } catch {
            DiagnosticLog.log("apns environment profile plist unreadable", tag: "apns", level: .warn, fields: ["error": error.localizedDescription])
            return .sandbox
        }
        guard let entitlements = (plist as? [String: Any])?["Entitlements"] as? [String: Any],
              let value = entitlements["aps-environment"] as? String else {
            // A development profile without the push entitlement cannot
            // receive pushes at all; sandbox is the closest truthful answer.
            return .sandbox
        }
        return value == "production" ? .production : .sandbox
    }
}
