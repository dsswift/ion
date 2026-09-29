/**
 * NotificationsPage — which resource kinds the global notification tray
 * shows. This never changes subscriptions: the desktop receives every kind,
 * and this is a client-side blocklist (`excludedResourceKinds`).
 * Conversation-scoped resources always stay in their conversation's
 * attachments and are never affected.
 *
 * The list is discovered, not declared: every workspace-scoped kind the
 * engine has delivered this session, plus every kind already hidden (so a
 * quiet hidden kind can still be turned back on). A new extension's kinds
 * appear with no desktop change. Studio's own traffic is never listed: the
 * tray never shows it, so there is nothing to hide.
 */
import React, { useMemo } from 'react'
import { Bell } from '@phosphor-icons/react'
import { isStudioTrafficKind } from '@ion/shared/studio-sdk-contract'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { useSettingsPreferences } from '../settings-target'
import { CellText, DataList, EmptyState, Switch } from '../kit'

export function NotificationsPage(): React.JSX.Element {
  const resources = useSessionStore((s) => s.resources)
  const excludedResourceKinds = useSettingsPreferences((s) => s.excludedResourceKinds)
  const setExcludedResourceKinds = useSettingsPreferences((s) => s.setExcludedResourceKinds)

  const kinds = useMemo(() => {
    const observed = new Set<string>()
    for (const [kind, items] of Object.entries(resources)) {
      if (items.some((item) => !item.conversationId)) observed.add(kind)
    }
    for (const k of excludedResourceKinds) observed.add(k)
    return [...observed].filter((kind) => !isStudioTrafficKind(kind)).sort()
  }, [resources, excludedResourceKinds])
  const excluded = useMemo(() => new Set(excludedResourceKinds), [excludedResourceKinds])

  const setShown = (kind: string, shown: boolean): void => {
    const next = new Set(excludedResourceKinds)
    if (shown) next.delete(kind)
    else next.add(kind)
    setExcludedResourceKinds([...next].sort())
  }

  return (
    <DataList
      label="Notification kinds"
      title="Notification tray"
      description="Turn a kind off to keep it out of the global tray. Conversation resources always stay in their conversation's attachments."
      anchor="notification-kinds"
      items={kinds}
      getKey={(k) => k}
      noun={['kind', 'kinds']}
      filter={(k, q) => k.toLowerCase().includes(q)}
      showHeader
      columns={[
        { id: 'kind', header: 'Kind', render: (k) => <CellText mono>{k}</CellText> },
        { id: 'shown', header: 'In tray', width: '70px', align: 'end', render: (k) => <Switch label={`Show "${k}" resources in the global notification tray`} checked={!excluded.has(k)} onChange={(shown) => setShown(k, shown)} /> },
      ]}
      empty={(
        <EmptyState
          icon={Bell}
          title="No notification kinds yet"
          detail="When an extension publishes a workspace-level resource, its kind appears here so you can choose whether it shows in the global tray."
        />
      )}
    />
  )
}
