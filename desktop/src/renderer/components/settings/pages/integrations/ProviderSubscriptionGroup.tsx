/**
 * ProviderSubscriptionGroup — the provider key the picked server's engine
 * looked up for its signed-in identity. The engine owns the lookup, the
 * selection memory, and the key; this group shows the state and offers the
 * two actions: choose one of the offered subscriptions, and look up again.
 *
 * It reads the state on mount and follows `ion:provider-subscription-changed`,
 * a complete snapshot sent on every change from any client. A snapshot
 * REPLACES the view. Nothing renders when no lookup is configured.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { ArrowClockwise, Check } from '@phosphor-icons/react'
import type { ProviderSubscriptionStatus } from '@ion/shared/types-engine-event'
import type { ProviderSubscriptionResult } from '@ion/shared/provider-subscription'
import { useSettingsShell } from '../../settings-shell'
import { Button, FormGroup, FormRow, Inline, Select } from '../../kit'
import { rError, rInfo, rWarn } from '../../../../rendererLogger'

/** The provider the key configures, as the model picker names it. */
export function providerName(status: ProviderSubscriptionStatus): string {
  return status.providerDisplayName || status.provider || 'Provider'
}

/** What the row says for each state. The row's label names the provider. */
function describeState(status: ProviderSubscriptionStatus): string {
  switch (status.state) {
    case 'awaiting_identity':
      return 'Sign in above to look up your subscription key.'
    case 'resolving':
      return 'Looking up your subscription…'
    case 'applied':
      return `Using ${status.selected?.label ?? 'your subscription'}.`
    case 'selection_required':
      return 'Your account has several subscriptions. Choose the one to use.'
    case 'none':
      return 'Your account has no subscription. Contact your administrator for access.'
    case 'failed':
      return 'The subscription lookup failed. Any key entered by hand is still in use.'
    case 'disabled':
      return ''
  }
}

export function ProviderSubscriptionGroup(): React.JSX.Element | null {
  const { shell, on, environmentId } = useSettingsShell()
  const [status, setStatus] = useState<ProviderSubscriptionStatus | null>(null)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const apply = useCallback((next: ProviderSubscriptionStatus) => {
    setStatus(next)
    setChoice((current) => {
      const offered = next.options ?? []
      if (offered.some((o) => o.id === current)) return current
      return next.selected?.id ?? offered[0]?.id ?? ''
    })
  }, [])

  useEffect(() => {
    shell.providerSubscription()
      .then((result) => apply(result.subscription))
      .catch((err: unknown) => rWarn('settings', 'provider subscription read failed', { environment_id: environmentId, error: String(err) }))
  }, [shell, environmentId, apply])

  useEffect(() => {
    return on('ion:provider-subscription-changed', (payload) => {
      if (!payload || typeof payload !== 'object') return
      const snapshot = payload as ProviderSubscriptionStatus
      rInfo('settings', 'provider subscription snapshot received', { environment_id: environmentId, state: snapshot.state })
      apply(snapshot)
    })
  }, [on, environmentId, apply])

  const run = useCallback(async (label: string, action: () => Promise<ProviderSubscriptionResult>) => {
    setBusy(true)
    setActionError(null)
    try {
      const result = await action()
      apply(result.subscription)
      if (!result.ok) {
        rWarn('settings', 'provider subscription action refused', { environment_id: environmentId, action: label, error: result.error ?? '' })
        setActionError(result.error ?? `Could not ${label} the subscription`)
      } else {
        rInfo('settings', 'provider subscription action settled', { environment_id: environmentId, action: label, state: result.subscription.state })
      }
    } catch (err) {
      rError('settings', 'provider subscription action failed', { environment_id: environmentId, action: label, error: String(err) })
      setActionError(err instanceof Error ? err.message : `Could not ${label} the subscription`)
    } finally {
      setBusy(false)
    }
  }, [environmentId, apply])

  if (!status || status.state === 'disabled') return null

  const options = status.options ?? []
  const canChoose = options.length > 1 && (status.state === 'applied' || status.state === 'selection_required')
  const canLookUp = status.state !== 'awaiting_identity' && status.state !== 'resolving'
  const warning = actionError ?? (status.error && status.state !== 'none' ? status.error : undefined)

  return (
    <FormGroup title="Provider subscription" anchor="provider-subscription">
      <FormRow label={`${providerName(status)} subscription`} description={describeState(status)} warning={warning}>
        <Inline>
          {canChoose && (
            <Select aria-label="Subscription" width={200} value={choice} disabled={busy} onChange={(e) => setChoice(e.target.value)}>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </Select>
          )}
          {canChoose && (
            <Button
              variant="primary"
              icon={Check}
              disabled={busy || choice === '' || choice === status.selected?.id}
              onClick={() => { void run('select', () => shell.selectProviderSubscription({ id: choice })) }}
            >Use subscription</Button>
          )}
          {canLookUp && (
            <Button icon={ArrowClockwise} disabled={busy} onClick={() => { void run('refresh', () => shell.refreshProviderSubscription()) }}>Look up again</Button>
          )}
        </Inline>
      </FormRow>
    </FormGroup>
  )
}
