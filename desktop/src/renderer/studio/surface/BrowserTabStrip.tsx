/**
 * BrowserTabStrip — the documents inside the Browser slot.
 *
 * A conversation's browser descriptors share ONE pill in the Surface tab bar
 * (see `browserGroup`). This strip sits above the browser body and lists each
 * document, so switching, closing, and opening a document happen here rather
 * than in the outer bar.
 *
 * It reads descriptors and calls store actions only. Nothing here touches an
 * Electron-only verb, which is what lets the web build of Studio show the same
 * strip above its "Not available in the browser" body.
 */
import React, { useState } from 'react'
import { Globe, Plus, Robot } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { Tooltip } from '../../components/git/Tooltip'
import { browserGroup, isBrowserTabId } from '@ion/shared/studio-browser-group'
import type { BrowserTab } from '@ion/shared/studio-surface-types'
import { useSurfaceStore } from './surface-store'
import { SurfaceTabContextMenu } from './SurfaceTabContextMenu'

function DocumentPill({
  document,
  active,
  agentLinked,
  onContextMenu,
  onClose,
}: {
  document: BrowserTab
  active: boolean
  agentLinked: boolean
  onContextMenu: (e: React.MouseEvent) => void
  onClose: () => void
}): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  const activateTab = useSurfaceStore((s) => s.activateTab)
  const label = document.title || document.url || 'New tab'
  return (
    <div
      {...handlers}
      role="tab"
      aria-selected={active}
      onClick={() => activateTab(document.id)}
      onAuxClick={(e) => { if (e.button === 1) onClose() }}
      onContextMenu={onContextMenu}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 6px 2px 8px',
        borderRadius: 5,
        cursor: 'pointer',
        fontSize: 11,
        whiteSpace: 'nowrap',
        maxWidth: 200,
        color: active ? colors.textPrimary : colors.textTertiary,
        background: active ? interactiveBg(colors, { hover: false, pressed: false }, colors.accentLight) : interactiveBg(colors, { hover, pressed }),
        transition: `background ${transitions.base}, color ${transitions.base}`,
        fontWeight: active ? 600 : 400,
        flexShrink: 0,
      }}
    >
      {document.faviconUrl
        ? <img src={document.faviconUrl} alt="" width={12} height={12} style={{ flexShrink: 0 }} />
        : <Globe size={12} />}
      {agentLinked && (
        <Tooltip text="The agent drives this document. Right-click another document to hand it over.">
          <Robot size={11} color={colors.accent} />
        </Tooltip>
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <span
        onClick={(e) => { e.stopPropagation(); onClose() }}
        style={{ color: colors.textTertiary, fontSize: 13, lineHeight: 1, padding: '0 1px' }}
        aria-label={`Close ${label}`}
      >
        ×
      </span>
    </div>
  )
}

export function BrowserTabStrip(): React.JSX.Element | null {
  const colors = useColors()
  const tabs = useSurfaceStore((s) => s.tabs)
  const activeTabId = useSurfaceStore((s) => s.activeTabId)
  const conversation = useSurfaceStore((s) => (s.currentConversationId ? s.conversations[s.currentConversationId] : undefined))
  const activateTab = useSurfaceStore((s) => s.activateTab)
  const closeTab = useSurfaceStore((s) => s.closeTab)
  const openBrowserTab = useSurfaceStore((s) => s.openBrowserTab)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tab: BrowserTab } | null>(null)

  // Only shown while a browser document is on screen: a file or terminal tab
  // has no second strip, and the outer bar's slot is how the operator returns.
  if (!isBrowserTabId(activeTabId)) return null
  const group = browserGroup(tabs, activeTabId, conversation?.activeBrowserInstanceId, conversation?.agentBrowserInstanceId)
  if (group.documents.length === 0) return null

  const closeDocument = (document: BrowserTab): void => {
    // Closing the shown document lands on its neighbour in the strip, as a
    // browser does, rather than on whatever tab happens to follow it in the
    // outer bar (which could be a terminal sitting between two documents).
    if (document.id === activeTabId && group.documents.length > 1) {
      const index = group.documents.findIndex((item) => item.id === document.id)
      const neighbour = group.documents[index + 1] ?? group.documents[index - 1]
      if (neighbour) activateTab(neighbour.id)
    }
    closeTab(document.id)
  }

  return (
    <div
      role="tablist"
      aria-label="Browser documents"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        padding: '3px 6px',
        borderBottom: `1px solid ${colors.containerBorder}`,
        fontFamily: 'system-ui, sans-serif',
        overflowX: 'auto',
        flexShrink: 0,
      }}
    >
      {group.documents.map((document) => (
        <DocumentPill
          key={document.id}
          document={document}
          active={document.id === activeTabId}
          agentLinked={document.instanceId === conversation?.agentBrowserInstanceId}
          onContextMenu={(e) => {
            e.preventDefault()
            setCtxMenu({ x: e.clientX, y: e.clientY, tab: document })
          }}
          onClose={() => closeDocument(document)}
        />
      ))}
      <Tooltip text="New document">
        <button
          onClick={() => openBrowserTab('about:blank', 'browse')}
          style={{ border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center', flexShrink: 0 }}
          aria-label="New browser document"
        >
          <Plus size={12} />
        </button>
      </Tooltip>
      {ctxMenu && <SurfaceTabContextMenu x={ctxMenu.x} y={ctxMenu.y} tab={ctxMenu.tab} onClose={() => setCtxMenu(null)} />}
    </div>
  )
}
