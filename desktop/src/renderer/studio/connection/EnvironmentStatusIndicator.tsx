/**
 * EnvironmentStatusIndicator — the title-bar answer to "where did my other
 * machine's conversations go?".
 *
 * An Environment that stops answering has its rows removed from the Tab
 * Strip and the Inbox, which is the honest thing to do with state this
 * desktop can no longer vouch for — but silently removing rows is its own
 * way of misleading someone. So the moment any catalogued Environment is
 * not live, a warning dot appears beside the notifications bell, and its
 * popover names each one, how long it has been unreachable, and offers the
 * two things worth doing about it: retry now, or go manage the catalog.
 *
 * Nothing here is a second source of truth. The list is the availability
 * store's, the retry is the registry's own, and the dot disappears when
 * the wire is welcomed again -- the same signal that brings the rows back.
 */
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { WifiSlash } from '@phosphor-icons/react'
import { zoomAnchorEdges } from '../../viewport-zoom'
import { usePopoverLayer } from '../../components/PopoverLayer'
import { useColors } from '../../theme'
import { registry } from './registry'
import { openEnvironmentSettings } from './EnvironmentUnavailable'
import { useDegradedEnvironments, type EnvironmentAvailabilityEntry } from './environment-availability'
import { rInfo } from '../../rendererLogger'

function howLong(since: number | null): string {
  if (since === null) return ''
  const seconds = Math.round((Date.now() - since) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

function describe(entry: EnvironmentAvailabilityEntry): string {
  return entry.availability === 'reconnecting'
    ? `reconnecting, ${howLong(entry.since)}`
    : `offline for ${howLong(entry.since)} — its conversations are hidden`
}

export function EnvironmentStatusIndicator(): React.JSX.Element | null {
  const colors = useColors()
  const degraded = useDegradedEnvironments()
  const popoverLayer = usePopoverLayer()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ right: number; top: number }>({ right: 0, top: 0 })
  // Re-renders the popover once a second so "offline for 4m" is not frozen
  // at whatever it said when it opened. Only while it is actually on screen.
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Nothing is wrong: no dot, no gap in the title bar.
  if (degraded.length === 0) return null

  const anyOffline = degraded.some((entry) => entry.availability === 'offline')
  const tone = anyOffline ? colors.statusError : colors.statusWarning

  const toggle = (): void => {
    if (!open && triggerRef.current) {
      const rect = zoomAnchorEdges(triggerRef.current.getBoundingClientRect())
      setPos({ right: rect.fromRight, top: rect.bottom + 6 })
    }
    setOpen((o) => !o)
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggle}
        data-testid="environment-status-indicator"
        data-degraded-count={degraded.length}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors relative"
        style={{ color: tone }}
        title={degraded.length === 1 ? `${degraded[0].label} is ${describe(degraded[0])}` : `${degraded.length} environments are not answering`}
      >
        <WifiSlash size={14} />
      </button>

      {popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-ion-ui
          data-testid="environment-status-popover"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed', top: pos.top, right: pos.right, width: 300, pointerEvents: 'auto',
            background: colors.popoverBg, border: `1px solid ${colors.popoverBorder}`,
            padding: 10, display: 'flex', flexDirection: 'column', gap: 8,
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, color: colors.textSecondary }}>Environments not answering</span>
          {degraded.map((entry) => (
            <div key={entry.environmentId} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 12, color: colors.textPrimary }}>{entry.label}</span>
              <span style={{ fontSize: 11, color: colors.textTertiary }}>{describe(entry)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', borderTop: `1px solid ${colors.popoverBorder}`, paddingTop: 8 }}>
            <button
              type="button"
              onClick={() => {
                rInfo('studio.availability', 'manual reconnect requested from the title bar', { degraded_count: degraded.length })
                registry.refresh()
              }}
              style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, border: `1px solid ${colors.containerBorder}`, background: 'transparent', color: colors.textSecondary, cursor: 'pointer' }}
            >
              Reconnect now
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); openEnvironmentSettings() }}
              style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, border: 'none', background: 'transparent', color: colors.accent, cursor: 'pointer' }}
            >
              Environments…
            </button>
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
