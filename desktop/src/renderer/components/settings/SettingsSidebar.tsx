/**
 * SettingsSidebar — search, then the three headings. Under SERVERS every
 * server this device can reach is a row that opens into that server's pages;
 * picking a page there is how Settings is pointed at a server.
 */
import React, { forwardRef } from 'react'
import { CaretDown, CaretRight, MagnifyingGlass, Plus, X, HardDrives, type Icon } from '@phosphor-icons/react'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { SETTINGS_TAXONOMY_SERVERS_PAGE } from '@ion/shared/settings-taxonomy'
import { useColors } from '../../theme'
import { useInteractiveState } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { KIT, StatusDot, IconButton } from './kit'
import { SERVERS_PAGE_ID, SETTINGS_SCOPE_HEADINGS, type SettingsLocation, type SettingsPage, type SettingsPageScope } from './settings-catalog'
import { phaseStatus, usePhase } from './server-status'

export interface SettingsSidebarProps {
  query: string
  onQuery(query: string): void
  pagesFor(scope: Exclude<SettingsPageScope, 'server'>): SettingsPage[]
  /** The pages every server shows. */
  serverPages: SettingsPage[]
  servers: EnvironmentCatalogEntry[]
  /** Shows the Servers page row and the add button: this host keeps a catalog. */
  canManageServers: boolean
  expandedServerId: string | null
  onExpandServer(id: string | null): void
  location: SettingsLocation
  onNavigate(location: SettingsLocation): void
}

export const SettingsSidebar = forwardRef<HTMLInputElement, SettingsSidebarProps>(function SettingsSidebar(props, searchRef) {
  const { query, onQuery, pagesFor, serverPages, servers, canManageServers, expandedServerId, onExpandServer, location, onNavigate } = props
  const colors = useColors()
  return (
    <nav aria-label="Settings" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ position: 'relative', padding: '0 10px 8px' }}>
        <MagnifyingGlass size={13} style={{ position: 'absolute', left: 18, top: 7, color: colors.textTertiary, pointerEvents: 'none' }} />
        <input
          ref={searchRef}
          aria-label="Search settings"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          placeholder="Search settings"
          style={{ width: '100%', height: 28, boxSizing: 'border-box', padding: '0 24px 0 26px', fontSize: KIT.fontSmall, color: colors.textPrimary, background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, borderRadius: 7, outline: 'none' }}
        />
        {query && (
          <button aria-label="Clear settings search" onClick={() => onQuery('')} style={{ position: 'absolute', right: 15, top: 6, background: 'none', border: 'none', color: colors.textTertiary, cursor: 'pointer', padding: 2, display: 'flex' }}>
            <X size={11} />
          </button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {SETTINGS_SCOPE_HEADINGS.map(({ scope, label }) => {
          if (scope === 'server') {
            return (
              <React.Fragment key={scope}>
                <Heading label={label} action={canManageServers ? <IconButton icon={Plus} label="Add server" onClick={() => onNavigate({ pageId: SERVERS_PAGE_ID, environmentId: null, anchor: 'add-server' })} /> : undefined} />
                {canManageServers && (
                  <NavRow icon={HardDrives} label={SETTINGS_TAXONOMY_SERVERS_PAGE.label} active={location.pageId === SERVERS_PAGE_ID} onClick={() => onNavigate({ pageId: SERVERS_PAGE_ID, environmentId: null, anchor: null })} />
                )}
                {servers.map((entry) => {
                  const pages = serverPages
                  if (pages.length === 0) return null
                  const expanded = expandedServerId === entry.id
                  return (
                    <React.Fragment key={entry.id}>
                      <ServerRow
                        entry={entry}
                        expanded={expanded}
                        onClick={() => {
                          if (expanded && location.environmentId === entry.id) { onExpandServer(null); return }
                          onExpandServer(entry.id)
                          onNavigate({ pageId: pages[0].id, environmentId: entry.id, anchor: null })
                        }}
                      />
                      {expanded && pages.map((page) => (
                        <NavRow
                          key={page.id}
                          icon={page.icon}
                          label={page.label}
                          indent
                          active={location.environmentId === entry.id && location.pageId === page.id}
                          onClick={() => onNavigate({ pageId: page.id, environmentId: entry.id, anchor: null })}
                        />
                      ))}
                    </React.Fragment>
                  )
                })}
              </React.Fragment>
            )
          }
          const pages = pagesFor(scope)
          if (pages.length === 0) return null
          return (
            <React.Fragment key={scope}>
              <Heading label={label} />
              {pages.map((page) => (
                <NavRow key={page.id} icon={page.icon} label={page.label} active={location.environmentId === null && location.pageId === page.id} onClick={() => onNavigate({ pageId: page.id, environmentId: null, anchor: null })} />
              ))}
            </React.Fragment>
          )
        })}
      </div>
    </nav>
  )
})

function Heading({ label, action }: { label: string; action?: React.ReactNode }): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 26, padding: '10px 4px 0 10px' }}>
      <span style={{ flex: 1, fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: colors.textTertiary }}>{label}</span>
      {action}
    </div>
  )
}

function useRowStyle(active: boolean): { style: React.CSSProperties; handlers: ReturnType<typeof useInteractiveState>['handlers'] } {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  return {
    handlers,
    style: {
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 28, padding: '0 8px', boxSizing: 'border-box',
      border: 'none', borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontSize: KIT.font, fontWeight: active ? 600 : 500,
      color: active ? colors.textPrimary : colors.textSecondary,
      background: pressed ? colors.surfacePressed : active ? colors.surfaceSecondary : hover ? colors.surfaceHover : 'transparent',
      transition: `background ${transitions.base}`,
    },
  }
}

function NavRow({ icon: IconComp, label, active, indent, onClick }: { icon: Icon; label: string; active: boolean; indent?: boolean; onClick(): void }): React.JSX.Element {
  const { style, handlers } = useRowStyle(active)
  return (
    <button type="button" aria-current={active ? 'page' : undefined} onClick={onClick} {...handlers} className="ion-focusable" style={{ ...style, paddingLeft: indent ? 28 : 8 }}>
      <IconComp size={15} weight={active ? 'fill' : 'regular'} style={{ flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  )
}

function ServerRow({ entry, expanded, onClick }: { entry: EnvironmentCatalogEntry; expanded: boolean; onClick(): void }): React.JSX.Element {
  const { style, handlers } = useRowStyle(false)
  const status = phaseStatus(entry.id, usePhase(entry.id))
  const Caret = expanded ? CaretDown : CaretRight
  return (
    <button type="button" aria-expanded={expanded} onClick={onClick} {...handlers} className="ion-focusable" style={style}>
      <Caret size={11} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{entry.label}</span>
      <StatusDot tone={status.tone} label={status.label} />
    </button>
  )
}
