import React, { useState, useEffect, useCallback } from 'react'
import { useColors } from '../../theme'
import { SettingSection } from './SettingSection'
import { SettingHeading } from './SettingHeading'
import { useModelStore } from '../../stores/model-store'
import { getProviderDisplayName } from '../../../shared/types-models'
import type { ProviderEntry } from '../../../shared/types-models'

/** Providers that support API key auth (entered manually). */
const API_KEY_PROVIDERS = new Set([
  'openai', 'google', 'groq', 'cerebras', 'mistral',
  'openrouter', 'together', 'fireworks', 'xai', 'deepseek',
  'azure',
])

/** Providers that need no auth. */
const NO_AUTH_PROVIDERS = new Set(['ollama'])

/** Hint text shown per provider. */
const PROVIDER_HINTS: Record<string, string> = {
  anthropic: 'Anthropic uses the Claude CLI backend for OAuth. Configure in Backend Mode.',
  ollama: 'Ollama runs locally — no API key needed.',
  bedrock: 'AWS Bedrock uses AWS credentials (AWS_ACCESS_KEY_ID env var).',
  azure: 'Set AZURE_OPENAI_API_KEY or enter below.',
}

export function ProvidersCategory() {
  const colors = useColors()
  const fetchModels = useModelStore((s) => s.fetchModels)
  const providers = useModelStore((s) => s.providers)
  const loading = useModelStore((s) => s.loading)

  useEffect(() => { fetchModels() }, [fetchModels])

  return (
    <>
      <SettingHeading first>Providers</SettingHeading>

      {loading && providers.length === 0 && (
        <div style={{ padding: '12px 0', fontSize: 12, color: colors.textTertiary }}>
          Loading providers…
        </div>
      )}

      {providers.map((p) => (
        <ProviderRow key={p.id} provider={p} colors={colors} onCredentialSaved={fetchModels} />
      ))}

      {providers.length === 0 && !loading && (
        <div style={{ padding: '12px 0', fontSize: 12, color: colors.textTertiary }}>
          No providers available. Start the engine to see providers.
        </div>
      )}
    </>
  )
}

function ProviderRow({ provider, colors, onCredentialSaved }: {
  provider: ProviderEntry
  colors: ReturnType<typeof useColors>
  onCredentialSaved: () => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isApiKeyProvider = API_KEY_PROVIDERS.has(provider.id)
  const isNoAuth = NO_AUTH_PROVIDERS.has(provider.id)
  const hint = PROVIDER_HINTS[provider.id] || null

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return
    setSaving(true)
    setError(null)
    try {
      const result = await window.ion.storeCredential(provider.id, apiKey.trim())
      if (result.ok) {
        setSaved(true)
        setApiKey('')
        setTimeout(() => setSaved(false), 2000)
        onCredentialSaved()
      } else {
        setError(result.error || 'Failed to save')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [apiKey, provider.id, onCredentialSaved])

  const statusBadge = provider.hasAuth
    ? { label: provider.authSource || 'configured', color: '#22c55e' }
    : { label: 'not configured', color: colors.textTertiary }

  return (
    <SettingSection
      label={getProviderDisplayName(provider.id)}
      description={hint || undefined}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: isApiKeyProvider && !provider.hasAuth ? 8 : 0 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: statusBadge.color,
            padding: '2px 8px',
            borderRadius: 4,
            background: provider.hasAuth ? 'rgba(34,197,94,0.1)' : `${colors.textTertiary}15`,
          }}
        >
          {statusBadge.label}
        </span>
      </div>

      {isApiKeyProvider && !provider.hasAuth && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="password"
            placeholder={`${getProviderDisplayName(provider.id)} API key`}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            style={{
              flex: 1,
              padding: '6px 10px',
              background: colors.surfacePrimary,
              color: colors.textPrimary,
              border: `1px solid ${colors.containerBorder}`,
              borderRadius: 6,
              fontSize: 12,
              outline: 'none',
            }}
          />
          <button
            onClick={handleSave}
            disabled={saving || !apiKey.trim()}
            style={{
              padding: '6px 12px',
              background: colors.accent,
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: saving || !apiKey.trim() ? 'not-allowed' : 'pointer',
              opacity: saving || !apiKey.trim() ? 0.5 : 1,
            }}
          >
            {saving ? '…' : saved ? '✓' : 'Save'}
          </button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#ef4444' }}>{error}</div>
      )}
    </SettingSection>
  )
}
