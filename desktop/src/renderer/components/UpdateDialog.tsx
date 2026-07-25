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

/**
 * Modal dialog shown when a new version is downloaded and ready to install.
 * Portalled into the PopoverLayer, following the CloseTabConfirmDialog pattern.
 */
export function UpdateDialog(): React.ReactElement | null {
  const dialogOpen = useUpdateStore((s) => s.dialogOpen)
  const version = useUpdateStore((s) => s.version)
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

  if (!popoverLayer || !dialogOpen || !version) return null

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
            borderRadius: 16,
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ color: colors.accent, marginBottom: 4 }}>
            <ArrowCircleUp size={36} weight="fill" />
          </div>

          <div style={{ fontSize: 14, fontWeight: 600, color: colors.textPrimary, textAlign: 'center' }}>
            Ion {version} is ready
          </div>

          <div style={{ fontSize: 12, color: colors.textSecondary, textAlign: 'center', lineHeight: 1.5 }}>
            A new version has been downloaded. Restart to apply the update.
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 8, width: '100%' }}>
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
              Later
            </button>
            <button
              onClick={() => window.ion.installUpdate()}
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
              Install Now
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    popoverLayer,
  )
}
