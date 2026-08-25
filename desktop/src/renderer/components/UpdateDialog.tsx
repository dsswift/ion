import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'
import { ArrowCircleUp } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useUpdateStore } from '../stores/update-store'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

/** Shared update dialog for the Overlay and Studio presentations. */
export function UpdateDialog(): React.ReactElement | null {
  const dialogOpen = useUpdateStore((s) => s.dialogOpen)
  const version = useUpdateStore((s) => s.version)
  const progress = useUpdateStore((s) => s.progress)
  const staged = useUpdateStore((s) => s.staged)
  const updateError = useUpdateStore((s) => s.error)
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const laterIx = useInteractiveState()
  const installIx = useInteractiveState()

  useEffect(() => {
    if (!dialogOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useUpdateStore.getState().hideDialog()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [dialogOpen])

  if (!popoverLayer || !dialogOpen) return null

  const heading = updateError
    ? 'Update failed'
    : staged
      ? `Ion ${version ?? ''} is ready`
      : progress !== null
        ? 'Downloading Ion update'
        : `Ion ${version ?? ''} is ready`
  const detail = updateError
    ?? (staged
      ? 'Restart to finish the installation. Ion will close the desktop and engine, then reopen when the update is complete.'
      : progress !== null
        ? `Downloading update: ${Math.round(progress)}%.`
        : 'A new version has been downloaded. Install it when you are ready.')

  return createPortal(
    <AnimatePresence>
      <motion.div
        data-ion-ui
        key="update-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={() => useUpdateStore.getState().hideDialog()}
        style={{
          position: 'fixed',
          inset: 0,
          background: colors.scrim,
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          boxSizing: 'border-box',
          overflowY: 'auto',
        }}
      >
        <motion.div
          data-ion-ui
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={TRANSITION}
          onClick={(e) => e.stopPropagation()}
          className="glass-surface"
          style={{
            width: 320,
            maxWidth: '100%',
            maxHeight: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
            overflowY: 'auto',
            borderRadius: 16,
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ color: updateError ? colors.dangerFg : colors.accent, marginBottom: 4 }}>
            <ArrowCircleUp size={36} weight="fill" />
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.textPrimary, textAlign: 'center' }}>
            {heading}
          </div>
          <div style={{ fontSize: 12, color: colors.textSecondary, textAlign: 'center', lineHeight: 1.5 }}>
            {detail}
          </div>
          {progress !== null && (
            <div style={{ width: '100%', height: 4, background: colors.surfacePrimary, borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${progress}%`, height: '100%', background: colors.accent }} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, width: '100%' }}>
            <button
              onClick={() => useUpdateStore.getState().hideDialog()}
              {...laterIx.handlers}
              className="ion-focusable flex-1 py-1.5 rounded-lg text-[12px] font-medium"
              style={{
                color: colors.textSecondary,
                background: interactiveBg(colors, laterIx, colors.surfacePrimary),
                border: `1px solid ${colors.containerBorder}`,
                cursor: 'pointer',
                transition: `background ${transitions.base}`,
              }}
            >
              {updateError ? 'Close' : 'Later'}
            </button>
            {!updateError && progress === null && (
              <button
                onClick={() => staged ? window.ion.restartForUpdate() : window.ion.installUpdate()}
                {...installIx.handlers}
                className="ion-focusable flex-1 py-1.5 rounded-lg text-[12px] font-medium"
                style={{
                  color: colors.textOnAccent,
                  background: installIx.pressed ? colors.accentPressed : installIx.hover ? colors.accentHover : colors.accent,
                  border: 'none',
                  cursor: 'pointer',
                  transition: `background ${transitions.base}`,
                }}
              >
                {staged ? 'Restart to finish' : 'Install update'}
              </button>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    popoverLayer,
  )
}
