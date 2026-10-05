// ─── Model & Provider Types (wire-format, mirrors Go types) ───

/** Wire-format model information returned by the engine's list_models command. */
export interface ModelEntry {
  id: string
  providerId: string
  /**
   * Human-friendly model name ("Claude Opus 4.8"), carried from the engine's
   * model catalog or a provider /models payload (mirrors Go ModelEntry.
   * DisplayName). Preferred over the machine id in the picker; absent means the
   * client derives a label from the id. Additive, omitempty.
   */
  displayName?: string
  contextWindow: number
  costPer1kInput: number
  costPer1kOutput: number
  /** Explicit prompt-cache creation price per 1k input tokens, when published. */
  costPer1kCacheCreation?: number
  /** Explicit prompt-cache read price per 1k input tokens, when published. */
  costPer1kCacheRead?: number
  supportsCaching?: boolean
  /**
   * Prompt-cache lifetime in seconds, as declared by the engine for this model
   * (mirrors Go ModelEntry.CacheTtlSeconds). A cached prompt is only billable
   * at the cheap read rate for this long after the write that created it, so
   * anything pricing a conversation's next turn needs the lifetime as well as
   * the rates. Absent means the engine declared none; clients must not
   * substitute a default.
   */
  cacheTtlSeconds?: number
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
  /** The signed-in account's organization, when the CLI reports one. */
  orgId?: string
  orgName?: string
  label?: string
  probedAt?: string
}

/** A usage limit kind a delegated CLI reports. Mirrors Go's UsageLimit* constants. */
export type ProviderUsageLimitKind = 'session' | 'weekly' | 'weekly_model' | 'spend'

/** The account a delegated CLI is signed in to. Mirrors Go ProviderAccount. */
export interface ProviderAccount {
  /** The provider id the CLI serves (e.g. "anthropic"). */
  provider: string
  email?: string
  orgId?: string
  orgName?: string
  planType?: string
  authMethod?: string
  label?: string
}

/** One usage limit of an account, as its CLI reported it. Mirrors Go ProviderUsageLimit. */
export interface ProviderUsageLimit {
  kind: ProviderUsageLimitKind
  /** What the limit covers when the kind alone does not say (a weekly_model limit's model). */
  label?: string
  /** How much of the limit is used, 0..100 (above 100 once exceeded). */
  percent: number
  /** RFC3339 time the limit resets; absent when unknown. */
  resetsAt?: string
}

/** One delegated CLI's account and usage limits. Element of the provider_account_usage result. */
export interface ProviderAccountUsage {
  backend: string
  /** Absent when the CLI is signed out. */
  account?: ProviderAccount
  limits: ProviderUsageLimit[]
  /** RFC3339 time this entry was read. */
  fetchedAt: string
  /** Why the limits could not be read; the account is still reported. */
  error?: string
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
  /**
   * True for a provider that exists only because the engine's config defines
   * it (mirrors Go ProviderEntry.Custom). Only a custom provider can be
   * removed.
   */
  custom?: boolean
  /** Run backend currently selected for this provider (api | claude-code | codex | grok | cursor). */
  backend?: string
  /** Delegated-CLI install/auth status; present only for providers with a CLI backend option. */
  cli?: ProviderCliStatus
  /**
   * How this provider's delegated-CLI sign-in completes (mirrors Go
   * ProviderEntry.LoginFlow); absent for API-only providers. A client driving
   * a REMOTE engine uses it to refuse, up front, a flow that can only finish
   * on the engine's own host.
   */
  loginFlow?: ProviderLoginFlow
}

/**
 * `browser-code`: authorize URL plus a pasted code, works from anywhere.
 * `browser-or-device-code`: loopback-callback browser on the engine host, or
 * a device code; only the device-code branch finishes remotely.
 * `browser-callback`: the CLI's own browser with a loopback callback on the
 * engine host; cannot finish from another machine.
 */
export type ProviderLoginFlow = 'browser-code' | 'browser-or-device-code' | 'browser-callback'

/** True when a delegated-CLI sign-in with this flow can never complete from a client on another machine. */
export function loginFlowIsHostOnly(flow: ProviderLoginFlow | undefined): boolean {
  return flow === 'browser-callback'
}

/** What a client that is not on the engine's host is told when it tries a host-only sign-in. */
export const HOST_ONLY_LOGIN_REFUSAL = 'This sign-in opens a browser on the host itself and cannot finish from here. Sign in on the host, or use an API key.'

/**
 * Run backends that delegate the conversation to a CLI subprocess, which owns
 * its own native session and performs its own compaction. The engine cannot
 * compact one of these conversations itself — it holds the transcript, but the
 * live context belongs to the subprocess.
 */
export const DELEGATED_CLI_BACKENDS = new Set(['claude-code', 'codex', 'grok', 'cursor'])

/** True when a provider entry routes to a delegated CLI rather than the engine. */
export function isDelegatedCliBackend(backend: string | undefined): boolean {
  return backend !== undefined && DELEGATED_CLI_BACKENDS.has(backend)
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

/**
 * Get the human-visible label for a model entry. The engine is the only source
 * of model names: it supplies ModelEntry.displayName from its catalog or from
 * the provider's own /models payload. An entry the engine could not name is
 * shown by its id, so a missing name is visible rather than guessed at.
 *
 * The engine qualifies an id as "<providerId>/<model>" when another provider
 * owns the bare id. That prefix is routing, not identity, so it is dropped from
 * an unnamed entry's label. An OpenRouter-style id, whose slash is part of the
 * wire id (prefix differs from providerId), is shown whole.
 */
export function getModelDisplayLabel(model: Pick<ModelEntry, 'id' | 'providerId' | 'displayName'>): string {
  if (model.displayName) return model.displayName
  const qualifier = `${model.providerId}/`
  return model.id.startsWith(qualifier) ? model.id.slice(qualifier.length) : model.id
}
