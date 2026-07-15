/**
 * TabStrip pinned-action button that opens (or focuses) the Agent Team
 * Visualizer window. Kept as its own component: TabStrip.tsx is an
 * allowlisted god file and gets only the import + render lines.
 *
 * Doubles as the ATV's presence indicator: accent-colored while the ATV
 * window is open (main pushes atv:window-state on open/close). Hidden
 * entirely when the surface policy disables the ATV.
 */
import React, { useEffect, useRef, useState } from 'react'
import { UsersThree } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'
import { isMirrorWindow } from '../lib/window-role'

export function AtvLauncherButton(): React.JSX.Element | null {
  const colors = useColors()
  const btnRef = useRef<HTMLButtonElement>(null)
  const [atvOpen, setAtvOpen] = useState(false)
  const [enabled, setEnabled] = useState(true)
  // Same component in both windows (parity mechanism 1), different verb:
  // the overlay launches/focuses the ATV window; INSIDE the ATV the window
  // is already here, so the button opens the visualizer-controls popover
  // (AtvShell listens for this window-local event and renders it).
  const mirror = isMirrorWindow()

  useEffect(() => {
    let mounted = true
    // Optional-chained: component tests mount TabStrip with a partial bridge.
    void window.ion?.atvGetSettings?.()?.then?.((s) => {
      if (mounted && s && typeof s.atvEnabled === 'boolean') setEnabled(s.atvEnabled)
    })
    const off = window.ion?.onAtvWindowState?.((open) => setAtvOpen(open))
    return () => {
      mounted = false
      off?.()
    }
  }, [])

  if (!enabled) return null
  return (
    <Tooltip text={mirror ? 'Visualizer controls' : atvOpen ? 'Focus Agent Team Visualizer' : 'Open Agent Team Visualizer'}>
      <button
        ref={btnRef}
        onClick={() => {
          if (mirror) {
            const rect = btnRef.current?.getBoundingClientRect()
            window.dispatchEvent(new CustomEvent('ion:atv-controls-toggle', {
              detail: { x: rect?.left ?? 0, y: rect?.bottom ?? 0 },
            }))
          } else {
            window.ion.atvOpen()
          }
        }}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
        style={{ color: atvOpen ? colors.accent : colors.textTertiary }}
      >
        <UsersThree size={14} weight={atvOpen ? 'fill' : 'regular'} />
      </button>
    </Tooltip>
  )
}
