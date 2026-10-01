/**
 * DefaultProviderRow — the provider a bare (unqualified) model name resolves
 * to on one server's engine. Seeds from get_default_provider and stays live
 * on the engine's default-provider broadcast: the broadcast is a reload
 * trigger, never a payload merged in.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getProviderDisplayName } from '@ion/shared/types-models'
import { useModelStore, environmentModels } from '@ion/server/store/model-store'
import { withTargetEnvironment } from '../../../../studio/connection/tab-environment'
import { host } from '../../../../host/host-instance'
import { rInfo, rWarn } from '../../../../rendererLogger'
import { FormRow, Muted, Select } from '../../kit'

export function DefaultProviderRow({ environmentId }: { environmentId: string }): React.JSX.Element {
  const providers = useModelStore((state) => environmentModels(state, environmentId).providers)
  const [provider, setProvider] = useState('')
  const [loading, setLoading] = useState(true)
  const readingRef = useRef(false)
  const authedProviders = useMemo(() => providers.filter((entry) => entry.hasAuth), [providers])

  const load = useCallback(async () => {
    if (readingRef.current) return
    readingRef.current = true
    try {
      const next = await withTargetEnvironment(environmentId, () => host.shell.getDefaultProvider())
      setProvider(next)
      rInfo('default-provider', 'default provider snapshot loaded', { provider: next, configured: next !== '' })
    } catch (err) {
      rWarn('default-provider', 'default provider snapshot load failed', { error: String(err) })
    } finally {
      readingRef.current = false
      setLoading(false)
    }
  }, [environmentId])

  useEffect(() => {
    void load()
    return host.shell.onDefaultProviderUpdated((_payload, fromEnvironment) => {
      if (fromEnvironment !== undefined && fromEnvironment !== environmentId) return
      // Our own read emits the snapshot it returns; reloading on it would recurse.
      if (!readingRef.current) void load()
    })
  }, [load, environmentId])

  const choose = useCallback((next: string) => {
    const previous = provider
    setProvider(next)
    void withTargetEnvironment(environmentId, () => host.shell.setDefaultProvider(next)).then((result) => {
      if (!result.ok) throw new Error(result.error || 'Could not save the default provider')
      rInfo('default-provider', 'default provider saved', { provider: next, cleared: next === '' })
    }).catch((err: unknown) => {
      setProvider(previous)
      rWarn('default-provider', 'default provider save failed', { environment_id: environmentId, provider: next, error: String(err) })
    })
  }, [provider, environmentId])

  // A saved provider that is not signed in stays selectable: the engine still
  // honours it, and dropping it would misreport the persisted value.
  const options = authedProviders.map((entry) => ({ id: entry.id, label: getProviderDisplayName(entry.id, providers) }))
  if (provider !== '' && !authedProviders.some((entry) => entry.id === provider)) {
    options.push({ id: provider, label: `${getProviderDisplayName(provider, providers)} (unavailable)` })
  }

  return (
    <FormRow
      label="Default provider"
      anchor="default-provider"
      description="Prefer this provider when a model name doesn’t specify one. An explicitly qualified model (e.g. corp-gateway/claude-sonnet-5) always uses its own provider regardless of this setting."
    >
      {loading ? <Muted>Loading…</Muted> : (
        <Select aria-label="Default provider" width={220} value={provider} onChange={(event) => choose(event.target.value)}>
          <option value="">No preference</option>
          {options.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </Select>
      )}
    </FormRow>
  )
}
