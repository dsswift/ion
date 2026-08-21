import type { PersistedTabState } from '../../shared/types'
import { useSessionStore } from '../stores/sessionStore'

type Geometry = { x: number; y: number; w: number; h: number }

function clampGeometry(geometry: Geometry, minWidth: number, minHeight: number): Geometry {
  return {
    x: Math.max(-200, Math.min(window.innerWidth - 100, geometry.x)),
    y: Math.max(0, Math.min(window.innerHeight - 32, geometry.y)),
    w: Math.max(minWidth, geometry.w),
    h: Math.max(minHeight, geometry.h),
  }
}

/** Restore persisted popup geometry within the current display bounds. */
export function restoreGlobalGeometry(saved: PersistedTabState): void {
  if (saved.editorGeometry) {
    useSessionStore.setState({ editorGeometry: clampGeometry(saved.editorGeometry, 400, 280) })
  }
  if (saved.planGeometry) {
    useSessionStore.setState({ planGeometry: clampGeometry(saved.planGeometry, 280, 180) })
  }
  if (saved.agentDetailGeometry) {
    useSessionStore.setState({ agentDetailGeometry: clampGeometry(saved.agentDetailGeometry, 280, 180) })
  }
}
