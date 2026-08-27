/**
 * SurfacePanel — hosts the surface tab strip and tab bodies.
 *
 * Mount policy: terminal/browser/visualizer bodies stay mounted-but-hidden
 * (xterm buffers, webview sessions, canvas state die on unmount);
 * diff/plan/file/preview bodies may unmount freely (pure views over
 * store/disk state). The visualizer additionally pauses its engine loop
 * while hidden (VisualizerSurface, D10).
 *
 * Diff and Plan bodies land in their own workstreams; until then they
 * render a named placeholder so the singleton tabs are real (store-driven,
 * persisted, ordered) from day one.
 */
import React from 'react'
import { useColors } from '../../theme'
import { useSurfaceStore } from './surface-store'
import { SurfaceTabStrip } from './SurfaceTabStrip'
import { VisualizerSurface } from './tabs/VisualizerSurface'
import { PlanSurface } from './tabs/PlanSurface'
import { FileSurface } from './tabs/FileSurface'
import { DiffSurface } from './tabs/DiffSurface'
import { PreviewSurface } from './tabs/PreviewSurface'
import { TerminalSurface } from './tabs/TerminalSurface'
import { BrowserSurface } from './tabs/BrowserSurface'
import { ResourceSurface } from './tabs/ResourceSurface'
import { StatusSurface } from './tabs/StatusSurface'
import { DispatchSurface } from './tabs/DispatchSurface'
import { QuestionsSurface } from './tabs/QuestionsSurface'
import { RuntimePanelBody } from './runtime-panel-registry'
import { FileExplorer } from '../../components/FileExplorer'
import { GitPanel } from '../../components/GitPanel'
import type { SurfaceTab } from '../../../shared/studio-surface-types'

function PlaceholderBody({ label }: { label: string }): React.JSX.Element {
  const colors = useColors()
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: colors.textTertiary,
        fontSize: 12,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {label}
    </div>
  )
}

function bodyFor(tab: SurfaceTab, active: boolean, conversationTabId: string, onAgentClick?: (tabId: string, agentName: string) => void): React.JSX.Element | null {
  switch (tab.kind) {
    case 'singleton':
      if (tab.id === 'visualizer') return <VisualizerSurface key={tab.id} active={active} onAgentClick={onAgentClick} />
      if (!active) return null
      if (tab.id === 'plan') return <PlanSurface key={tab.id} />
      if (tab.id === 'status') return <StatusSurface key={tab.id} />
      if (tab.id === 'files')
        return (
          <div key={tab.id} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <FileExplorer docked />
          </div>
        )
      if (tab.id === 'gitpanel')
        return (
          <div key={tab.id} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <GitPanel docked />
          </div>
        )
      return <DiffSurface key={tab.id} />
    case 'file':
      if (!active) return null
      return <FileSurface key={tab.id} dir={tab.dir} filePath={tab.filePath} />
    case 'preview':
      if (!active) return null
      return <PreviewSurface key={tab.id} filePath={tab.filePath} dataUrl={tab.dataUrl} />
    case 'notification':
      if (!active) return null
      return <ResourceSurface key={tab.id} resourceKind={tab.resourceKind} resourceId={tab.resourceId} resourceProducer={tab.resourceProducer} />
    case 'questions':
      if (!active) return null
      return <QuestionsSurface key={tab.id} />
    case 'dispatch':
      if (!active) return null
      return <DispatchSurface key={tab.id} tab={tab} />
    case 'runtime-panel': {
      if (!active) return null
      return <div key={tab.id} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><RuntimePanelBody id={tab.id} /></div>
    }
    case 'browser':
      // Browser bodies mount below for every conversation. A browser session
      // must not die just because its conversation is not currently selected.
      return null
    case 'terminal':
      // Mounted-but-hidden: the xterm buffer dies on unmount, and the
      // attach re-fetch would flash. The pty itself is main-owned either way.
      return (
        <div key={tab.id} style={{ display: active ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
          <TerminalSurface tabId={conversationTabId} instanceId={tab.instanceId} cwd={tab.cwd} />
        </div>
      )
  }
}

/**
 * Browser guests for every conversation.
 *
 * Mounted OUTSIDE the Surface column, and deliberately so. The column itself is
 * gated on `showSurface`, so hosting the guests inside it meant a closed panel
 * created no bodies at all — and an agent acting in a background conversation
 * (which must not open the panel) then had no browser to drive, failing with
 * "the browser tab did not finish loading in time".
 *
 * Each body renders a zero-size placeholder unless its conversation and tab are
 * the visible ones, which the renderer reports as hidden, so a guest here runs
 * and loads without ever painting.
 */
export function BrowserBodies({ currentConversationId, activeTabId }: {
  currentConversationId: string | null
  activeTabId: string | null
}): React.JSX.Element {
  const conversations = useSurfaceStore((s) => s.conversations)
  const browserTabs = Object.entries(conversations).flatMap(([conversationId, conversation]) =>
    conversation.tabs
      .filter((tab): tab is Extract<SurfaceTab, { kind: 'browser' }> => tab.kind === 'browser')
      .map((tab) => ({ conversationId, tab })),
  )

  return (
    <>
      {browserTabs.map(({ conversationId, tab }) => (
        <div
          key={tab.id}
          // Every conversation's browser stays mounted, including background
          // ones: that is what lets an agent open and drive a tab in its own
          // conversation without the operator switching to it. `display:none`
          // collapses the placeholder to zero size, which is the signal
          // BrowserSurface reports as "hide this view" — so a background guest
          // keeps running and loading while never painting over the shell.
          style={{
            display: conversationId === currentConversationId && tab.id === activeTabId ? 'flex' : 'none',
            flex: 1,
            minHeight: 0,
          }}
        >
          <BrowserSurface
            conversationId={conversationId}
            tabId={tab.id}
            instanceId={tab.instanceId}
            url={tab.url}
            mode={tab.mode}
            sessionMode={tab.sessionMode}
            emulation={tab.emulation ?? null}
          />
        </div>
      ))}
    </>
  )
}

/**
 * Always-mounted host for the browser guests.
 *
 * Rendered by the Studio shell regardless of whether the Surface column is
 * open. Occupies no layout space: the guests are main-process views positioned
 * over their placeholders, so this contributes nothing visual on its own.
 */
export function StudioBrowserHost(): React.JSX.Element | null {
  const hydrated = useSurfaceStore((s) => s.hydrated)
  const surfaceVisible = useSurfaceStore((s) => s.visible)
  const currentConversationId = useSurfaceStore((s) => s.currentConversationId)
  if (!hydrated) return null
  // When the column is open it renders its OWN BrowserBodies, which is what
  // measures the visible tab. Mounting a second copy then would give two
  // placeholders for one guest and the last one to report would win.
  if (surfaceVisible) return null
  return (
    // Collapsed on purpose: with the column closed no browser tab is on
    // screen, so every guest should be hidden — but still mounted, running,
    // and drivable by its conversation's agent.
    <div style={{ display: 'none' }}>
      <BrowserBodies currentConversationId={currentConversationId} activeTabId={null} />
    </div>
  )
}

export function SurfacePanel({ onAgentClick }: { onAgentClick?: (tabId: string, agentName: string) => void }): React.JSX.Element {
  const colors = useColors()
  const tabs = useSurfaceStore((s) => s.tabs)
  const activeTabId = useSurfaceStore((s) => s.activeTabId)
  const currentConversationId = useSurfaceStore((s) => s.currentConversationId)
  const hydrated = useSurfaceStore((s) => s.hydrated)

  if (!hydrated) {
    return <div style={{ flex: 1, background: colors.containerBg }} />
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SurfaceTabStrip />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {tabs.length === 0 ? (
          <PlaceholderBody label="No surface tabs — add one with +" />
        ) : (
          tabs.map((t) => bodyFor(t, t.id === activeTabId, currentConversationId ?? '', onAgentClick))
        )}
        {/* Owns geometry for the visible browser tab while the column is open;
            StudioBrowserHost keeps guests alive when it is closed. */}
        <BrowserBodies currentConversationId={currentConversationId} activeTabId={activeTabId} />
      </div>
    </div>
  )
}
