/**
 * InboxSection — when a conversation settles off the Inbox on its own.
 *
 * Auto-settle files idle conversations away, so it never comes as a
 * surprise: a change that could settle conversations now (turning it on, or
 * shortening the window) first asks the server what the next sweep would
 * settle (`inbox.previewAutoSettle`), and the person confirms the number in
 * a side panel. See auto-settle-change.ts for the rule. With no preview,
 * nothing changes.
 */
import React, { useCallback, useState } from 'react'
import { action } from '../../../../host/host-instance'
import { rInfo, rWarn } from '../../../../rendererLogger'
import { useSettingsPreferences, useSettingsTargetEnvironmentId } from '../../settings-target'
import { autoSettleChangeCanSettle, isAutoSettlePreview, type AutoSettlePreview } from '../../auto-settle-change'
import { Button, FormGroup, FormRow, Muted, NumberInput, SidePanel, ToggleRow } from '../../kit'

export function InboxSection(): React.JSX.Element {
  const days = useSettingsPreferences((s) => s.inboxAutoSettleDays)
  const setDays = useSettingsPreferences((s) => s.setInboxAutoSettleDays)
  const onMerge = useSettingsPreferences((s) => s.inboxAutoSettleOnMerge)
  const setOnMerge = useSettingsPreferences((s) => s.setInboxAutoSettleOnMerge)
  // The sweep it previews runs on the server Settings is editing.
  const environmentId = useSettingsTargetEnvironmentId()
  const [pending, setPending] = useState<{ days: number; preview: AutoSettlePreview } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const request = useCallback((next: number) => {
    setError(null)
    if (!autoSettleChangeCanSettle(days, next)) {
      setPending(null)
      setDays(next)
      return
    }
    action(environmentId, 'inbox.previewAutoSettle', [{ days: next }])
      .then((value) => {
        if (!isAutoSettlePreview(value)) throw new Error('the server returned an unreadable preview')
        if (value.count === 0) {
          rInfo('settings.auto-settle', 'change settles nothing now; applied', { days: next })
          setPending(null)
          setDays(next)
          return
        }
        rInfo('settings.auto-settle', 'change would settle conversations; asking first', { days: next, count: value.count })
        setPending({ days: next, preview: value })
      })
      .catch((err: unknown) => {
        // No preview, no change: applying it blind is the surprise this exists to prevent.
        rWarn('settings.auto-settle', 'preview failed; change not applied', { days: next, error: String(err) })
        setError('Could not check what this would settle, so nothing was changed.')
      })
  }, [days, setDays, environmentId])

  const cancel = (): void => {
    if (pending) rInfo('settings.auto-settle', 'cancelled', { days: pending.days })
    setPending(null)
  }
  const shown = pending?.days ?? days
  const hidden = pending ? pending.preview.count - pending.preview.titles.length : 0

  return (
    <>
      <FormGroup title="Inbox" anchor="auto-settle">
        <ToggleRow
          label="Auto-settle inactive conversations"
          description="Files fully idle conversations into Settled after the chosen number of days. Pending plans, questions, permission requests, and background work never auto-settle. Applies to the whole server."
          checked={shown > 0}
          onChange={(enabled) => request(enabled ? 3 : 0)}
          warning={error ?? undefined}
        />
        {shown > 0 && (
          <FormRow label="Days of inactivity" description="How long a conversation stays idle before it settles.">
            <NumberInput label="Days of inactivity before auto-settle" value={shown} min={1} max={90} onChange={request} />
          </FormRow>
        )}
        <ToggleRow
          label="Auto-settle merged pull requests"
          description="Move conversations with merged pull requests to Settled."
          checked={onMerge}
          onChange={setOnMerge}
        />
      </FormGroup>
      <SidePanel
        open={pending !== null}
        title="Confirm auto-settle"
        subtitle={pending ? `This will settle ${pending.preview.count} conversation${pending.preview.count === 1 ? '' : 's'} right away.` : undefined}
        onClose={cancel}
        footer={<>
          <Button onClick={cancel}>Cancel</Button>
          <Button variant="primary" onClick={() => {
            if (!pending) return
            rInfo('settings.auto-settle', 'confirmed', { days: pending.days, count: pending.preview.count })
            setDays(pending.days)
            setPending(null)
          }}>Settle them and turn this on</Button>
        </>}
      >
        {pending && (
          <ul aria-label="Conversations that would settle" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {pending.preview.titles.map((title, index) => <li key={`${index}-${title}`}><Muted>{title}</Muted></li>)}
            {hidden > 0 && <li><Muted>and {hidden} more</Muted></li>}
          </ul>
        )}
      </SidePanel>
    </>
  )
}
