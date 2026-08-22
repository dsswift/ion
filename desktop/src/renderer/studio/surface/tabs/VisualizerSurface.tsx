/**
 * VisualizerSurface — the visualizer singleton surface tab body.
 *
 * Stays MOUNTED when inactive (canvas state, engine caches) and hides via
 * display:none — but display:none only stops paint, not the rAF loop, so
 * the engine is explicitly paused on deactivate and resumed on activate
 * (D10). Event ingestion (AgentCache) continues while paused: reactivation
 * is instant.
 */
import React, { useEffect, useRef } from 'react'
import { VisualizerRoot, type VisualizerHandle } from '../../visualizer/VisualizerRoot'

export function VisualizerSurface({
  active,
  onAgentClick,
}: {
  active: boolean
  onAgentClick?: (tabId: string, agentName: string) => void
}): React.JSX.Element {
  const handleRef = useRef<VisualizerHandle | null>(null)

  useEffect(() => {
    if (active) handleRef.current?.resume()
    else handleRef.current?.pause()
  }, [active])

  return (
    <div style={{ display: active ? 'flex' : 'none', flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
      <VisualizerRoot onAgentClick={onAgentClick} handleRef={handleRef} />
    </div>
  )
}
