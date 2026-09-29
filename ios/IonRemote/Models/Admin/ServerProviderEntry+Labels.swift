import Foundation

/// What the settings pages say about a provider: its name, how it is signed
/// in, and which ways of signing in it takes. The same rules as the
/// desktop's `provider-auth-labels`.
extension ServerProviderEntry {

    private static let builtInNames: [String: String] = [
        "anthropic": "Anthropic", "openai": "OpenAI", "google": "Google", "bedrock": "AWS Bedrock",
        "azure": "Azure OpenAI", "groq": "Groq", "cerebras": "Cerebras", "mistral": "Mistral",
        "openrouter": "OpenRouter", "together": "Together", "fireworks": "Fireworks", "xai": "xAI",
        "deepseek": "DeepSeek", "ollama": "Ollama",
    ]

    private static let apiKeyProviders: Set<String> = [
        "anthropic", "openai", "google", "groq", "cerebras", "mistral",
        "openrouter", "together", "fireworks", "xai", "deepseek", "azure",
    ]

    /// Providers with a browser sign-in. OpenAI signs in through its CLI instead.
    private static let oauthProviders: Set<String> = ["google", "github-copilot"]

    private static let managedKeySources: Set<String> = ["filestore", "programmatic", "keychain", "credentials.json"]
    private static let cliAuthSources: Set<String> = ["claude-code", "codex", "grok", "cursor"]

    /// The operator's name, then the built-in name, then the capitalized id.
    static func displayName(for id: String, in providers: [ServerProviderEntry]) -> String {
        if let configured = providers.first(where: { $0.id == id })?.displayName, !configured.isEmpty { return configured }
        return builtInNames[id] ?? id.prefix(1).uppercased() + id.dropFirst()
    }

    var label: String { Self.displayName(for: id, in: [self]) }

    /// The short status a row shows.
    var statusLabel: String {
        guard hasAuth else { return "Not set up" }
        if let cli, cli.authenticated {
            let name = cli.label ?? Self.authSourceLabel(authSource)
            return cli.email.map { "\(name) · \($0)" } ?? name
        }
        return Self.authSourceLabel(authSource)
    }

    /// One sentence on where the credential comes from.
    var statusDetail: String {
        guard hasAuth else { return "No credential on this server yet." }
        switch authSource {
        case "programmatic": return "An API key set in the engine's configuration."
        case "env": return "An environment variable on the server."
        case "keychain": return "A credential in the server's system keychain."
        case "filestore": return "An API key saved in Ion's settings."
        case "oauth": return "Signed in through the browser."
        case "credentials.json": return "A legacy credentials file."
        case "claude-code": return "Served by the Claude Code CLI. No separate API key is needed."
        case "codex": return "Served by the Codex CLI (a ChatGPT subscription or an OpenAI key)."
        case "grok": return "Served by the Grok CLI."
        case "cursor": return "Served by the Cursor CLI."
        case "none": return "Runs locally and needs no sign-in."
        default: return "The provider has a valid credential."
        }
    }

    private static func authSourceLabel(_ source: String?) -> String {
        switch source {
        case "programmatic", "filestore": return "API key"
        case "env": return "Environment variable"
        case "keychain": return "System keychain"
        case "oauth": return "Signed in"
        case "credentials.json": return "Credentials file"
        case "claude-code": return "Claude Code"
        case "codex": return "ChatGPT"
        case "grok": return "Grok CLI"
        case "cursor": return "Cursor"
        case "none": return "No sign-in needed"
        default: return "Configured"
        }
    }

    var hasCustomGateway: Bool { !(baseURL ?? "").isEmpty }
    var takesBrowserSignIn: Bool { Self.oauthProviders.contains(id) }
    /// A custom gateway that is not browser-signed authenticates with a key.
    var takesAPIKey: Bool { Self.apiKeyProviders.contains(id) || (hasCustomGateway && !takesBrowserSignIn) }
    var isBrowserSession: Bool { takesBrowserSignIn && hasAuth && authSource == "oauth" }
    /// A key saved through Ion or the engine config, which Change and Remove/Reset manage.
    var hasManagedKey: Bool { takesAPIKey && hasAuth && authSource.map(Self.managedKeySources.contains) == true }
    /// Signed in through its CLI; a key may be added on top.
    var isServedByCli: Bool { takesAPIKey && hasAuth && authSource.map(Self.cliAuthSources.contains) == true }
    /// A saved key is removed; any other managed source is reset to what lies under it.
    var removesKeyOutright: Bool { authSource == "filestore" }

    /// The delegated CLI this provider can sign in through, if any.
    var cliKind: String? {
        switch id {
        case "anthropic": return "claude-code"
        case "openai": return "codex"
        case "xai": return "grok"
        case "cursor": return "cursor"
        default: return nil
        }
    }

    var cliName: String {
        switch cliKind {
        case "claude-code": return "Claude Code"
        case "codex": return "Codex"
        case "grok": return "Grok"
        case "cursor": return "Cursor"
        default: return label
        }
    }

    /// The install command, where it is known.
    var cliInstallCommand: String? {
        switch cliKind {
        case "claude-code": return "npm install -g @anthropic-ai/claude-code"
        case "codex": return "npm install -g @openai/codex"
        default: return nil
        }
    }

    /// True when the CLI's sign-in can only finish in a browser on the server's host.
    var cliSignInIsHostOnly: Bool { loginFlow == .browserCallback }
}
