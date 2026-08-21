// ─── Model & Provider Types (wire-format, mirrors Go types) ───

/** Wire-format model information returned by the engine's list_models command. */
export interface ModelEntry {
  id: string
  providerId: string
  contextWindow: number
  costPer1kInput: number
  costPer1kOutput: number
  supportsCaching?: boolean
  supportsThinking?: boolean
  supportsImages?: boolean
  /**
   * Maximum output-token capacity per response for this model (mirrors Go
   * ModelEntry.MaxOutputTokens). The engine uses it to size the outbound
   * max_tokens directive; absent for models with no declared cap.
   */
  maxOutputTokens?: number
  /**
   * Usable input capacity after the engine reserves this model's output
   * capacity and the compaction summary reserve (mirrors Go
   * ModelEntry.EffectiveContextLimit). Absent for models with no declared
   * output cap, where the engine cannot compute a reserve.
   */
  effectiveContextLimit?: number
  /**
   * Reasoning mechanism this model uses on the wire (mirrors Go ModelEntry):
   * "adaptive" | "budget" | "reasoning_effort" | "gemini" | "none" | "".
   * Clients use it together with thinkingEfforts to show/gray the
   * per-conversation thinking control honestly.
   */
  thinkingMode?: string
  /**
   * Effort levels this model accepts, e.g. ["low","medium","high"]. Empty ⇒ the
   * model has no override levels to offer, so clients render the thinking
   * control DISABLED — never hidden.
   */
  thinkingEfforts?: string[]
  /**
   * BPE encoding identifier for the local tiktoken tokenizer. Used by the
   * context-breakdown builder to resolve Tier `local` counts offline.
   * Values: "o200k_base" (GPT-4o / Claude-family), "cl100k_base" (legacy).
   * Absent for models with no local encoder mapping.
   */
  tokenizer?: string
  /**
   * API shape this model uses. "" / absent means "chat" (standard conversational
   * chat-completion API). "image" means a dedicated image-generation API (e.g.
   * DALL-E 3, gpt-image-1) — the engine routes these through runImageLoop, which
   * sends only the current prompt with no conversation history. Additive, omitempty.
   */
  modelKind?: string
  /**
   * Wire protocol a dialect-dispatching (gateway) provider speaks for this model
   * (mirrors Go ModelEntry.Dialect):
   * "anthropic" | "openai-chat" | "openai-responses" | "image".
   * Absent for stock providers (their own protocol applies). Additive, omitempty.
   */
  dialect?: string
  /**
   * USD cost of one standard (1MP) image generation for per-image-billed image
   * models (mirrors Go ModelEntry.CostPerImage). Absent for chat models and
   * image models with unknown pricing. Additive, omitempty.
   */
  costPerImage?: number
  isCustom?: boolean
}

/**
 * Install and auth state of a provider's delegated CLI (claude/codex/grok/
 * cursor). A probe snapshot the engine caches; mirrors Go ProviderCliStatus.
 */
export interface ProviderCliStatus {
  backend: string
  installed: boolean
  binaryPath?: string
  version?: string
  authenticated: boolean
  authMethod?: string
  planType?: string
  email?: string
  label?: string
  probedAt?: string
}

/** Wire-format provider information returned by the engine's list_models command. */
export interface ProviderEntry {
  id: string
  hasAuth: boolean
  /** "env" | "keychain" | "filestore" | "oauth" | "claude-code" | "codex" | "grok" | "cursor" | "none" | ... */
  authSource?: string
  baseURL?: string
  apiKeyRef?: string
  /**
   * Operator-configured human-friendly name for this provider (mirrors Go
   * ProviderEntry.DisplayName, from engine.json's provider displayName).
   * Absent means clients fall back to the built-in name map / capitalized id.
   */
  displayName?: string
  /** Run backend currently selected for this provider (api | claude-code | codex | grok | cursor). */
  backend?: string
  /** Delegated-CLI install/auth status; present only for providers with a CLI backend option. */
  cli?: ProviderCliStatus
}

/** Response shape from the list_models engine command. */
export interface ModelsListResponse {
  models: ModelEntry[]
  providers: ProviderEntry[]
}

/** Human-friendly display names for provider IDs. */
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  bedrock: 'AWS Bedrock',
  azure: 'Azure OpenAI',
  groq: 'Groq',
  cerebras: 'Cerebras',
  mistral: 'Mistral',
  openrouter: 'OpenRouter',
  together: 'Together',
  fireworks: 'Fireworks',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
}

/**
 * Get human-friendly display name for a provider ID. When the engine's
 * provider entries are available, an operator-configured displayName
 * (engine.json) wins over the built-in name map; the final fallback is the
 * capitalized id.
 */
export function getProviderDisplayName(providerId: string, providers?: Array<Pick<ProviderEntry, 'id' | 'displayName'>>): string {
  const configured = providers?.find((p) => p.id === providerId)?.displayName
  if (configured) return configured
  return PROVIDER_NAMES[providerId] || providerId.charAt(0).toUpperCase() + providerId.slice(1)
}

/** Get human-friendly label for a model entry. */
export function getModelDisplayLabel(model: ModelEntry): string {
  const id = model.id
  // Well-known model name simplifications
  const LABELS: Record<string, string> = {
    'claude-opus-4-6': 'Opus 4.6',
    'claude-opus-4-7': 'Opus 4.7',
    'claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-haiku-4-5-20251001': 'Haiku 4.5',
    'gpt-4.1': 'GPT-4.1',
    'gpt-4.1-mini': 'GPT-4.1 Mini',
    'o4-mini': 'o4-mini',
    'o3': 'o3',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'grok-3': 'Grok 3',
    'grok-3-fast': 'Grok 3 Fast',
    'grok-3-mini': 'Grok 3 Mini',
    'grok-3-mini-fast': 'Grok 3 Mini Fast',
    'grok-2': 'Grok 2',
    'deepseek-chat': 'DeepSeek Chat',
    'deepseek-reasoner': 'DeepSeek Reasoner',
    'llama-3.3-70b-versatile': 'Llama 3.3 70B',
    'llama-3.1-8b-instant': 'Llama 3.1 8B',
    'mistral-large-latest': 'Mistral Large',
    'mistral-small-latest': 'Mistral Small',
    'llama-3.3-70b': 'Llama 3.3 70B',
    'llama-3.1-8b': 'Llama 3.1 8B',
  }
  if (LABELS[id]) return LABELS[id]
  // Provider-qualified id ("<providerId>/<model>"): label as "<bare or known
  // label> (<providerId>)" so a gateway copy is distinguishable from the same
  // bare model on its public provider. OpenRouter-style ids, where the slash
  // is part of the wire id (prefix != providerId), pass through unchanged.
  const slash = id.indexOf('/')
  if (slash > 0 && id.slice(0, slash) === model.providerId) {
    const bare = id.slice(slash + 1)
    return `${LABELS[bare] || bare} (${model.providerId})`
  }
  return id
}
