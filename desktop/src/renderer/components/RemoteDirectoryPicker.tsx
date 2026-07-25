import React, { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Folder, FolderOpen, CaretUp, House, Eye, EyeSlash, X } from '@phosphor-icons/react'
import { useRemoteFsStore } from '../stores/remote-fs-store'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import type { EngineDirListing } from '../../shared/types'

/**
 * Modal directory picker that browses the engine host's filesystem via the
 * `list_directory` RPC. Used when the desktop is connected to a remote engine
 * and a session needs a working directory that exists on the engine's host
 * (not the desktop's host).
 *
 * Driven imperatively: callers invoke `useRemoteFsStore.getState().openRemotePicker(start)`
 * and `await` the returned promise. This component reads picker state from
 * the store and resolves the promise on confirm/cancel.
 *
 * Mount once near the app root.
 */
export function RemoteDirectoryPicker() {
  const colors = useColors()
  const picker = useRemoteFsStore((s) => s.picker)
  const hostInfo = useRemoteFsStore((s) => s.hostInfo)
  const resolvePicker = useRemoteFsStore((s) => s.resolvePicker)
  const listDirectory = useRemoteFsStore((s) => s.listDirectory)

  const [path, setPath] = useState('')
  const [listing, setListing] = useState<EngineDirListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const closeIx = useInteractiveState()
  const cancelIx = useInteractiveState()
  const confirmIx = useInteractiveState()

  const load = useCallback(
    async (p: string) => {
      setLoading(true)
      setError(null)
      const data = await listDirectory(p, showHidden)
      setLoading(false)
      if (!data) {
        setError(`Could not list ${p}`)
        return
      }
      setListing(data)
      setPath(data.path)
    },
    [listDirectory, showHidden],
  )

  // Open: load initial path
  useEffect(() => {
    if (picker.open) {
      void load(picker.startPath)
    } else {
      // Reset when closed so re-opens don't briefly flash stale entries.
      setListing(null)
      setError(null)
    }
  }, [picker.open, picker.startPath, load])

  // Re-load when hidden toggle flips
  useEffect(() => {
    if (picker.open && path) void load(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden])

  // Esc closes
  useEffect(() => {
    if (!picker.open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolvePicker(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [picker.open, resolvePicker])

  if (!picker.open) return null

  const goUp = () => {
    if (listing?.parent) void load(listing.parent)
  }
  const goHome = () => {
    if (hostInfo?.home) void load(hostInfo.home)
  }
  const enterDir = (name: string) => {
    if (!listing) return
    const sep = hostInfo?.pathSep ?? '/'
    const next = listing.path.endsWith(sep) ? listing.path + name : listing.path + sep + name
    void load(next)
  }
  const confirm = () => resolvePicker(path)
  const cancel = () => resolvePicker(null)

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.1 }}
        onClick={cancel}
        style={{
          position: 'fixed',
          inset: 0,
          background: colors.scrim,
          zIndex: 9000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <motion.div
          key="dialog"
          data-ion-ui
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.99 }}
          transition={{ duration: 0.14 }}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 560,
            maxHeight: '70vh',
            display: 'flex',
            flexDirection: 'column',
            background: colors.popoverBg,
            border: `1px solid ${colors.popoverBorder}`,
            borderRadius: 12,
            boxShadow: colors.popoverShadow,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            pointerEvents: 'auto',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              borderBottom: `1px solid ${colors.popoverBorder}`,
            }}
          >
            <FolderOpen size={14} style={{ color: colors.accent, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: colors.textTertiary, letterSpacing: '0.02em' }}>
                Choose a folder on {hostInfo?.hostname ? `“${hostInfo.hostname}”` : 'the engine host'}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: colors.textPrimary,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={path}
              >
                {path || '…'}
              </div>
            </div>
            <button
              onClick={cancel}
              {...closeIx.handlers}
              className="ion-focusable"
              style={{
                background: interactiveBg(colors, closeIx),
                border: 'none',
                color: closeIx.hover ? colors.textSecondary : colors.textTertiary,
                cursor: 'pointer',
                padding: 4,
                borderRadius: 6,
                transition: `background ${transitions.base}, color ${transitions.base}`,
              }}
              title="Close (Esc)"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>

          {/* Controls */}
          <div
            style={{
              display: 'flex',
              gap: 4,
              padding: '6px 8px',
              borderBottom: `1px solid ${colors.popoverBorder}`,
            }}
          >
            <ControlButton onClick={goUp} disabled={!listing?.parent} title="Parent directory">
              <CaretUp size={11} /> Up
            </ControlButton>
            <ControlButton onClick={goHome} disabled={!hostInfo?.home} title="Home">
              <House size={11} /> Home
            </ControlButton>
            <div style={{ flex: 1 }} />
            <ControlButton
              onClick={() => setShowHidden((v) => !v)}
              title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
            >
              {showHidden ? <EyeSlash size={11} /> : <Eye size={11} />}
              {showHidden ? 'Hide hidden' : 'Show hidden'}
            </ControlButton>
          </div>

          {/* Listing */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 200 }}>
            {loading && (
              <div style={{ padding: 12, fontSize: 11, color: colors.textTertiary }}>Loading…</div>
            )}
            {!loading && error && (
              <div style={{ padding: 12, fontSize: 11, color: colors.diffRemoveText }}>{error}</div>
            )}
            {!loading && !error && listing && listing.entries.length === 0 && (
              <div style={{ padding: 12, fontSize: 11, color: colors.textTertiary }}>(empty directory)</div>
            )}
            {!loading && !error && listing && listing.entries.map((entry) => (
              <DirEntryRow key={entry.name} entry={entry} onEnter={() => enterDir(entry.name)} />
            ))}
            {listing?.truncated && (
              <div style={{ padding: '6px 12px', fontSize: 10, color: colors.textTertiary }}>
                Showing first 5000 entries — narrow the path to see more.
              </div>
            )}
          </div>

          {/* Footer */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              padding: '8px 12px',
              borderTop: `1px solid ${colors.popoverBorder}`,
              justifyContent: 'flex-end',
            }}
          >
            <button
              onClick={cancel}
              {...cancelIx.handlers}
              className="ion-focusable"
              style={{
                padding: '4px 12px',
                fontSize: 11,
                color: colors.textSecondary,
                background: interactiveBg(colors, cancelIx),
                border: `1px solid ${colors.popoverBorder}`,
                borderRadius: 6,
                cursor: 'pointer',
                transition: `background ${transitions.base}`,
              }}
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={!path}
              onMouseEnter={path ? confirmIx.handlers.onMouseEnter : undefined}
              onMouseLeave={confirmIx.handlers.onMouseLeave}
              onMouseDown={path ? confirmIx.handlers.onMouseDown : undefined}
              onMouseUp={path ? confirmIx.handlers.onMouseUp : undefined}
              onBlur={confirmIx.handlers.onBlur}
              className="ion-focusable"
              style={{
                padding: '4px 12px',
                fontSize: 11,
                color: colors.textOnAccent,
                background: confirmIx.pressed ? colors.accentPressed : confirmIx.hover ? colors.accentHover : colors.accent,
                border: 'none',
                borderRadius: 6,
                cursor: path ? 'pointer' : 'default',
                opacity: path ? 1 : 0.45,
                transition: `background ${transitions.base}`,
              }}
            >
              Use this folder
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}

/** Toolbar control (Up / Home / hidden toggle). Hover/pressed via the
 *  standard surface cascade; disabled gets the standard treatment
 *  (opacity 0.45, default cursor, inert hover/pressed handlers). */
function ControlButton({ onClick, disabled = false, title, children }: {
  onClick: () => void
  disabled?: boolean
  title: string
  children: React.ReactNode
}) {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={disabled ? undefined : handlers.onMouseEnter}
      onMouseLeave={handlers.onMouseLeave}
      onMouseDown={disabled ? undefined : handlers.onMouseDown}
      onMouseUp={disabled ? undefined : handlers.onMouseUp}
      onBlur={handlers.onBlur}
      className="ion-focusable"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 8px',
        fontSize: 11,
        color: disabled ? colors.textTertiary : colors.textSecondary,
        background: disabled ? 'transparent' : interactiveBg(colors, { hover, pressed }),
        border: 'none',
        borderRadius: 6,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: `background ${transitions.base}`,
      }}
    >
      {children}
    </button>
  )
}

/** One directory-listing row. Extracted so `useInteractiveState` runs per
 *  row (hooks cannot run inside the parent's map); replaces the previous
 *  `hover:bg-white/5` utility class with the token-driven cascade.
 *  Non-navigable entries (files, unreadable dirs) render inert. */
function DirEntryRow({ entry, onEnter }: {
  entry: EngineDirListing['entries'][number]
  onEnter: () => void
}) {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  const clickable = entry.isDir && entry.readable
  return (
    <button
      onClick={() => clickable && onEnter()}
      disabled={!clickable}
      onMouseEnter={clickable ? handlers.onMouseEnter : undefined}
      onMouseLeave={handlers.onMouseLeave}
      onMouseDown={clickable ? handlers.onMouseDown : undefined}
      onMouseUp={clickable ? handlers.onMouseUp : undefined}
      onBlur={handlers.onBlur}
      className="ion-focusable"
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 12px',
        fontSize: 12,
        color: clickable
          ? colors.textPrimary
          : entry.readable
            ? colors.textSecondary
            : colors.textTertiary,
        background: clickable ? interactiveBg(colors, { hover, pressed }) : 'transparent',
        border: 'none',
        cursor: clickable ? 'pointer' : 'default',
        textAlign: 'left',
        opacity: entry.readable ? 1 : 0.45,
        transition: `background ${transitions.base}`,
      }}
      title={!entry.readable ? `${entry.name} (no permission)` : entry.name}
    >
      {entry.isDir
        ? <Folder size={13} style={{ color: colors.accent, flexShrink: 0 }} />
        : <span style={{ width: 13, height: 13, flexShrink: 0 }} />}
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {entry.name}
        {entry.isSymlink && <span style={{ color: colors.textTertiary, marginLeft: 4 }}>→</span>}
      </span>
    </button>
  )
}
