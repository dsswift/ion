/**
 * GraphSurface — the `'graph'` singleton body.
 *
 * The tool panels (Encoding, Filters, Forces, Views) float over the stage,
 * anchored under the button that opens them. They used to be siblings in
 * the column below the stage, which shrank the WebGL canvas whenever one
 * opened — and Sigma only re-reads its container size from inside a render,
 * so closing one left the stage frozen at the smaller size with a hard
 * unrendered edge across it. A panel that overlays the stage cannot resize
 * it at all, which removes that failure mode rather than compensating for
 * it.
 *
 * Mount policy follows `VisualizerSurface`: stays mounted while inactive
 * (`display: none`) because WebGL context state dies on unmount, and pauses
 * rather than unmounting. Graph View is enabled by default — the corpus
 * root defaults to the active tab's `workingDirectory`, so `available` is
 * false only when there is no real project directory (no active tab, or the
 * home-directory fallback `'~'`). Renders the no-project notice in that
 * case; `GraphWatchChip` renders the live-updates-off notice.
 */

import React, { useEffect, useMemo, useState } from 'react'
import type Sigma from 'sigma'
import { useColors } from '../../theme'
import { useSessionStore } from '../../stores/sessionStore'
import { GraphCanvas } from './GraphCanvas'
import { GraphBindingPanel } from './GraphBindingPanel'
import { GraphLegend } from './GraphLegend'
import { GraphInspector } from './GraphInspector'
import { GraphQuickPeek } from './GraphQuickPeek'
import { GraphIssueBadges } from './GraphIssueBadges'
import { GraphWatchChip } from './GraphWatchChip'
import { GraphMinimap } from './minimap/GraphMinimap'
import { GraphSearchBox } from './search/GraphSearchBox'
import { GraphFilterPanel } from './filter/GraphFilterPanel'
import { GraphViewsMenu } from './views/GraphViewsMenu'
import { GraphForcesPanel } from './GraphForcesPanel'
import { GraphContextMenu } from './GraphContextMenu'
import { useGraphStore } from './graph-store'
import { useSurfaceStore } from '../surface/surface-store'
import { Tooltip } from '../../components/git/Tooltip'
import { MAX_SCOPE_DEPTH } from './filter/visibility'
import type { NeighborhoodDirection } from './scope/neighborhood'

function UnconfiguredNotice(): React.JSX.Element {
  const colors = useColors()
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        color: colors.textTertiary,
        fontSize: 12,
        fontFamily: 'system-ui, sans-serif',
        textAlign: 'center',
        padding: 24,
      }}
    >
      <div style={{ fontSize: 13, color: colors.textSecondary }}>Graph View needs an open project</div>
      <div>Open a conversation with a project directory to see its corpus graph.</div>
    </div>
  )
}

const DIRECTIONS: { value: NeighborhoodDirection; label: string; hint: string }[] = [
  { value: 'both', label: 'Both', hint: 'Follow links either way' },
  { value: 'out', label: 'Out', hint: 'Follow only what these documents link to' },
  { value: 'in', label: 'In', hint: 'Follow only what links to these documents' },
]

/**
 * The local-graph controls: the depth in both directions, which way links
 * are followed, and the way back to the whole corpus. Depth is a stepper
 * rather than a one-way "Expand" so a neighborhood that grew too wide can
 * be brought back in without starting over.
 */
function ScopeChip(): React.JSX.Element | null {
  const colors = useColors()
  const scope = useGraphStore((s) => s.scope)
  const setScopeDepth = useGraphStore((s) => s.setScopeDepth)
  const setScopeDirection = useGraphStore((s) => s.setScopeDirection)
  const setScopeToCorpus = useGraphStore((s) => s.setScopeToCorpus)
  if (scope.mode !== 'neighborhood') return null
  const direction = scope.direction ?? 'both'
  const linkStyle: React.CSSProperties = { background: 'none', border: 'none', color: colors.accent, cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontSize: 11 }
  const stepStyle: React.CSSProperties = { ...linkStyle, width: 16, textAlign: 'center' }

  // A flex item of the toolbar row, never absolutely placed: the row owns
  // the geometry, so a chip that appears after a double-click lands after
  // the search box instead of on top of the buttons.
  return (
    <div
      data-testid="graph-scope-chip"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px',
        borderRadius: 6,
        background: colors.surfaceSecondary,
        border: `1px solid ${colors.containerBorder}`,
        color: colors.textSecondary,
        fontSize: 11,
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'auto',
      }}
    >
      <span>Neighborhood</span>
      <button aria-label="Shallower" disabled={scope.depth <= 1} onClick={() => setScopeDepth(scope.depth - 1)} style={{ ...stepStyle, color: scope.depth <= 1 ? colors.textTertiary : colors.accent }}>
        −
      </button>
      <Tooltip text="Hops from the anchor"><span>depth {scope.depth}</span></Tooltip>
      <button aria-label="Deeper" disabled={scope.depth >= MAX_SCOPE_DEPTH} onClick={() => setScopeDepth(scope.depth + 1)} style={{ ...stepStyle, color: scope.depth >= MAX_SCOPE_DEPTH ? colors.textTertiary : colors.accent }}>
        +
      </button>
      {scope.expandedIds && scope.expandedIds.size > 0 && <span>+{scope.expandedIds.size} expanded</span>}
      <span style={{ display: 'inline-flex', gap: 2, marginLeft: 2 }}>
        {DIRECTIONS.map((d) => (
          <Tooltip key={d.value} text={d.hint}><button
            aria-pressed={direction === d.value}
            onClick={() => setScopeDirection(d.value)}
            style={{
              ...linkStyle,
              padding: '0 4px',
              borderRadius: 4,
              color: direction === d.value ? colors.textPrimary : colors.textTertiary,
              background: direction === d.value ? colors.surfaceActive : 'none',
            }}
          >
            {d.label}
          </button></Tooltip>
        ))}
      </span>
      <button onClick={setScopeToCorpus} style={linkStyle}>
        Show whole corpus
      </button>
    </div>
  )
}

/** One toolbar affordance. Shared so the three buttons cannot drift apart. */
function ToolbarButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): React.JSX.Element {
  const colors = useColors()
  return (
    <button
      onClick={onClick}
      style={{
        padding: '3px 8px',
        borderRadius: 6,
        background: active ? colors.surfaceActive : colors.surfaceSecondary,
        border: `1px solid ${active ? colors.accentBorderMedium : colors.containerBorder}`,
        color: active ? colors.textPrimary : colors.textSecondary,
        fontSize: 11,
        fontFamily: 'system-ui, sans-serif',
        cursor: 'pointer',
        pointerEvents: 'auto',
      }}
    >
      {label}
    </button>
  )
}

/**
 * The floating shell every tool panel renders into: an opaque popover under
 * the toolbar, scrolling internally so a long catalog cannot grow past the
 * stage, with its own close affordance.
 */
function FloatingPanel({ onClose, children }: { onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  const colors = useColors()
  return (
    <div
      style={{
        position: 'absolute',
        top: 36,
        left: 8,
        width: 360,
        maxHeight: 'calc(100% - 52px)',
        display: 'flex',
        flexDirection: 'column',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        boxShadow: colors.popoverShadow,
        zIndex: 5,
      }}
    >
      {/* A flowed header, not a button positioned absolutely over the
          content: an absolutely-positioned hit target computed against a
          zoomed, scroll-nested ancestor is exactly the pixel arithmetic the
          app's `zoom`-based UI scaling makes fragile (see the `uiZoom` note
          in GraphCanvas.tsx). Flex flow needs none of that arithmetic, so
          the click target can never drift from the glyph under it. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', flex: '0 0 auto', padding: '4px 4px 0' }}>
        <button
          onClick={onClose}
          aria-label="Close panel"
          style={{
            width: 20,
            height: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'none',
            border: 'none',
            borderRadius: 4,
            color: colors.textTertiary,
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ overflowY: 'auto' }}>{children}</div>
    </div>
  )
}

export function GraphSurface({ active }: { active: boolean }): React.JSX.Element {
  const colors = useColors()
  const [panelOpen, setPanelOpen] = useState<'encoding' | 'filters' | 'forces' | 'views' | null>(null)
  const surfaceMaximized = useSurfaceStore((s) => s.maximized)
  const [sigma, setSigma] = useState<Sigma | null>(null)
  const projectPath = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.workingDirectory ?? null)
  const init = useGraphStore((s) => s.init)
  const dispose = useGraphStore((s) => s.dispose)
  const available = useGraphStore((s) => s.available)
  const graph = useGraphStore((s) => s.graph)
  const storeProjectPath = useGraphStore((s) => s.projectPath)
  const hasSelection = useGraphStore((s) => s.selectedNodeIds.size > 0)
  const requestCamera = useGraphStore((s) => s.requestCamera)
  const resetLayout = useGraphStore((s) => s.resetLayout)
  const fitToView = (): void => {
    const { scope, visibleNodeIds } = useGraphStore.getState()
    if (scope.mode === 'corpus') requestCamera({ kind: 'fit-all' })
    else requestCamera({ kind: 'fit-nodes', nodeIds: [...visibleNodeIds] })
  }

  useEffect(() => {
    if (!projectPath || projectPath === '~') return
    if (storeProjectPath === projectPath) return
    void init(projectPath)
    return () => {
      dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  const content = useMemo(() => {
    if (!projectPath || projectPath === '~' || !available) return <UnconfiguredNotice />
    if (!graph) return null
    return <GraphCanvas graph={graph} onSigma={setSigma} />
  }, [projectPath, available, graph])

  return (
    <div style={{ display: active ? 'flex' : 'none', flex: 1, minHeight: 0, position: 'relative', flexDirection: 'column', overflow: 'hidden', background: colors.containerBg }}>
      {/* A faint vignette gives the stage depth without a single repaint:
          it is one static gradient under transparent canvas layers. */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative', background: `radial-gradient(ellipse at center, transparent 45%, ${colors.graphStageVignette} 100%)` }}>
        {content}
        {available && graph && <GraphLegend />}
        {available && graph && hasSelection && <GraphInspector />}
        {available && graph && <GraphQuickPeek />}
        {available && graph && <GraphContextMenu />}
        {available && graph && <GraphIssueBadges />}
        {available && graph && <GraphMinimap sigma={sigma} />}
        {available && graph && (
          // `right: 8` stretches this row's box nearly the full stage width so
          // it can wrap, but that box paints over the inspector's top-right
          // corner (later in DOM order, same stacking context) even past its
          // last visible button. `pointerEvents: 'none'` here — restored to
          // `auto` on each real control below — lets clicks in that empty
          // strip fall through to whatever is actually under them.
          <div style={{ position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'flex-start', pointerEvents: 'none' }}>
            <ToolbarButton label="Bindings" active={panelOpen === 'encoding'} onClick={() => setPanelOpen(panelOpen === 'encoding' ? null : 'encoding')} />
            <ToolbarButton label="Filters" active={panelOpen === 'filters'} onClick={() => setPanelOpen(panelOpen === 'filters' ? null : 'filters')} />
            <ToolbarButton label="Forces" active={panelOpen === 'forces'} onClick={() => setPanelOpen(panelOpen === 'forces' ? null : 'forces')} />
            <ToolbarButton label="Views" active={panelOpen === 'views'} onClick={() => setPanelOpen(panelOpen === 'views' ? null : 'views')} />
            <ToolbarButton label="Fit" active={false} onClick={fitToView} />
            <ToolbarButton label="Reset layout" active={false} onClick={resetLayout} />
            <ToolbarButton label={surfaceMaximized ? 'Exit full screen' : 'Full screen'} active={surfaceMaximized} onClick={() => useSurfaceStore.getState().toggleMaximized()} />
            <GraphSearchBox />
            <ScopeChip />
            <GraphWatchChip />
          </div>
        )}
        {available && graph && panelOpen !== null && (
          <FloatingPanel onClose={() => setPanelOpen(null)}>
            {panelOpen === 'encoding' && <GraphBindingPanel />}
            {panelOpen === 'filters' && <GraphFilterPanel />}
            {panelOpen === 'forces' && <GraphForcesPanel />}
            {panelOpen === 'views' && <GraphViewsMenu />}
          </FloatingPanel>
        )}
      </div>
    </div>
  )
}
