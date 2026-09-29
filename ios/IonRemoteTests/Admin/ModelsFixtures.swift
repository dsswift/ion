import Foundation
@testable import IonRemote

/// Results in the shapes the server's provider, model, and settings handlers
/// return (`server/src/engine/provider-api.ts`, `protocol/auth-flow-actions.ts`,
/// `protocol/settings-actions.ts`).
enum ModelsFixtures {

    static func json(_ text: String) -> JSONValue { ProjectsFixtures.json(text) }

    /// `model.list`: a signed-in Anthropic through its CLI, an OpenAI with a
    /// saved key behind a gateway, an unconfigured Groq, and a Codex login flow.
    static let catalog = """
    {"models":[
       {"id":"claude-sonnet-5","providerId":"anthropic","displayName":"Claude Sonnet 5","contextWindow":200000,"costPer1kInput":0.003,"costPer1kOutput":0.015},
       {"id":"claude-haiku-4-5","providerId":"anthropic","contextWindow":200000,"costPer1kInput":0.001,"costPer1kOutput":0.005},
       {"id":"openai/gpt-5","providerId":"openai","contextWindow":400000,"costPer1kInput":0.002,"costPer1kOutput":0.01},
       {"id":"llama-4","providerId":"groq","contextWindow":128000,"costPer1kInput":0,"costPer1kOutput":0}
     ],
     "providers":[
       {"id":"groq","hasAuth":false,"authSource":"none"},
       {"id":"anthropic","hasAuth":true,"authSource":"claude-code","backend":"claude-code","loginFlow":"browser-code",
        "cli":{"backend":"claude-code","installed":true,"authenticated":true,"email":"user@example.com","label":"Claude Max"}},
       {"id":"openai","hasAuth":true,"authSource":"filestore","baseURL":"https://gateway.example.org/v1","backend":"api","loginFlow":"browser-or-device-code",
        "cli":{"backend":"codex","installed":false,"authenticated":false}},
       {"id":"xai","hasAuth":false,"loginFlow":"browser-callback","cli":{"backend":"grok","installed":true,"authenticated":false}},
       {"id":"google","hasAuth":false,"loginFlow":"a-flow-from-a-newer-engine"}
     ]}
    """

    /// `model.listTiers`: the engine sends null for no fallbacks.
    static let tiers = """
    [{"name":"fast","model":"claude-haiku-4-5","fallbacks":null},
     {"name":"standard","model":"claude-sonnet-5","fallbacks":["openai/gpt-5","claude-haiku-4-5"]},
     {"name":"review","model":"gone-model","fallbacks":[]}]
    """

    /// `aiAssist.workflows`, trimmed to two workflows.
    static let workflows = """
    [{"id":"rebase-resolution","label":"Rebase Resolution","description":"Resolves a worktree sync that stopped during rebase.",
      "placeholders":["directory"],"defaultTemplate":"Resolve the rebase in {{directory}}."},
     {"id":"merge-resolution","label":"Merge Resolution","description":"Resolves a merge conflict.",
      "placeholders":["directory","benchContext"],"defaultTemplate":"Resolve the merge in {{directory}}.\\n\\n{{benchContext}}"}]
    """

    /// `settings.load`: the Environment document with the caller's values over it.
    static let settings = """
    {"preferredModel":"claude-sonnet-5","engineDefaultModel":"",
     "engineProfiles":[{"id":"a1b2c3d4","name":"cos","extensions":["/srv/ext/cos/index.ts"],"defaultMode":"plan"}],
     "aiAssistPromptOverrides":{"merge-resolution":"Merge {{directory}} carefully."}}
    """

    static let ok = json(#"{"ok":true}"#)

    static func declined(_ message: String) -> JSONValue {
        .object(["ok": .bool(false), "error": .string(message)])
    }
}
