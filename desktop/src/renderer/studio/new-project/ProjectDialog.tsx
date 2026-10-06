/** ProjectDialog — the modal the new-project and clone-to-servers flows share: a titled card over a scrim, with its buttons pinned at the bottom. */
import React from 'react'
import { createPortal } from 'react-dom'
import { useColors } from '../../theme'
import { usePopoverLayer } from '../../components/PopoverLayer'
import { useEscapeLayer } from '../../components/settings/kit'

export interface ProjectDialogProps {
  title: string
  subtitle?: string
  footer: React.ReactNode
  onClose(): void
  children: React.ReactNode
}

export function ProjectDialog({ title, subtitle, footer, onClose, children }: ProjectDialogProps): React.JSX.Element {
  const colors = useColors()
  const layer = usePopoverLayer()
  useEscapeLayer(true, onClose)
  const dialog = (
    <div data-ion-ui role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 10001, pointerEvents: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: 'max(16px, 10vh) 16px 16px', boxSizing: 'border-box', background: colors.scrim }}>
      <div style={{ width: 480, maxWidth: '100%', maxHeight: '100%', minWidth: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: colors.popoverBg, border: `1px solid ${colors.popoverBorder}`, borderRadius: 12, boxShadow: colors.popoverShadow }}>
        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${colors.popoverBorder}` }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.textPrimary }}>{title}</div>
          {subtitle && <div style={{ marginTop: 2, fontSize: 11, color: colors.textTertiary }}>{subtitle}</div>}
        </div>
        <div style={{ padding: 14, overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '10px 14px', borderTop: `1px solid ${colors.popoverBorder}` }}>{footer}</div>
      </div>
    </div>
  )
  return layer ? createPortal(dialog, layer) : dialog
}
