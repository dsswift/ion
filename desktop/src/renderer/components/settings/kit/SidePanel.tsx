/**
 * SidePanel — the detail panel that slides over the right of the Settings
 * content. Every add, edit, test, and sign-in flow opens here, so a list
 * never grows an inline form that pushes the page down.
 *
 * The dialog provides the host element (`SidePanelHostProvider`). With no
 * host (a page rendered on its own, as in a unit test) the panel renders in
 * place, so a page never needs to know which it got.
 */
import React, { createContext, useContext } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X } from '@phosphor-icons/react'
import { useColors } from '../../../theme'
import { IconButton } from './controls'
import { useEscapeLayer } from './escape-stack'
import { KIT } from './tokens'

const SidePanelHostContext = createContext<HTMLElement | null>(null)

export function SidePanelHostProvider({ host, children }: { host: HTMLElement | null; children: React.ReactNode }): React.JSX.Element {
  return <SidePanelHostContext.Provider value={host}>{children}</SidePanelHostContext.Provider>
}

export interface SidePanelProps {
  open: boolean
  title: string
  subtitle?: React.ReactNode
  onClose(): void
  /** Buttons pinned to the bottom of the panel. */
  footer?: React.ReactNode
  children: React.ReactNode
}

export function SidePanel({ open, title, subtitle, onClose, footer, children }: SidePanelProps): React.JSX.Element | null {
  const colors = useColors()
  const host = useContext(SidePanelHostContext)
  useEscapeLayer(open, onClose)
  if (!open) return null
  const panel = <SidePanelBody title={title} subtitle={subtitle} onClose={onClose} footer={footer} docked={host !== null}>{children}</SidePanelBody>
  if (!host) return panel
  return createPortal(
    <div style={{ position: 'absolute', inset: 0, zIndex: 5, display: 'flex', justifyContent: 'flex-end', pointerEvents: 'auto' }}>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} onClick={onClose} style={{ position: 'absolute', inset: 0, background: colors.scrim }} />
      {panel}
    </div>,
    host,
  )
}

function SidePanelBody({ title, subtitle, onClose, footer, docked, children }: Omit<SidePanelProps, 'open'> & { docked: boolean }): React.JSX.Element {
  const colors = useColors()
  return (
    <motion.aside
      role="dialog"
      aria-label={title}
      initial={docked ? { x: 24, opacity: 0 } : false}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.18, ease: [0.4, 0, 0.1, 1] }}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: docked ? 'relative' : 'static', width: docked ? `min(${KIT.panelWidth}px, 100%)` : '100%', height: docked ? '100%' : undefined,
        display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
        background: colors.containerBg, borderLeft: docked ? `1px solid ${colors.containerBorder}` : undefined,
        border: docked ? undefined : `1px solid ${colors.containerBorder}`, borderRadius: docked ? 0 : KIT.groupRadius,
        boxShadow: docked ? colors.popoverShadow : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '14px 16px 10px', borderBottom: `1px solid ${colors.borderSubtle}` }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.textPrimary }}>{title}</div>
          {subtitle && <div style={{ fontSize: KIT.fontTiny, color: colors.textTertiary, marginTop: 2, lineHeight: 1.4 }}>{subtitle}</div>}
        </div>
        <IconButton icon={X} label="Close panel" onClick={onClose} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>{children}</div>
      {footer && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '10px 16px', borderTop: `1px solid ${colors.borderSubtle}` }}>{footer}</div>}
    </motion.aside>
  )
}
