/**
 * TabStrip pinned-action button. Under single-UI exclusivity its overlay
 * role is gone by construction: `studioEnabled` (derived: Studio is the
 * active UI) is always false in the overlay, so the button renders null
 * there — the inactive UI's affordances are ABSENT, not disabled. Inside
 * the Studio window it is the visualizer-controls popover trigger
 * (StudioShell listens for the window-local toggle event).
 */
import React, { useEffect, useState } from 'react'
import { UsersThree } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'
import { isMirrorWindow } from '../lib/window-role'

export function StudioLauncherButton(): React.JSX.Element | null {
  const colors = useColors()
  const [studioOpen, setStudioOpen] = useState(false)
  const [enabled, setEnabled] = useState(true)
  // Same component in both windows (parity mechanism 1), different verb:
  // the overlay launches/focuses the Studio window; INSIDE the Studio window the window
  // is already here, so the button opens the visualizer-controls popover
  // (StudioShell listens for this window-local event and renders it).
  const mirror = isMirrorWindow()

  useEffect(() => {
    let mounted = true
    // Optional-chained: component tests mount TabStrip with a partial bridge.
    void window.ion?.studioGetSettings?.()?.then?.((s) => {
      if (mounted && s && typeof s.studioEnabled === 'boolean') setEnabled(s.studioEnabled)
    })
    const off = window.ion?.onStudioWindowState?.((open) => setStudioOpen(open))
    return () => {
      mounted = false
      off?.()
    }
  }, [])

  if (!enabled || mirror) return null
  return (
    <Tooltip text={studioOpen ? 'Focus Ion Studio' : 'Open Ion Studio'}>
      <button
        onClick={() => {
          window.ion.studioOpen()
        }}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
        style={{ color: studioOpen ? colors.accent : colors.textTertiary }}
      >
        <UsersThree size={14} weight={studioOpen ? 'fill' : 'regular'} />
      </button>
    </Tooltip>
  )
}
