import React, { useState, useCallback } from 'react'
import { getProviderDisplayName } from '../../../shared/types-models'
import type { ProviderEntry } from '../../../shared/types-models'
import { useModelStore } from '../../stores/model-store'
import type { Colors, DeviceCodeState } from './provider-styles'
import { linkBtn, oauthBtn, inputSt, saveBtn, Spinner, DeviceCodeDisplay } from './provider-styles'
import { ProviderBackendSelector } from './ProviderBackendSelector'
import { ProviderCliAuth } from './ProviderCliAuth'
import {
  authSourceTooltip, providerAuthBadge,
  API_KEY_PROVIDERS, OAUTH_PROVIDERS, OAUTH_BUTTON_LABELS,
} from './provider-auth-labels'

export function ProviderRow({ provider, colors, onCredentialSaved }: {
  provider: ProviderEntry
  colors: Colors
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
  const providerModelCount = useModelStore((s) => s.models.filter((m) => m.providerId === provider.id).length)

  const isApiKeyProvider = API_KEY_PROVIDERS.has(provider.id)
  const isOAuthProvider = OAUTH_PROVIDERS.has(provider.id)
  const isOAuthSession = isOAuthProvider && provider.hasAuth && provider.authSource === 'oauth'
  const canManageKey = isApiKeyProvider && provider.hasAuth && provider.authSource !== undefined && ['filestore', 'programmatic', 'keychain', 'credentials.json'].includes(provider.authSource)
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
      setTimeout(() => { onCredentialSaved(); setRefreshing(false) }, 2500)
    } catch { setRefreshing(false) }
  }, [provider.id, onCredentialSaved])

  const badgeLabel = providerAuthBadge(provider)
  const badgeColor = provider.hasAuth ? '#22c55e' : colors.textTertiary
  const badgeBg = provider.hasAuth ? 'rgba(34,197,94,0.1)' : `${colors.textTertiary}15`
  const showApiKeyInput = isApiKeyProvider && (!provider.hasAuth || editing)
  // A stored OpenAI key that returns no models is the poisoned-credential case
  // (a ChatGPT token stored as an API key). Nudge the user to remove it or
  // switch to the codex backend.
  const showPoisonedHint = provider.id === 'openai' && provider.hasAuth
    && provider.authSource === 'filestore' && provider.backend !== 'codex' && providerModelCount === 0

  return (
    <div style={{ marginBottom: 14 }}>
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
          <button onClick={handleRefreshModels} disabled={refreshing} style={{ ...linkBtn(colors), opacity: refreshing ? 0.5 : 1 }} title="Re-fetch available models">
            {refreshing ? '…' : '↻ Models'}
          </button>
        )}
      </div>

      <ConfigDetails provider={provider} colors={colors} hasCustomGateway={hasCustomGateway} />

      {/* Backend selector for providers that can run on more than one backend. */}
      <ProviderBackendSelector provider={provider} colors={colors} />

      {/* Delegated-CLI auth (install / sign in / sign out) when a CLI backend is selected. */}
      <ProviderCliAuth provider={provider} colors={colors} />

      {showPoisonedHint && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#f59e0b' }}>
          This stored OpenAI credential isn’t returning models. Remove it, or switch the backend to ChatGPT.
        </div>
      )}

      {isOAuthProvider && !provider.hasAuth && !deviceCode && (
        <button onClick={handleOAuthLogin} disabled={oauthLoading} style={oauthBtn(colors, oauthLoading)}>
          {oauthLoading ? (<><Spinner size={12} /> Waiting for browser…</>) : (OAUTH_BUTTON_LABELS[provider.id] || 'Sign in')}
        </button>
      )}
      {deviceCode && <DeviceCodeDisplay deviceCode={deviceCode} colors={colors} />}

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

function ConfigDetails({ provider, colors, hasCustomGateway }: { provider: ProviderEntry; colors: Colors; hasCustomGateway: boolean }) {
  if (!provider.hasAuth && !hasCustomGateway && !provider.apiKeyRef) return null
  const items: Array<{ label: string; value: string; title?: string }> = []
  if (hasCustomGateway) items.push({ label: 'Gateway', value: provider.baseURL!, title: 'Requests are routed to this custom endpoint instead of the public API' })
  if (provider.apiKeyRef && provider.apiKeyRef !== 'configured') items.push({ label: 'Key', value: provider.apiKeyRef, title: 'API key reference from engine configuration' })
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
