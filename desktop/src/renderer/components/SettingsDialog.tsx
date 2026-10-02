/**
 * SettingsDialog — the Settings window: a sidebar of pages, the page on
 * screen, and the side panel a page opens for an add, edit, or test flow.
 *
 * The sidebar decides which server a server page is about. Moving to a
 * server's page points the settings target (`settings-target`) at it; moving
 * to a device or personal page points it back at the local server. Closing
 * the dialog always leaves the target on the local server.
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X, CornersOut, CornersIn } from '@phosphor-icons/react'
import { LOCAL_ENVIRONMENT_ID, type EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { zoomDelta } from '../viewport-zoom'
import { usePreferencesStore } from '../preferences'
import { host } from '../host/host-instance'
import { policyStore } from '../studio/connection/policy-store'
import { rInfo } from '../rendererLogger'
import { IconButton, Notice, SidePanelHostProvider } from './settings/kit'
import {
  SETTINGS_PAGES, SERVERS_PAGE, SERVERS_PAGE_ID, SETTINGS_SCOPE_HEADINGS, resolveSettingsTab, visiblePages, visibleSections,
  type SectionFilter, type SettingsLocation, type SettingsPage, type SettingsPageScope,
} from './settings/settings-catalog'
import { SettingsSidebar } from './settings/SettingsSidebar'
import { SettingsPageView } from './settings/SettingsPageView'
import { SettingsSearchResults } from './settings/SettingsSearchResults'
import { searchSettings, type SettingsSearchHit } from './settings/settings-search-index'
import { clearSettingsTargetNotice, setSettingsTarget, useSettingsTargetNotice } from './settings/settings-target'
import { clearSettingsPolicyNotice, useSettingsPolicyNotice } from '../settings-policy'
import { SettingsEnvironmentProvider, SettingsServersProvider, useDefaultEnvironmentId, useSettingsServersState } from './settings/settings-servers'
import { SettingsNavProvider } from './settings/settings-nav'
import {
  maximizedSettingsDialogGeometry, resizeSettingsDialog, resolveSettingsDialogGeometry, resolveSettingsDialogLayout, type SettingsDialogGeometry,
} from './settings/settings-dialog-geometry'

const TRANSITION = { duration: 0.22, ease: [0.4, 0, 0.1, 1] as const }
const SIDEBAR_WIDTH = 212

interface SettingsDialogProps {
  onClose: () => void
  initialTab?: string | null
}

type Drag = { kind: 'move' | 'resize'; startX: number; startY: number; origin: SettingsDialogGeometry }

export function SettingsDialog({ onClose, initialTab }: SettingsDialogProps) {
  const colors = useColors()
  const uiZoom = usePreferencesStore((s) => s.uiZoom)
  const popoverLayer = usePopoverLayer()
  const searchRef = useRef<HTMLInputElement>(null)
  const servers = useSettingsServersState()
  const capabilities = useMemo(() => host.capabilities(), [])
  const canManageServers = capabilities.includes('local')

  // Policy can hide groups after the dialog opened (it arrives on studio_welcome).
  const [policyVersion, setPolicyVersion] = useState(0)
  useEffect(() => policyStore.subscribe(() => setPolicyVersion((v) => v + 1)), [])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- policyVersion is the trigger; the groups are read fresh
  const hiddenGroups = useMemo(() => policyStore.deviceHiddenGroups(), [policyVersion])
  const filter = useMemo((): SectionFilter => ({ hiddenGroups, capabilities }), [hiddenGroups, capabilities])
  const pagesFor = useCallback((scope: Exclude<SettingsPageScope, 'server'>) => visiblePages(SETTINGS_PAGES, scope, filter), [filter])
  const serverPages = useMemo(() => visiblePages(SETTINGS_PAGES, 'server', filter), [filter])

  // Opens on the server of the conversation on screen: the one whose settings
  // the person is looking at the effects of.
  const defaultEnvironmentId = useDefaultEnvironmentId()
  const [location, setLocation] = useState<SettingsLocation>(() => resolveSettingsTab(initialTab, defaultEnvironmentId))
  const [expandedServerId, setExpandedServerId] = useState<string | null>(() => location.environmentId ?? defaultEnvironmentId)
  const [query, setQuery] = useState('')

  const navigate = useCallback((next: SettingsLocation) => {
    rInfo('settings.nav', 'settings page opened', { page: next.pageId, environment_id: next.environmentId ?? '', anchor: next.anchor ?? '' })
    setLocation(next)
    setQuery('')
    if (next.environmentId) setExpandedServerId(next.environmentId)
  }, [])

  useEffect(() => { setSettingsTarget(location.environmentId ?? LOCAL_ENVIRONMENT_ID) }, [location.environmentId])
  useEffect(() => () => setSettingsTarget(LOCAL_ENVIRONMENT_ID), [])

  // Resolve what is on screen. A location that policy, capability, or a
  // forgotten server made invalid falls back to the first page shown.
  const entry = location.environmentId ? servers.entries.find((e) => e.id === location.environmentId) : undefined
  const resolved = useMemo((): { page: SettingsPage; entry?: EnvironmentCatalogEntry } | null => {
    if (location.pageId === SERVERS_PAGE_ID) {
      return visibleSections(SERVERS_PAGE, filter).length > 0 ? { page: SERVERS_PAGE } : null
    }
    const page = SETTINGS_PAGES.find((p) => p.id === location.pageId)
    if (!page) return null
    if (page.scope !== 'server') return visibleSections(page, filter).length > 0 ? { page } : null
    if (!entry) return null
    return visibleSections(page, filter).length > 0 ? { page, entry } : null
  }, [location.pageId, entry, filter])
  const catalogLoaded = servers.entries.length > 0
  useEffect(() => {
    if (resolved || (location.environmentId && !catalogLoaded)) return
    const first = SETTINGS_SCOPE_HEADINGS.flatMap((h) => (h.scope === 'server' ? [] : pagesFor(h.scope)))[0]
    if (first) setLocation({ pageId: first.id, environmentId: null, anchor: null })
  }, [resolved, location.environmentId, catalogLoaded, pagesFor])

  // Search covers device and personal pages, and the pages of the server in view.
  const searchServer = entry ?? servers.entries.find((e) => e.id === expandedServerId) ?? servers.entries[0]
  const hits = useMemo((): SettingsSearchHit[] => {
    if (!query.trim()) return []
    const pages = [...SETTINGS_PAGES.filter((p) => p.scope !== 'server'), ...(canManageServers ? [SERVERS_PAGE] : []), ...(searchServer ? SETTINGS_PAGES.filter((p) => p.scope === 'server') : [])]
    return searchSettings(query, pages, (page) => visibleSections(page, filter))
  }, [query, filter, searchServer, canManageServers])

  const targetNotice = useSettingsTargetNotice()
  const policyNotice = useSettingsPolicyNotice()

  // ── geometry: drag, corner resize, maximize ──────────────────────────
  const [geometry, setGeometry] = useState(resolveSettingsDialogGeometry)
  const [maximized, setMaximized] = useState(false)
  const drag = useRef<Drag | null>(null)
  const compact = resolveSettingsDialogLayout(geometry.width) === 'compact'
  useEffect(() => {
    const refit = () => setGeometry(maximized ? maximizedSettingsDialogGeometry() : resolveSettingsDialogGeometry())
    refit()
    window.addEventListener('resize', refit)
    return () => window.removeEventListener('resize', refit)
  }, [uiZoom, maximized])
  const startDrag = (kind: Drag['kind']) => (e: React.MouseEvent) => {
    if (e.button !== 0 || (kind === 'move' && maximized)) return
    e.preventDefault()
    drag.current = { kind, startX: e.clientX, startY: e.clientY, origin: geometry }
  }
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current
      if (!d) return
      const delta = zoomDelta({ x: e.clientX - d.startX, y: e.clientY - d.startY })
      if (d.kind === 'resize') { setMaximized(false); setGeometry(resizeSettingsDialog(d.origin, delta)); return }
      setGeometry({ ...d.origin, x: Math.max(-200, d.origin.x + delta.x), y: Math.max(0, d.origin.y + delta.y) })
    }
    const onUp = () => { drag.current = null }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); searchRef.current?.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const [panelHost, setPanelHost] = useState<HTMLDivElement | null>(null)
  if (!popoverLayer) return null

  const content = query.trim() ? (
    <SettingsSearchResults
      query={query}
      hits={hits}
      serverLabel={searchServer?.label ?? ''}
      onPick={(hit) => navigate({
        pageId: hit.page.id,
        environmentId: hit.page.scope === 'server' && hit.page.id !== SERVERS_PAGE_ID ? (searchServer?.id ?? LOCAL_ENVIRONMENT_ID) : null,
        anchor: hit.item.id,
      })}
    />
  ) : resolved ? (
    <SettingsPageView
      // A page binds to one server's preference store for its whole life.
      key={`${resolved.page.id}:${resolved.entry?.id ?? ''}`}
      page={resolved.page}
      sections={visibleSections(resolved.page, filter)}
      environment={resolved.entry}
      anchor={location.anchor}
    />
  ) : null

  return createPortal(
    <motion.div
      data-ion-ui
      role="dialog"
      aria-label="Settings"
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={TRANSITION}
      className="glass-surface"
      style={{
        // viewport-ok: draggable, resizable dialog, centred on open from the live window size.
        position: 'fixed', left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height,
        borderRadius: maximized ? 12 : 16, display: 'flex', flexDirection: 'column', overflow: 'hidden', pointerEvents: 'auto', zIndex: 9999,
      }}
    >
      <div onMouseDown={startDrag('move')} onDoubleClick={() => setMaximized((m) => !m)} style={{ display: 'flex', alignItems: 'center', gap: 4, height: 40, padding: '0 8px 0 16px', flexShrink: 0, cursor: maximized ? 'default' : 'grab', userSelect: 'none', borderBottom: `1px solid ${colors.containerBorder}` }}>
        <span style={{ flex: 1, color: colors.textPrimary, fontSize: 13, fontWeight: 600 }}>Settings</span>
        <div onMouseDown={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 2 }}>
          <IconButton icon={maximized ? CornersIn : CornersOut} label={maximized ? 'Restore size' : 'Fill window'} onClick={() => setMaximized((m) => !m)} />
          <IconButton icon={X} label="Close settings" onClick={onClose} />
        </div>
      </div>

      <SettingsServersProvider value={servers}>
        <SettingsNavProvider value={{ location, navigate }}>
          <div style={{ display: 'flex', flexDirection: compact ? 'column' : 'row', flex: 1, minHeight: 0 }}>
            <div style={{ width: compact ? '100%' : SIDEBAR_WIDTH, flexShrink: 0, boxSizing: 'border-box', paddingTop: 10, borderRight: compact ? 'none' : `1px solid ${colors.containerBorder}`, borderBottom: compact ? `1px solid ${colors.containerBorder}` : 'none', maxHeight: compact ? 220 : undefined }}>
              <SettingsSidebar
                ref={searchRef}
                query={query}
                onQuery={setQuery}
                pagesFor={pagesFor}
                serverPages={serverPages}
                servers={servers.entries}
                canManageServers={canManageServers}
                expandedServerId={expandedServerId}
                onExpandServer={setExpandedServerId}
                location={location}
                onNavigate={navigate}
              />
            </div>
            <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0 }}>
              <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', overflowX: 'hidden', padding: compact ? '14px 14px 24px' : '18px 24px 32px' }}>
                {targetNotice && (
                  <div style={{ marginBottom: 12, maxWidth: 760 }}>
                    <Notice tone="warn" action={<IconButton icon={X} label="Dismiss" onClick={clearSettingsTargetNotice} />}>{targetNotice}</Notice>
                  </div>
                )}
                {policyNotice && (
                  <div style={{ marginBottom: 12, maxWidth: 760 }}>
                    <Notice tone="warn" action={<IconButton icon={X} label="Dismiss" onClick={clearSettingsPolicyNotice} />}>{policyNotice}</Notice>
                  </div>
                )}
                <SidePanelHostProvider host={panelHost}>
                  {resolved?.entry && !query.trim()
                    ? <SettingsEnvironmentProvider entry={resolved.entry}>{content}</SettingsEnvironmentProvider>
                    : content}
                </SidePanelHostProvider>
              </div>
              <div ref={setPanelHost} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }} />
            </div>
          </div>
        </SettingsNavProvider>
      </SettingsServersProvider>

      {!maximized && (
        <div aria-hidden onMouseDown={startDrag('resize')} style={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, cursor: 'nwse-resize', zIndex: 6 }} />
      )}
    </motion.div>,
    popoverLayer,
  )
}
