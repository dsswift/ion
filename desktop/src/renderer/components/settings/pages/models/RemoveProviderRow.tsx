/**
 * RemoveProviderRow — removes a custom provider from one server: the server
 * deletes its config entry, its stored key, and its models. Asks once before
 * it does, since the provider's settings are gone for good. The server
 * refuses while its default model or a model tier still uses the provider,
 * and that refusal shows here as written.
 */
import React, { useState } from 'react'
import { Trash } from '@phosphor-icons/react'
import type { ProviderEntry } from '@ion/shared/types-models'
import { withTargetEnvironment } from '../../../../studio/connection/tab-environment'
import { host } from '../../../../host/host-instance'
import { rInfo, rWarn } from '../../../../rendererLogger'
import { Button, ErrorText, FormRow } from '../../kit'
import { describeProviderActionError } from './provider-action-error'

export function RemoveProviderRow({ provider, name, environmentId, serverLabel, onRemoved }: {
  provider: ProviderEntry
  name: string
  environmentId: string
  serverLabel: string
  onRemoved(): void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const result = await withTargetEnvironment(environmentId, () => host.shell.removeProvider(provider.id))
      if (!result.ok) {
        rWarn('settings', 'remove provider refused', { environment_id: environmentId, provider: provider.id, error: result.error ?? '' })
        setError(result.error || 'Could not remove the provider')
        return
      }
      rInfo('settings', 'provider removed', { environment_id: environmentId, provider: provider.id })
      onRemoved()
    } catch (err) {
      rWarn('settings', 'remove provider failed', { environment_id: environmentId, provider: provider.id, error: String(err) })
      setError(describeProviderActionError(err, environmentId))
    } finally {
      setBusy(false); setConfirming(false)
    }
  }

  return (
    <>
      <FormRow
        label={confirming ? `Remove ${name} from ${serverLabel}?` : `Remove from ${serverLabel}`}
        description={confirming
          ? 'Its gateway, its saved key, and its models go too. Adding it back means setting it up again.'
          : `Deletes ${name} from ${serverLabel}'s configuration.`}
      >
        {confirming ? (
          <>
            <Button variant="danger" disabled={busy} onClick={() => { void remove() }}>{busy ? 'Removing…' : 'Remove provider'}</Button>
            <Button disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        ) : (
          <Button variant="danger" icon={Trash} onClick={() => setConfirming(true)}>Remove provider…</Button>
        )}
      </FormRow>
      <ErrorText>{error}</ErrorText>
    </>
  )
}
