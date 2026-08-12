import React, { useState, useEffect } from 'react'
import { formatDuration } from './agent-panel-helpers'

/**
 * Live-ticking duration readout for a dispatch.
 *
 * While `status === 'running'` and a `startTime` is known, this re-renders once
 * a second so the elapsed clock advances in place. On any other status it
 * formats the final `elapsed` value and stops ticking. Renders nothing when
 * there is neither a running clock nor a recorded elapsed.
 *
 * Extracted from the former AgentExpandedView (deleted with the inline-expand
 * mode) so its two surviving consumers — the agent-panel row and the dispatch
 * meta bar — do not depend on a component that no longer exists.
 */
export function DurationDisplay({ startTime, elapsed, status }: { startTime?: number; elapsed?: number; status: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (status !== 'running' || !startTime) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status, startTime])

  if (status === 'running' && startTime) {
    const secs = Math.floor((now / 1000) - startTime)
    return <span>{formatDuration(Math.max(0, secs))}</span>
  }
  if (elapsed != null) {
    return <span>{formatDuration(Math.round(elapsed))}</span>
  }
  return null
}
