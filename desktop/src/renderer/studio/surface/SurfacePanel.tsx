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

function bodyFor(tab: SurfaceTab, active: boolean, onAgentClick?: (tabId: string, agentName: string) => void): React.JSX.Element | null {
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
      return <ResourceSurface key={tab.id} resourceKind={tab.resourceKind} resourceId={tab.resourceId} />
    case 'runtime-panel': {
      if (!active) return null
      return <div key={tab.id} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><RuntimePanelBody id={tab.id} /></div>
    }
    case 'browser':
      // Mounted-but-hidden once created (session survives tab switches).
      return (
        <div key={tab.id} style={{ display: active ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
          <BrowserSurface tabId={tab.id} instanceId={tab.instanceId} url={tab.url} mode={tab.mode} />
        </div>
      )
    case 'terminal':
      // Mounted-but-hidden: the xterm buffer dies on unmount, and the
      // attach re-fetch would flash. The pty itself is main-owned either way.
      return (
        <div key={tab.id} style={{ display: active ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
          <TerminalSurface instanceId={tab.instanceId} cwd={tab.cwd} />
        </div>
      )
  }
}

export function SurfacePanel({ onAgentClick }: { onAgentClick?: (tabId: string, agentName: string) => void }): React.JSX.Element {
  const colors = useColors()
  const tabs = useSurfaceStore((s) => s.tabs)
  const activeTabId = useSurfaceStore((s) => s.activeTabId)
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
          tabs.map((t) => bodyFor(t, t.id === activeTabId, onAgentClick))
        )}
      </div>
    </div>
  )
}
