import Foundation

/// One model provider on a server, as `model.list` lists it. Mirrors
/// `ProviderEntry` in `@ion/shared/types-models`.
struct ServerProviderEntry: Decodable, Equatable, Sendable, Identifiable {

    /// How a delegated-CLI sign-in finishes. Mirrors `ProviderLoginFlow`.
    enum LoginFlow: String, Decodable, Sendable {
        /// An authorize URL plus a pasted code: finishes from anywhere.
        case browserCode = "browser-code"
        /// A loopback browser on the host, or a device code: only the device
        /// code finishes from a phone.
        case browserOrDeviceCode = "browser-or-device-code"
        /// The CLI's own browser with a loopback callback on the host.
        case browserCallback = "browser-callback"
    }

    let id: String
    let hasAuth: Bool
    /// "env" | "keychain" | "filestore" | "oauth" | "claude-code" | "codex" | …
    let authSource: String?
    /// Set when requests go to a custom gateway instead of the public API.
    let baseURL: String?
    let apiKeyRef: String?
    /// The operator's name for the provider, from the engine's config.
    let displayName: String?
    /// True when the provider exists only because the server's config defines
    /// it. Only a custom provider can be removed.
    let custom: Bool
    /// The run backend selected now (api | claude-code | codex | grok | cursor).
    let backend: String?
    let cli: ServerProviderCliStatus?
    /// Absent for API-only providers, or a value this app does not know.
    let loginFlow: LoginFlow?

    private enum CodingKeys: String, CodingKey {
        case id, hasAuth, authSource, baseURL, apiKeyRef, displayName, custom, backend, cli, loginFlow
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        hasAuth = try container.decode(Bool.self, forKey: .hasAuth)
        authSource = try container.decodeIfPresent(String.self, forKey: .authSource)
        baseURL = try container.decodeIfPresent(String.self, forKey: .baseURL)
        apiKeyRef = try container.decodeIfPresent(String.self, forKey: .apiKeyRef)
        displayName = try container.decodeIfPresent(String.self, forKey: .displayName)
        custom = try container.decodeIfPresent(Bool.self, forKey: .custom) ?? false
        backend = try container.decodeIfPresent(String.self, forKey: .backend)
        cli = try container.decodeIfPresent(ServerProviderCliStatus.self, forKey: .cli)
        // A flow added after this build reads as unknown, not as a broken listing.
        loginFlow = try container.decodeIfPresent(String.self, forKey: .loginFlow).flatMap(LoginFlow.init(rawValue:))
    }

    init(
        id: String, hasAuth: Bool, authSource: String? = nil, baseURL: String? = nil, apiKeyRef: String? = nil,
        displayName: String? = nil, custom: Bool = false, backend: String? = nil, cli: ServerProviderCliStatus? = nil,
        loginFlow: LoginFlow? = nil
    ) {
        self.id = id
        self.hasAuth = hasAuth
        self.authSource = authSource
        self.baseURL = baseURL
        self.apiKeyRef = apiKeyRef
        self.displayName = displayName
        self.custom = custom
        self.backend = backend
        self.cli = cli
        self.loginFlow = loginFlow
    }
}
