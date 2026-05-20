import React, { useState, useEffect, useCallback } from 'react'
import { useColors } from '../../theme'
import { SettingHeading } from './SettingHeading'
import { useModelStore } from '../../stores/model-store'
import { getProviderDisplayName } from '../../../shared/types-models'
import type { ProviderEntry } from '../../../shared/types-models'

/** Map engine authSource to user-friendly label. */
function humanAuthSource(source: string | undefined): string {
  switch (source) {
    case 'programmatic': return 'API key'
    case 'env': return 'environment variable'
    case 'keychain': return 'system keychain'
    case 'filestore': return 'API key'
    case 'oauth': return 'signed in'
    case 'credentials.json': return 'credentials file'
    case 'none': return 'no auth needed'
    default: return 'configured'
  }
}

/** Tooltip explaining what each auth source means. */
function authSourceTooltip(source: string | undefined): string {
  switch (source) {
    case 'programmatic': return 'Authenticated via API key set in engine config or at runtime'
    case 'env': return 'Authenticated via environment variable (e.g. XAI_API_KEY)'
    case 'keychain': return 'Authenticated via credential stored in the system keychain'
    case 'filestore': return 'Authenticated via API key saved in Ion settings'
    case 'oauth': return 'Authenticated via browser sign-in (OAuth)'
    case 'credentials.json': return 'Authenticated via legacy credentials.json file'
    case 'none': return 'This provider runs locally and does not require authentication'
    default: return 'Provider has valid credentials'
  }
}

const API_KEY_PROVIDERS = new Set([
  'anthropic', 'openai', 'google', 'groq', 'cerebras', 'mistral',
  'openrouter', 'together', 'fireworks', 'xai', 'deepseek', 'azure',
])
const OAUTH_PROVIDERS = new Set(['openai', 'google', 'github-copilot'])
const OAUTH_BUTTON_LABELS: Record<string, string> = {
  openai: 'Sign in with OpenAI',
  google: 'Sign in with Google',
  'github-copilot': 'Sign in with GitHub',
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
        <div style={{ padding: '12px 0', fontSize: 12, color: colors.textTertiary }}>Loading providers…</div>
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
  const [editing, setEditing] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [deviceCode, setDeviceCode] = useState<DeviceCodeState | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const isApiKeyProvider = API_KEY_PROVIDERS.has(provider.id)
  const isOAuthProvider = OAUTH_PROVIDERS.has(provider.id)
  const isOAuthSession = isOAuthProvider && provider.hasAuth && provider.authSource === 'oauth'
  const canManageKey = isApiKeyProvider && provider.hasAuth
  const hasCustomGateway = !!provider.baseURL

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return
    setSaving(true); setError(null)
    try {
      const result = await window.ion.storeCredential(provider.id, apiKey.trim())
      if (result.ok) { setSaved(true); setApiKey(''); setEditing(false); setTimeout(() => setSaved(false), 2000); onCredentialSaved() }
      else setError(result.error || 'Failed to save')
    } catch (err) { setError((err as Error).message) }
    finally { setSaving(false) }
  }, [apiKey, provider.id, onCredentialSaved])

  const handleRemoveKey = useCallback(async () => {
    setError(null)
    try {
      const result = await window.ion.storeCredential(provider.id, '')
      if (result.ok) onCredentialSaved()
      else setError(result.error || 'Failed to remove')
    } catch (err) { setError((err as Error).message) }
  }, [provider.id, onCredentialSaved])

  const handleOAuthLogin = useCallback(async () => {
    setOauthLoading(true); setError(null); setDeviceCode(null)
    try {
      if (provider.id === 'github-copilot') {
        const dc = await window.ion.oauthDeviceCode(provider.id)
        if (!dc.ok) { setError(dc.error || 'Failed to start'); setOauthLoading(false); return }
        setDeviceCode({ userCode: dc.userCode!, verificationUri: dc.verificationUri!, deviceCode: dc.deviceCode!, interval: dc.interval!, expiresIn: dc.expiresIn! })
        window.ion.openExternal(dc.verificationUri!)
        const poll = await window.ion.oauthDevicePoll(dc.deviceCode!, dc.interval!, dc.expiresIn!)
        if (poll.ok) onCredentialSaved(); else setError(poll.error || 'Device flow failed')
        setDeviceCode(null)
      } else {
        const result = await window.ion.startOAuth(provider.id)
        if (result.ok) onCredentialSaved(); else setError(result.error || 'OAuth failed')
      }
    } catch (err) { setError((err as Error).message) }
    finally { setOauthLoading(false) }
  }, [provider.id, onCredentialSaved])

  const handleOAuthLogout = useCallback(async () => {
    setError(null)
    try { await window.ion.logoutOAuth(provider.id); onCredentialSaved() }
    catch (err) { setError((err as Error).message) }
  }, [provider.id, onCredentialSaved])

  const handleRefreshModels = useCallback(async () => {
    setRefreshing(true)
    try {
      await window.ion.refreshModels(provider.id)
      // Wait for the engine to discover and the main process to refresh cache
      setTimeout(() => { onCredentialSaved(); setRefreshing(false) }, 2500)
    } catch {
      setRefreshing(false)
    }
  }, [provider.id, onCredentialSaved])

  const badgeLabel = provider.hasAuth ? humanAuthSource(provider.authSource) : 'not configured'
  const badgeColor = provider.hasAuth ? '#22c55e' : colors.textTertiary
  const badgeBg = provider.hasAuth ? 'rgba(34,197,94,0.1)' : `${colors.textTertiary}15`
  const showApiKeyInput = isApiKeyProvider && (!provider.hasAuth || editing)

  return (
    <div style={{ marginBottom: 14 }}>
      {/* Title row: provider name + badge + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
        <span style={{ color: colors.textSecondary, fontSize: 13, fontWeight: 500 }}>
          {getProviderDisplayName(provider.id)}
        </span>
        <span title={authSourceTooltip(provider.authSource)} style={{ fontSize: 10, fontWeight: 500, color: badgeColor, padding: '1px 6px', borderRadius: 4, background: badgeBg, cursor: 'default' }}>
          {badgeLabel}
        </span>
        {isOAuthSession && <button onClick={handleOAuthLogout} style={linkBtn(colors)}>Sign out</button>}
        {canManageKey && !editing && (
          <>
            <button onClick={() => setEditing(true)} style={linkBtn(colors)}>Change</button>
            <button onClick={handleRemoveKey} style={linkBtn(colors)} title={provider.authSource === 'filestore' ? 'Remove saved API key' : 'Clear override and revert to the underlying credential source'}>
              {provider.authSource === 'filestore' ? 'Remove' : 'Reset'}
            </button>
          </>
        )}
        {provider.hasAuth && (
          <button
            onClick={handleRefreshModels}
            disabled={refreshing}
            style={{ ...linkBtn(colors), opacity: refreshing ? 0.5 : 1 }}
            title="Re-fetch available models from this provider's API"
          >
            {refreshing ? '…' : '↻ Models'}
          </button>
        )}
      </div>

      {/* Config details: gateway + API key ref */}
      <ConfigDetails provider={provider} colors={colors} hasCustomGateway={hasCustomGateway} />

      {/* Anthropic backend toggle (CLI vs API) */}
      {provider.id === 'anthropic' && <AnthropicBackendToggle colors={colors} />}

      {/* OAuth */}
      {isOAuthProvider && !provider.hasAuth && !deviceCode && (
        <button onClick={handleOAuthLogin} disabled={oauthLoading} style={oauthBtn(colors, oauthLoading)}>
          {oauthLoading ? (<><Spinner size={12} /> Waiting for browser…</>) : (OAUTH_BUTTON_LABELS[provider.id] || `Sign in`)}
        </button>
      )}
      {deviceCode && <DeviceCodeDisplay deviceCode={deviceCode} colors={colors} />}

      {/* API key input */}
      {showApiKeyInput && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          <input type="password" placeholder={editing ? 'New API key' : `${getProviderDisplayName(provider.id)} API key`} value={apiKey} onChange={(e) => setApiKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSave()} style={inputSt(colors)} />
          <button onClick={handleSave} disabled={saving || !apiKey.trim()} style={saveBtn(colors, saving || !apiKey.trim())}>{saving ? '…' : saved ? '✓' : 'Save'}</button>
          {editing && <button onClick={() => { setEditing(false); setApiKey('') }} style={linkBtn(colors)}>Cancel</button>}
        </div>
      )}

      {error && <div style={{ marginTop: 4, fontSize: 11, color: '#ef4444' }}>{error}</div>}
    </div>
  )
}

// ─── Config Details ───────────────────────────────────────────────

function ConfigDetails({ provider, colors, hasCustomGateway }: { provider: ProviderEntry; colors: Colors; hasCustomGateway: boolean }) {
  if (!provider.hasAuth && !hasCustomGateway && !provider.apiKeyRef) return null

  const items: Array<{ label: string; value: string; title?: string }> = []

  if (hasCustomGateway) {
    items.push({ label: 'Gateway', value: provider.baseURL!, title: 'Requests are routed to this custom endpoint instead of the public API' })
  }

  if (provider.apiKeyRef && provider.apiKeyRef !== 'configured') {
    items.push({ label: 'Key', value: provider.apiKeyRef, title: 'API key reference from engine configuration' })
  }

  if (items.length === 0) return null

  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
      {items.map((item) => (
        <span key={item.label} title={item.title} style={{ fontSize: 11, color: colors.textTertiary }}>
          <span style={{ fontWeight: 500 }}>{item.label}:</span>{' '}
          <span style={{ fontFamily: 'monospace', fontSize: 10 }}>{item.value}</span>
        </span>
      ))}
      {hasCustomGateway && (
        <span style={{ fontSize: 10, color: '#f59e0b', fontWeight: 500 }} title="This provider is configured with a custom gateway — not the public cloud API">
          custom gateway
        </span>
      )}
    </div>
  )
}

// ─── Anthropic Backend Toggle ─────────────────────────────────────

function AnthropicBackendToggle({ colors }: { colors: Colors }) {
  const [backend, setBackend] = useState<'api' | 'cli' | null>(null)
  const [confirming, setConfirming] = useState<'api' | 'cli' | null>(null)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => { window.ion.getBackend().then(setBackend) }, [])

  if (!backend) return null

  const handleSwitch = (target: 'api' | 'cli') => {
    if (target === backend || restarting) return
    setConfirming(target)
  }

  const confirmSwitch = () => {
    if (!confirming || restarting) return
    setRestarting(true)
    window.ion.switchBackend(confirming)
  }

  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: colors.textTertiary }}>Backend:</span>
        <div style={{ display: 'inline-flex', background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 5, overflow: 'hidden' }}>
          {(['cli', 'api'] as const).map((mode) => (
            <button key={mode} onClick={() => handleSwitch(mode)} style={{
              padding: '2px 10px', background: backend === mode ? colors.accent : 'transparent',
              color: backend === mode ? '#fff' : colors.textTertiary, border: 'none',
              cursor: 'pointer', fontSize: 11, fontWeight: backend === mode ? 600 : 400,
              textTransform: 'uppercase', transition: 'background 0.15s, color 0.15s',
            }}>
              {mode}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 10, color: colors.textTertiary }}>
          {backend === 'cli' ? 'Uses Claude subscription via CLI' : 'Direct API with API key'}
        </span>
      </div>
      {(confirming || restarting) && (
        <div style={{ marginTop: 6, padding: '8px 10px', background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 6, fontSize: 11, color: colors.textSecondary }}>
          {restarting ? <span style={{ fontWeight: 500 }}>Restarting…</span> : (
            <>
              Switch to <strong>{confirming!.toUpperCase()}</strong>? The app will restart.{' '}
              <button onClick={confirmSwitch} style={{ color: colors.accent, background: 'none', border: 'none', fontWeight: 600, cursor: 'pointer', fontSize: 11 }}>Switch</button>
              {' · '}
              <button onClick={() => setConfirming(null)} style={{ color: colors.textTertiary, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11 }}>Cancel</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Shared styles ────────────────────────────────────────────────

type Colors = ReturnType<typeof useColors>

function linkBtn(c: Colors): React.CSSProperties {
  return { padding: '1px 6px', background: 'transparent', color: c.textTertiary, border: `1px solid ${c.containerBorder}`, borderRadius: 4, fontSize: 10, cursor: 'pointer' }
}
function oauthBtn(c: Colors, loading: boolean): React.CSSProperties {
  return { padding: '6px 14px', background: c.accent, color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }
}
function inputSt(c: Colors): React.CSSProperties {
  return { flex: 1, padding: '5px 8px', background: c.surfacePrimary, color: c.textPrimary, border: `1px solid ${c.containerBorder}`, borderRadius: 6, fontSize: 12, outline: 'none' }
}
function saveBtn(c: Colors, disabled: boolean): React.CSSProperties {
  return { padding: '5px 10px', background: c.accent, color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }
}

// ─── Sub-components ───────────────────────────────────────────────

interface DeviceCodeState { userCode: string; verificationUri: string; deviceCode: string; interval: number; expiresIn: number }

function DeviceCodeDisplay({ deviceCode, colors }: { deviceCode: DeviceCodeState; colors: Colors }) {
  return (
    <div style={{ padding: '8px 12px', background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 6, fontSize: 12, marginTop: 4 }}>
      <div style={{ marginBottom: 4, color: colors.textSecondary, fontSize: 11 }}>Enter this code on GitHub:</div>
      <div style={{ fontFamily: 'monospace', fontSize: 18, fontWeight: 700, letterSpacing: 2, color: colors.textPrimary, userSelect: 'all', marginBottom: 4 }}>{deviceCode.userCode}</div>
      <div style={{ fontSize: 10, color: colors.textTertiary, display: 'flex', alignItems: 'center', gap: 6 }}><Spinner size={10} /> Waiting for authorization…</div>
    </div>
  )
}

function Spinner({ size = 14 }: { size?: number }) {
  return <span style={{ display: 'inline-block', width: size, height: size, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'ion-spin 0.6s linear infinite', flexShrink: 0 }} />
}
