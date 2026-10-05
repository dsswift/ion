/**
 * SettingsPageView — one page: its header, a notice when this device may
 * only change its own settings on the server, then each visible section in
 * catalog order. Reveals the row a location asks for once it has rendered.
 */
import React, { useEffect, useRef } from 'react'
import { canManageEnvironment, useEnvironmentSettingsStore } from '../../studio/state/environment-settings-store'
import { Notice, Page, PageHeader, revealSettingsAnchor } from './kit'
import type { SettingsPage, SettingsSection } from './settings-catalog'

export interface SettingsPageViewProps {
  page: SettingsPage
  sections: readonly SettingsSection[]
  /** The server a server page is about. */
  environment?: { id: string; label: string }
  anchor: string | null
}

/** A section's data often arrives after mount; look for the row a few times before giving up. */
const REVEAL_ATTEMPTS_MS = [0, 120, 400, 1000]

export function SettingsPageView({ page, sections, environment, anchor }: SettingsPageViewProps): React.JSX.Element {
  const root = useRef<HTMLDivElement | null>(null)
  const environmentId = environment?.id ?? null
  const known = useEnvironmentSettingsStore((s) => environmentId !== null && environmentId in s.byEnvironment)
  const canManage = useEnvironmentSettingsStore((s) => environmentId === null || canManageEnvironment(s, environmentId))

  useEffect(() => {
    if (!anchor) return
    let done = false
    const timers = REVEAL_ATTEMPTS_MS.map((ms) => setTimeout(() => { if (!done) done = revealSettingsAnchor(root.current, anchor) }, ms))
    return () => { for (const t of timers) clearTimeout(t) }
  }, [anchor, page.id])

  return (
    <div ref={root}>
      <Page wide={page.wide}>
        <div>
          <PageHeader title={page.label} description={environment ? (page.description ? `${environment.label} · ${page.description}` : environment.label) : page.description} />
          {environment && known && !canManage && (
            <Notice>You can change what is yours on {environment.label}. Server-wide settings need a device with admin access there.</Notice>
          )}
        </div>
        {sections.map((section) => {
          const Body = section.component
          return <div key={section.id} data-settings-anchor={section.id}><Body /></div>
        })}
      </Page>
    </div>
  )
}
