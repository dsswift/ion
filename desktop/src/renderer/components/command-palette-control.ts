import { useEffect, useRef } from 'react'
import type { PaletteEntry } from './command-palette-rank'

export interface CommandPaletteProps {
  actions?: PaletteEntry[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Command palette UI. Global keyboard ownership lives in useCommandShortcuts
 * so both windows use configured view-specific bindings and never double-fire.
 */
export function usePaletteToggle(open: boolean, setOpen: (open: boolean) => void): () => void {
  const openRef = useRef(open)
  openRef.current = open
  const setOpenRef = useRef(setOpen)
  setOpenRef.current = setOpen
  return () => setOpenRef.current(!openRef.current)
}

export function usePaletteEscape(open: boolean, onOpenChange: (open: boolean) => void): void {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onOpenChange(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onOpenChange, open])
}
