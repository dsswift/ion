/**
 * GraphContextMenu — the right-click verbs, on a node or on the stage.
 *
 * On a node: open its file, pin or unpin it, expand it (drill in), collapse
 * its expansion, hide it, fit its neighbourhood, and re-collapse its
 * community while coarsened. On the stage: fit, show the whole corpus,
 * restore hidden nodes, and re-collapse every opened community. Each verb
 * is a store action the keyboard map also reaches (`graph-canvas-keys.ts`),
 * so the menu is a discoverable face over one set of behaviour, not a
 * second one.
 *
 * Placed inside the stage in stage coordinates, like Quick Peek, and
 * clamped to the stage's edges after it is measured. A transparent backdrop
 * behind it closes it on any press elsewhere.
 */

import React, { useLayoutEffect, useRef, useState } from 'react'
import { useColors } from '../../theme'
import { useGraphStore } from './graph-store'
import { neighborhood } from './scope/neighborhood'
import { isCoarsened } from './coarsen/coarsen'

const EDGE_MARGIN_PX = 6

interface Item {
  label: string
  onSelect(): void
  disabled?: boolean
}

function itemsForNode(nodeId: string): Item[] {
  const store = useGraphStore.getState()
  const node = store.model?.nodes.find((n) => n.id === nodeId)
  const pinned = store.pinnedNodeIds.has(nodeId)
  const expanded = store.scope.mode === 'neighborhood' && (store.scope.expandedIds?.has(nodeId) ?? false)
  const items: Item[] = []
  if (node?.path) items.push({ label: 'Open file', onSelect: () => store.requestOpenFile(nodeId) })
  items.push({ label: pinned ? 'Unpin' : 'Pin in place', onSelect: () => store.togglePin(nodeId) })
  items.push({ label: store.scope.mode === 'corpus' ? 'Show neighborhood' : 'Expand', onSelect: () => store.drillInto(nodeId) })
  if (expanded) items.push({ label: 'Collapse expansion', onSelect: () => store.collapseNodeScope(nodeId) })
  items.push({
    label: 'Fit neighborhood',
    onSelect: () => {
      const graph = store.graph
      if (!graph) return
      store.requestCamera({ kind: 'fit-nodes', nodeIds: [...neighborhood(graph, nodeId, 1)] })
    },
  })
  if (node && isCoarsened(store.cameraRatio) && store.expandedCommunities.has(node.community)) {
    items.push({ label: 'Collapse community', onSelect: () => store.collapseCommunity(node.community) })
  }
  items.push({ label: 'Hide', onSelect: () => store.hideNode(nodeId) })
  return items
}

function itemsForStage(): Item[] {
  const store = useGraphStore.getState()
  const items: Item[] = [
    {
      label: 'Fit',
      onSelect: () => {
        if (store.scope.mode === 'corpus') store.requestCamera({ kind: 'fit-all' })
        else store.requestCamera({ kind: 'fit-nodes', nodeIds: [...store.visibleNodeIds] })
      },
    },
  ]
  if (store.scope.mode === 'neighborhood') items.push({ label: 'Show whole corpus', onSelect: () => store.setScopeToCorpus() })
  if (store.hiddenNodeIds.size > 0) items.push({ label: `Unhide ${store.hiddenNodeIds.size} hidden`, onSelect: () => store.unhideAllNodes() })
  if (store.expandedCommunities.size > 0) items.push({ label: 'Collapse all communities', onSelect: () => store.collapseAllCommunities() })
  if (store.selectedNodeIds.size > 0) items.push({ label: 'Clear selection', onSelect: () => store.selectNode(null) })
  return items
}

export function GraphContextMenu(): React.JSX.Element | null {
  const colors = useColors()
  const menu = useGraphStore((s) => s.contextMenu)
  const closeContextMenu = useGraphStore((s) => s.closeContextMenu)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = menuRef.current
    const stage = el?.offsetParent as HTMLElement | null
    if (!el || !stage || !menu) {
      setPlacement(null)
      return
    }
    const maxLeft = stage.clientWidth - el.offsetWidth - EDGE_MARGIN_PX
    const maxTop = stage.clientHeight - el.offsetHeight - EDGE_MARGIN_PX
    setPlacement({
      left: Math.max(EDGE_MARGIN_PX, Math.min(menu.at.x, Math.max(EDGE_MARGIN_PX, maxLeft))),
      top: Math.max(EDGE_MARGIN_PX, Math.min(menu.at.y, Math.max(EDGE_MARGIN_PX, maxTop))),
    })
  }, [menu])

  if (!menu) return null
  const items = menu.nodeId ? itemsForNode(menu.nodeId) : itemsForStage()
  const label = menu.nodeId ? useGraphStore.getState().model?.nodes.find((n) => n.id === menu.nodeId)?.label ?? menu.nodeId : 'Stage'

  return (
    <>
      <div
        data-testid="graph-context-backdrop"
        onMouseDown={closeContextMenu}
        onContextMenu={(e) => {
          e.preventDefault()
          closeContextMenu()
        }}
        style={{ position: 'absolute', inset: 0, zIndex: 6 }}
      />
      <div
        ref={menuRef}
        role="menu"
        data-testid="graph-context-menu"
        style={{
          position: 'absolute',
          left: placement?.left ?? menu.at.x,
          top: placement?.top ?? menu.at.y,
          visibility: placement ? 'visible' : 'hidden',
          minWidth: 170,
          padding: 4,
          borderRadius: 6,
          background: colors.popoverBg,
          border: `1px solid ${colors.popoverBorder}`,
          boxShadow: colors.popoverShadow,
          fontSize: 11,
          fontFamily: 'system-ui, sans-serif',
          zIndex: 7,
        }}
      >
        <div style={{ padding: '3px 8px 5px', color: colors.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>{label}</div>
        {items.map((item) => (
          <button
            key={item.label}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              closeContextMenu()
              item.onSelect()
            }}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '4px 8px',
              background: 'none',
              border: 'none',
              borderRadius: 4,
              color: item.disabled ? colors.textTertiary : colors.textPrimary,
              cursor: item.disabled ? 'default' : 'pointer',
              fontFamily: 'inherit',
              fontSize: 11,
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  )
}
