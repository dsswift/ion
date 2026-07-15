import type { ProviderEntry } from '../../../shared/types-models'

/** Map engine authSource to a user-friendly label. */
export function humanAuthSource(source: string | undefined): string {
  switch (source) {
    case 'programmatic': return 'API key'
    case 'env': return 'environment variable'
    case 'keychain': return 'system keychain'
    case 'filestore': return 'API key'
    case 'oauth': return 'signed in'
    case 'credentials.json': return 'credentials file'
    case 'claude-code': return 'Claude Code'
    case 'codex': return 'ChatGPT'
    case 'grok': return 'Grok CLI'
    case 'cursor': return 'Cursor'
    case 'none': return 'no auth needed'
    default: return 'configured'
  }
}

/** Tooltip explaining what each auth source means. */
export function authSourceTooltip(source: string | undefined): string {
  switch (source) {
    case 'programmatic': return 'Authenticated via API key set in engine config or at runtime'
    case 'env': return 'Authenticated via environment variable (e.g. XAI_API_KEY)'
    case 'keychain': return 'Authenticated via credential stored in the system keychain'
    case 'filestore': return 'Authenticated via API key saved in Ion settings'
    case 'oauth': return 'Authenticated via browser sign-in (OAuth)'
    case 'credentials.json': return 'Authenticated via legacy credentials.json file'
    case 'claude-code': return 'Served by the Claude Code CLI; no separate API key required'
    case 'codex': return 'Served by the Codex CLI (ChatGPT subscription or OpenAI API key)'
    case 'grok': return 'Served by the Grok CLI'
    case 'cursor': return 'Served by the Cursor CLI'
    case 'none': return 'This provider runs locally and does not require authentication'
    default: return 'Provider has valid credentials'
  }
}

/**
 * Rich auth badge for a provider row: prefers the delegated-CLI's label and
 * account (e.g. "ChatGPT Pro · josh@…") when present, else the generic
 * authSource label.
 */
export function providerAuthBadge(provider: ProviderEntry): string {
  if (!provider.hasAuth) return 'not configured'
  const cli = provider.cli
  if (cli?.authenticated) {
    const label = cli.label || humanAuthSource(provider.authSource)
    return cli.email ? `${label} · ${cli.email}` : label
  }
  return humanAuthSource(provider.authSource)
}

export const API_KEY_PROVIDERS = new Set([
  'anthropic', 'openai', 'google', 'groq', 'cerebras', 'mistral',
  'openrouter', 'together', 'fireworks', 'xai', 'deepseek', 'azure',
])

// OpenAI is intentionally absent: its sign-in is engine-driven `codex login`
// (the CLI-backend auth block), not the browser OAuth flow used by Google and
// GitHub Copilot.
export const OAUTH_PROVIDERS = new Set(['google', 'github-copilot'])
export const OAUTH_BUTTON_LABELS: Record<string, string> = {
  google: 'Sign in with Google',
  'github-copilot': 'Sign in with GitHub',
}

/**
 * The run backends each provider can select. Mirrors the engine's allowed
 * per-provider backends. A single-entry list means no choice to offer.
 */
export const PROVIDER_BACKENDS: Record<string, string[]> = {
  anthropic: ['api', 'claude-code'],
  openai: ['api', 'codex'],
  xai: ['api', 'grok'],
  cursor: ['cursor'],
}

/** The delegated-CLI backend kind a provider can use, if any. */
export function providerCliBackend(providerId: string): string | undefined {
  switch (providerId) {
    case 'anthropic': return 'claude-code'
    case 'openai': return 'codex'
    case 'xai': return 'grok'
    case 'cursor': return 'cursor'
    default: return undefined
  }
}

/** Display label for a backend kind in the segmented selector. */
export function backendLabel(kind: string): string {
  switch (kind) {
    case 'api': return 'API'
    case 'claude-code': return 'Claude Code'
    case 'codex': return 'ChatGPT'
    case 'grok': return 'Grok'
    case 'cursor': return 'Cursor'
    default: return kind
  }
}

/**
 * Install guidance for each delegated CLI, shown when the binary is missing.
 * installCmd is present only where the package/command is known; for the others
 * the UI falls back to a "install the <name> CLI, then Refresh" note rather than
 * showing an unverified command.
 */
export const CLI_INSTALL_GUIDANCE: Record<string, { name: string; installCmd?: string }> = {
  // Verified from the Codex CLI's own docs (npm install -g @openai/codex).
  codex: { name: 'Codex', installCmd: 'npm install -g @openai/codex' },
  // The published Claude Code npm package.
  'claude-code': { name: 'Claude Code', installCmd: 'npm install -g @anthropic-ai/claude-code' },
  grok: { name: 'Grok' },
  cursor: { name: 'Cursor' },
}
