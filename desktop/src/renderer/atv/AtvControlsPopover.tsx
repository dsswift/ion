/**
 * AtvControlsPopover — window-specific controls behind the TabStrip's ATV
 * button (mirror window only). Bespoke ATV widget by design: these are
 * canvas-coupled window controls (sound, office generator), not a shared
 * conversation surface — the Settings popover stays conversation settings.
 *
 * The office-generator cluster (seed, theme) is one layer deeper: an
 * expandable group that defaults to COLLAPSED — available to users who go
 * looking, never advertised.
 */
import React, { useRef, useState } from 'react'
import { CaretRight, Copy, ArrowClockwise, SpeakerHigh, SpeakerSlash } from '@phosphor-icons/react'
import { useViewportClamp } from '../hooks/useViewportClamp'
import { useColors } from '../theme'
import { useAtvControlsBus } from './state/controls-bus'

export function AtvControlsPopover(): React.JSX.Element | null {
  const colors = useColors()
  const bus = useAtvControlsBus()
  const ref = useRef<HTMLDivElement>(null)
  useViewportClamp(ref, bus.open)
  const [genOpen, setGenOpen] = useState(false)
  const [draftSeed, setDraftSeed] = useState<string | null>(null)

  if (!bus.open || !bus.anchor) return null
  const seedValue = draftSeed ?? bus.seed

  function applySeed(): void {
    if (draftSeed != null && draftSeed !== bus.seed) bus.actions?.applySeed(draftSeed)
    setDraftSeed(null)
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '6px 8px',
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    color: colors.textSecondary,
    fontSize: 12,
    cursor: 'pointer',
    textAlign: 'left',
  }

  return (
    <>
      {/* Click-away backdrop */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} onClick={bus.close} />
      <div
        ref={ref}
        style={{
          position: 'fixed',
          top: bus.anchor.y + 8,
          left: bus.anchor.x - 220,
          width: 260,
          zIndex: 91,
          background: colors.containerBg,
          border: `1px solid ${colors.containerBorder}`,
          borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
          padding: 8,
          pointerEvents: 'auto',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ padding: '2px 8px 8px', fontSize: 11, fontWeight: 600, color: colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          Visualizer
        </div>

        <button style={rowStyle} onClick={() => bus.actions?.toggleSound()}>
          {bus.soundOn ? <SpeakerHigh size={14} color={colors.accent} /> : <SpeakerSlash size={14} />}
          <span style={{ flex: 1 }}>Office sounds</span>
          <span style={{ color: bus.soundOn ? colors.accent : colors.textTertiary, fontSize: 11 }}>
            {bus.soundOn ? 'On' : 'Muted'}
          </span>
        </button>

        <div style={{ height: 1, background: colors.containerBorder, margin: '6px 4px' }} />

        {/* Office generator — deliberately collapsed by default. */}
        <button style={rowStyle} onClick={() => setGenOpen((v) => !v)}>
          <CaretRight
            size={12}
            style={{ transform: genOpen ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}
          />
          <span style={{ flex: 1 }}>Office generator</span>
        </button>
        {genOpen && (
          <div style={{ padding: '4px 8px 6px 26px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 10, color: colors.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {bus.tabLabel}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                value={seedValue}
                onChange={(e) => setDraftSeed(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') applySeed() }}
                onBlur={applySeed}
                spellCheck={false}
                placeholder="seed"
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: colors.containerBgCollapsed,
                  color: colors.textPrimary,
                  border: `1px solid ${colors.containerBorder}`,
                  borderRadius: 6,
                  padding: '3px 6px',
                  fontFamily: 'Menlo, Monaco, monospace',
                  fontSize: 11,
                }}
              />
              <button
                style={{ ...rowStyle, width: 24, padding: 4 }}
                title="Copy seed"
                onClick={() => { void navigator.clipboard.writeText(bus.seed) }}
              >
                <Copy size={13} />
              </button>
              <button
                style={{ ...rowStyle, width: 24, padding: 4 }}
                title="Reset to default seed"
                onClick={() => bus.actions?.resetSeed()}
              >
                <ArrowClockwise size={13} />
              </button>
            </div>
            <select
              value={bus.activeThemeId}
              onChange={(e) => bus.actions?.selectTheme(e.target.value)}
              style={{
                background: colors.containerBgCollapsed,
                color: colors.textPrimary,
                border: `1px solid ${colors.containerBorder}`,
                borderRadius: 6,
                fontSize: 11,
                padding: '3px 4px',
              }}
            >
              {bus.themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.builtin ? '' : ' (user)'}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </>
  )
}
