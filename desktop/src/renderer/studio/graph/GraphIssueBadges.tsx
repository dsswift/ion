/**
 * GraphIssueBadges — broken-links and identity-collision badges. Absent
 * (not disabled) at zero, per the design's "no permanent real estate"
 * rule. Clicking opens an ephemeral popover listing every entry with a
 * jump-to-source action; there is no docked panel.
 */

import React, { useState } from 'react'
import { useColors } from '../../theme'
import { usePopoverLayer } from '../../components/PopoverLayer'
import { createPortal } from 'react-dom'
import { useGraphStore } from './graph-store'

function Badge({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  const colors = useColors()
  return (
    <button
      onClick={onClick}
      style={{
        padding: '3px 8px',
        borderRadius: 6,
        background: colors.surfaceSecondary,
        border: `1px solid ${colors.containerBorder}`,
        color: colors.textSecondary,
        fontSize: 11,
        fontFamily: 'system-ui, sans-serif',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

export function GraphIssueBadges(): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const model = useGraphStore((s) => s.model)
  const selectNode = useGraphStore((s) => s.selectNode)
  const sectionScopeNotice = useGraphStore((s) => s.sectionScopeNotice)
  const [openPopover, setOpenPopover] = useState<'dangling' | 'collisions' | null>(null)

  if (!model) return null
  const danglingCount = model.dangling.length
  const collisionCount = model.identityCollisions.length
  // The section notice shares this row, so it also keeps the row alive: a
  // corpus with no broken links and no collisions still has to be able to
  // say why the sections it was asked for are not there.
  if (danglingCount === 0 && collisionCount === 0 && !sectionScopeNotice) return null

  const popoverStyle: React.CSSProperties = {
    // Corner-pinned at fixed bottom/right offsets with a fixed width, like a
    // toast — never measured from a trigger position, so it can never
    // overflow the viewport regardless of window size.
    // viewport-ok: corner-pinned toast, never measured from a trigger
    position: 'fixed',
    bottom: 40,
    right: 8,
    width: 280,
    maxHeight: 240,
    overflowY: 'auto',
    background: colors.popoverBg,
    border: `1px solid ${colors.popoverBorder}`,
    borderRadius: 8,
    boxShadow: colors.popoverShadow,
    padding: 8,
    fontSize: 11,
    fontFamily: 'system-ui, sans-serif',
    zIndex: 99999,
    pointerEvents: 'auto',
  }

  const popover =
    openPopover === 'dangling' ? (
      <div style={popoverStyle} data-ion-ui>
        {model.dangling.map((d, i) => (
          <div key={i} style={{ padding: '3px 0', borderBottom: `1px solid ${colors.containerBorder}`, color: colors.textSecondary }}>
            <div>{d.rawTarget}</div>
            <button
              onClick={() => {
                selectNode(d.sourceId)
                setOpenPopover(null)
              }}
              style={{ background: 'none', border: 'none', color: colors.accent, cursor: 'pointer', padding: 0, fontSize: 11 }}
            >
              Jump to source
            </button>
          </div>
        ))}
      </div>
    ) : openPopover === 'collisions' ? (
      <div style={popoverStyle} data-ion-ui>
        {model.identityCollisions.map((c, i) => (
          <div key={i} style={{ padding: '3px 0', borderBottom: `1px solid ${colors.containerBorder}`, color: colors.textSecondary }}>
            <div>{c.identity}</div>
            <div style={{ color: colors.textTertiary }}>{c.loserPaths.length} conflicting document(s)</div>
          </div>
        ))}
      </div>
    ) : null

  return (
    <>
      <div style={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', gap: 6 }}>
        {danglingCount > 0 && <Badge label={`${danglingCount} broken links`} onClick={() => setOpenPopover(openPopover === 'dangling' ? null : 'dangling')} />}
        {collisionCount > 0 && <Badge label={`${collisionCount} identity collisions`} onClick={() => setOpenPopover(openPopover === 'collisions' ? null : 'collisions')} />}
        {/* Sections were asked for and withheld. Saying so is what keeps
            the toggle from reading as broken; the remedy is in the label
            rather than in a popover, because there is nothing to list. */}
        {sectionScopeNotice && (
          <span
            title={`Sections decompose the documents in view. The ${sectionScopeNotice.documentCount} documents in scope carry ${sectionScopeNotice.sectionCount} sections and the budget is ${sectionScopeNotice.budget}. Narrow to a neighbourhood or add a filter.`}
            style={{ padding: '3px 8px', borderRadius: 6, background: colors.surfaceSecondary, border: `1px solid ${colors.containerBorder}`, color: colors.textTertiary, fontSize: 11, fontFamily: 'system-ui, sans-serif' }}
          >
            Sections need a narrower scope
          </span>
        )}
      </div>
      {popover && layer ? createPortal(popover, layer) : popover}
    </>
  )
}
