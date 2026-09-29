/**
 * ProviderPanel — one provider on one server: how it is signed in, its
 * browser or CLI sign-in, its API key, and a model refresh. Every shell verb
 * runs inside that server's target scope, so the bridged studio_action goes
 * to it and not to this device.
 */
import React, { useCallback, useState } from 'react'
import { ArrowClockwise, Copy } from '@phosphor-icons/react'
import { getProviderDisplayName, type ProviderEntry } from '@ion/shared/types-models'
import { useModelStore, environmentModels } from '@ion/server/store/model-store'
import { withTargetEnvironment } from '../../../../studio/connection/tab-environment'
import { host } from '../../../../host/host-instance'
import { rError, rWarn } from '../../../../rendererLogger'
import { API_KEY_PROVIDERS, OAUTH_BUTTON_LABELS, OAUTH_PROVIDERS, authSourceTooltip, providerAuthBadge } from '../../provider-auth-labels'
import { Button, Chip, ErrorText, FormGroup, FormRow, Inline, MonoLine, Muted, Notice, SidePanel, Stack, TextInput } from '../../kit'
import { ProviderCliSignIn, Wide } from './ProviderCliSignIn'
import { describeProviderActionError } from './provider-action-error'

interface DeviceCodeState { userCode: string; verificationUri: string; deviceCode: string; interval: number; expiresIn: number }

const MANAGED_KEY_SOURCES = ['filestore', 'programmatic', 'keychain', 'credentials.json']
const CLI_AUTH_SOURCES = ['claude-code', 'codex', 'grok', 'cursor']

export function ProviderPanel({ provider, environmentId, onClose, onCredentialSaved }: {
  provider: ProviderEntry
  environmentId: string
  onClose(): void
  onCredentialSaved(): void
}): React.JSX.Element {
  const providers = useModelStore((s) => environmentModels(s, environmentId).providers)
  const modelCount = useModelStore((s) => environmentModels(s, environmentId).models.filter((m) => m.providerId === provider.id).length)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [deviceCode, setDeviceCode] = useState<DeviceCodeState | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const onEnv = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => withTargetEnvironment(environmentId, fn), [environmentId])

  const name = getProviderDisplayName(provider.id, [provider, ...providers])
  const hasCustomGateway = !!provider.baseURL
  // A custom gateway that is not OAuth-backed (an enterprise APIM gateway)
  // authenticates with an API key exactly like the built-in key providers.
  const isApiKeyProvider = API_KEY_PROVIDERS.has(provider.id) || (hasCustomGateway && !OAUTH_PROVIDERS.has(provider.id))
  const isOAuthProvider = OAUTH_PROVIDERS.has(provider.id)
  const isOAuthSession = isOAuthProvider && provider.hasAuth && provider.authSource === 'oauth'
  const canManageKey = isApiKeyProvider && provider.hasAuth && provider.authSource !== undefined && MANAGED_KEY_SOURCES.includes(provider.authSource)
  // A key can be added on top of a CLI subscription: the engine then prefers
  // the key, and removing it falls back to the CLI.
  const isCliAuthed = isApiKeyProvider && provider.hasAuth && provider.authSource !== undefined && CLI_AUTH_SOURCES.includes(provider.authSource)
  const showApiKeyInput = isApiKeyProvider && (!provider.hasAuth || editing)
  // A ChatGPT token stored as an OpenAI API key returns no models and, since
  // a key wins routing, captures it. The fix is to remove it and sign in.
  const showPoisonedHint = provider.id === 'openai' && provider.hasAuth
    && provider.authSource === 'filestore' && provider.backend !== 'codex' && modelCount === 0

  const handleSave = async (): Promise<void> => {
    if (!apiKey.trim()) return
    setSaving(true); setError(null)
    try {
      const result = await onEnv(() => host.shell.storeCredential(provider.id, apiKey.trim()))
      if (result.ok) { setSaved(true); setApiKey(''); setEditing(false); setTimeout(() => setSaved(false), 2000); onCredentialSaved() }
      else setError(result.error || 'Failed to save')
    } catch (err) { setError(describeProviderActionError(err, environmentId)) }
    finally { setSaving(false) }
  }
  const save = (): void => { void handleSave().catch((err: unknown) => rError('settings', 'save key failed', { error: String(err) })) }

  const handleRemoveKey = async (): Promise<void> => {
    setError(null)
    try {
      const result = await onEnv(() => host.shell.storeCredential(provider.id, ''))
      if (result.ok) onCredentialSaved()
      else setError(result.error || 'Failed to remove')
    } catch (err) { setError(describeProviderActionError(err, environmentId)) }
  }

  const handleOAuthLogin = async (): Promise<void> => {
    setOauthLoading(true); setError(null); setDeviceCode(null)
    try {
      if (provider.id === 'github-copilot') {
        const dc = await onEnv(() => host.shell.oauthDeviceCode(provider.id))
        if (!dc.ok) { setError(dc.error || 'Failed to start'); setOauthLoading(false); return }
        setDeviceCode({ userCode: dc.userCode!, verificationUri: dc.verificationUri!, deviceCode: dc.deviceCode!, interval: dc.interval!, expiresIn: dc.expiresIn! })
        void host.openExternal(dc.verificationUri!).catch((err: unknown) => rWarn('settings', 'open verification uri failed', { error: String(err) }))
        const poll = await onEnv(() => host.shell.oauthDevicePoll(dc.deviceCode!, dc.interval!, dc.expiresIn!))
        if (poll.ok) onCredentialSaved(); else setError(poll.error || 'Device flow failed')
        setDeviceCode(null)
      } else {
        const result = await onEnv(() => host.shell.startOAuth(provider.id))
        if (result.ok) onCredentialSaved(); else setError(result.error || 'OAuth failed')
      }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setOauthLoading(false) }
  }

  const handleOAuthLogout = async (): Promise<void> => {
    setError(null)
    try { await onEnv(() => host.shell.logoutOAuth(provider.id)); onCredentialSaved() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  const handleRefreshModels = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await onEnv(() => host.shell.refreshModels(provider.id))
      setTimeout(() => { onCredentialSaved(); setRefreshing(false) }, 2500)
    } catch (err) { rWarn('settings', 'refresh models failed', { environment_id: environmentId, error: String(err) }); setRefreshing(false) }
  }

  const copyDeviceCode = (code: string): void => {
    void navigator.clipboard.writeText(code).catch((err: unknown) => rWarn('settings', 'copy device code failed', { error: String(err) }))
  }

  return (
    <SidePanel open title={name} subtitle={hasCustomGateway ? 'Custom gateway: requests go to this endpoint instead of the public API.' : undefined} onClose={onClose}>
      <Stack gap={16}>
        <FormGroup title="Status">
          <FormRow label="Sign-in" description={provider.hasAuth ? authSourceTooltip(provider.authSource) : 'No credential on this server yet.'}>
            <Chip tone={provider.hasAuth ? 'ok' : 'muted'}>{providerAuthBadge(provider)}</Chip>
          </FormRow>
          {hasCustomGateway && <FormRow label="Gateway" description={<MonoLine>{provider.baseURL!}</MonoLine>}><Chip tone="warn">custom gateway</Chip></FormRow>}
          {provider.apiKeyRef && provider.apiKeyRef !== 'configured' && (
            <FormRow label="Key reference" description="API key reference from engine configuration."><Muted mono>{provider.apiKeyRef}</Muted></FormRow>
          )}
          {provider.hasAuth && (
            <FormRow label="Models" description={`${modelCount} ${modelCount === 1 ? 'model' : 'models'} on this server.`}>
              <Button icon={ArrowClockwise} disabled={refreshing} tooltip="Re-fetch available models" onClick={() => { void handleRefreshModels().catch((err: unknown) => rWarn('settings', 'refresh models failed', { error: String(err) })) }}>
                {refreshing ? 'Refreshing…' : 'Refresh models'}
              </Button>
            </FormRow>
          )}
        </FormGroup>

        {showPoisonedHint && <Notice tone="warn">This stored OpenAI credential isn’t returning models. Remove it and sign in with ChatGPT below instead.</Notice>}

        {isOAuthProvider && (
          <FormGroup title="Sign in">
            {isOAuthSession ? (
              <FormRow label="Browser sign-in" description="Signed in through the browser.">
                <Button onClick={() => { void handleOAuthLogout().catch((err: unknown) => rError('settings', 'oauth logout failed', { error: String(err) })) }}>Sign out</Button>
              </FormRow>
            ) : deviceCode ? (
              <FormRow label="Enter this code on GitHub" description="Waiting for authorization…">
                <TextInput mono readOnly width={120} value={deviceCode.userCode} aria-label="GitHub device code" />
                <Button icon={Copy} onClick={() => copyDeviceCode(deviceCode.userCode)}>Copy</Button>
              </FormRow>
            ) : !provider.hasAuth ? (
              <FormRow label="Browser sign-in" description={oauthLoading ? 'Waiting for browser…' : 'Opens the provider’s sign-in page.'}>
                <Button variant="primary" disabled={oauthLoading} onClick={() => { void handleOAuthLogin().catch((err: unknown) => rError('settings', 'oauth login failed', { error: String(err) })) }}>
                  {OAUTH_BUTTON_LABELS[provider.id] || 'Sign in'}
                </Button>
              </FormRow>
            ) : (
              <FormRow label="Browser sign-in" description="Signed in another way." />
            )}
          </FormGroup>
        )}

        <ProviderCliSignIn provider={provider} environmentId={environmentId} />

        {isApiKeyProvider && (
          <FormGroup title="API key">
            {showApiKeyInput ? (
              <FormRow label={editing ? (isCliAuthed ? 'Add an API key' : 'Replace the API key') : 'API key'} description={isCliAuthed ? 'The engine prefers the key for API routing; removing it reverts to the CLI subscription.' : undefined} stacked>
                <Wide>
                <Inline>
                  <TextInput
                    type="password"
                    aria-label={`${name} API key`}
                    placeholder={editing ? 'New API key' : `${name} API key`}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') save() }}
                  />
                  <Button variant="primary" disabled={saving || !apiKey.trim()} onClick={save}>{saving ? 'Saving…' : saved ? 'Saved' : 'Save'}</Button>
                  {editing && <Button onClick={() => { setEditing(false); setApiKey('') }}>Cancel</Button>}
                </Inline>
                </Wide>
              </FormRow>
            ) : canManageKey ? (
              <FormRow label="API key" description={authSourceTooltip(provider.authSource)}>
                <Button onClick={() => setEditing(true)}>Change</Button>
                <Button
                  variant="danger"
                  tooltip={provider.authSource === 'filestore' ? 'Remove saved API key' : 'Clear override and revert to the underlying credential source'}
                  onClick={() => { void handleRemoveKey().catch((err: unknown) => rError('settings', 'remove key failed', { error: String(err) })) }}
                >
                  {provider.authSource === 'filestore' ? 'Remove' : 'Reset'}
                </Button>
              </FormRow>
            ) : isCliAuthed ? (
              <FormRow label="API key" description="None. The CLI sign-in serves this provider.">
                <Button tooltip="Add an API key on top of the CLI sign-in. The engine prefers the key for API routing; removing it reverts to the CLI subscription." onClick={() => setEditing(true)}>Add API key</Button>
              </FormRow>
            ) : (
              <FormRow label="API key" description={authSourceTooltip(provider.authSource)} />
            )}
          </FormGroup>
        )}

        <ErrorText>{error}</ErrorText>
      </Stack>
    </SidePanel>
  )
}
