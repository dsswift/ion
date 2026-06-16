import React, { useMemo } from 'react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { useSessionStore } from '../../stores/sessionStore'
import { SettingToggle } from './SettingToggle'
import { SettingHeading } from './SettingHeading'

/**
 * Notifications settings — per-kind visibility for the global notification
 * tray.
 *
 * The desktop always subscribes to EVERY resource kind via the engine
 * wildcard; this category does not change subscriptions. It only controls
 * which kinds the global tray renders (a client-side blocklist persisted as
 * `excludedResourceKinds`). Conversation-scoped resources always appear in
 * their conversation's attachments panel and are never affected here.
 *
 * The kind list is dynamic: it is the union of every workspace-scoped kind
 * the engine has actually delivered this session plus any kind already in the
 * blocklist (so a currently-quiet excluded kind still shows a toggle). This
 * means any kind any extension declares appears here automatically — no
 * desktop code change is needed to support a new extension's resources.
 */
export function NotificationsCategory() {
  const colors = useColors()
  const resources = useSessionStore((s) => s.resources)
  const excludedResourceKinds = usePreferencesStore((s) => s.excludedResourceKinds)
  const setExcludedResourceKinds = usePreferencesStore((s) => s.setExcludedResourceKinds)

  // Union of observed workspace-scoped kinds + already-excluded kinds, sorted.
  const kinds = useMemo(() => {
    const observed = new Set<string>()
    for (const [kind, items] of Object.entries(resources)) {
      // A kind is tray-relevant if it has at least one workspace-scoped item.
      if (items.some((item) => !item.conversationId)) observed.add(kind)
    }
    for (const k of excludedResourceKinds) observed.add(k)
    return [...observed].sort()
  }, [resources, excludedResourceKinds])

  const excludedSet = useMemo(() => new Set(excludedResourceKinds), [excludedResourceKinds])

  const setShown = (kind: string, shown: boolean) => {
    const next = new Set(excludedResourceKinds)
    if (shown) {
      next.delete(kind) // shown = not excluded
    } else {
      next.add(kind) // hidden = excluded
    }
    setExcludedResourceKinds([...next].sort())
  }

  return (
    <>
      <SettingHeading first>Notification tray</SettingHeading>

      {kinds.length === 0 ? (
        <p
          style={{
            color: colors.textTertiary,
            fontSize: 12,
            lineHeight: 1.5,
            margin: '4px 0 0',
          }}
        >
          No notification kinds yet. When an extension publishes a
          workspace-level resource, its kind appears here with a toggle so you
          can choose whether it shows in the global tray. Conversation-scoped
          resources always appear in their conversation&apos;s attachments
          panel and are not affected by these toggles.
        </p>
      ) : (
        kinds.map((kind) => (
          <SettingToggle
            key={kind}
            label={kind}
            description={`Show "${kind}" resources in the global notification tray.`}
            checked={!excludedSet.has(kind)}
            onChange={(shown) => setShown(kind, shown)}
          />
        ))
      )}
    </>
  )
}
