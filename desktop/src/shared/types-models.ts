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
  isCustom?: boolean
}

/** Wire-format provider information returned by the engine's list_models command. */
export interface ProviderEntry {
  id: string
  hasAuth: boolean
  authSource?: string
  baseURL?: string
  apiKeyRef?: string
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

/** Get human-friendly display name for a provider ID. */
export function getProviderDisplayName(providerId: string): string {
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
  return LABELS[id] || id
}
