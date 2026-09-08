/**
 * GraphForcesPanel — the force-layout parameters as sliders, plus the two
 * presets. Each slider writes `forces` on the store; the canvas hands the
 * change to the warm engine and runs it so the shape follows the hand.
 *
 * The ranges are the useful band for a corpus of hundreds to a few
 * thousand documents: gravity from barely-there to the round shape other
 * graph tools default to, repulsion from a tight ball to a wide spread.
 * Forces travel with a saved view, so a corpus can ship its shape.
 */

import React from 'react'
import { useColors } from '../../theme'
import { useGraphStore } from './graph-store'
import { LAYOUT_FORCES_COMPACT, LAYOUT_FORCES_LOBES, type LayoutForces } from '../../../shared/graph-view-types'

interface SliderSpec {
  key: keyof LayoutForces
  label: string
  hint: string
  min: number
  max: number
  step: number
}

const SLIDERS: SliderSpec[] = [
  { key: 'gravity', label: 'Centre force', hint: 'Pull toward the middle. High values make a round, compact graph.', min: 0.01, max: 1, step: 0.01 },
  { key: 'scalingRatio', label: 'Repel force', hint: 'How far nodes push apart. High values spread the graph out.', min: 1, max: 20, step: 0.5 },
  { key: 'edgeWeightInfluence', label: 'Link force', hint: 'How strongly a link pulls its two ends together.', min: 0, max: 2, step: 0.1 },
  { key: 'damping', label: 'Damping', hint: 'Slows the simulation. High values settle slower but steadier.', min: 0.5, max: 3, step: 0.1 },
]

export const FORCE_PRESETS: { name: string; forces: LayoutForces; hint: string }[] = [
  { name: 'Lobes', forces: LAYOUT_FORCES_LOBES, hint: 'Communities as separate lobes with branches and peninsulas. The default.' },
  { name: 'Compact', forces: LAYOUT_FORCES_COMPACT, hint: 'A round, centre-pulled arrangement.' },
]

function sameForces(a: LayoutForces, b: LayoutForces): boolean {
  return a.gravity === b.gravity && a.scalingRatio === b.scalingRatio && a.edgeWeightInfluence === b.edgeWeightInfluence && a.damping === b.damping
}

export function GraphForcesPanel(): React.JSX.Element {
  const colors = useColors()
  const forces = useGraphStore((s) => s.forces)
  const setForces = useGraphStore((s) => s.setForces)

  const controlStyle: React.CSSProperties = {
    fontSize: 11,
    background: colors.surfaceSecondary,
    color: colors.textSecondary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 4,
    padding: '3px 8px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  }

  return (
    <div style={{ padding: '4px 12px 12px', fontFamily: 'system-ui, sans-serif', fontSize: 11 }}>
      <div style={{ fontWeight: 600, color: colors.textSecondary, marginBottom: 6 }}>Forces</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {FORCE_PRESETS.map((preset) => {
          const active = sameForces(forces, preset.forces)
          return (
            <button
              key={preset.name}
              title={preset.hint}
              onClick={() => setForces(preset.forces)}
              style={{ ...controlStyle, ...(active ? { color: colors.textPrimary, border: `1px solid ${colors.accentBorderMedium}`, background: colors.surfaceActive } : {}) }}
            >
              {preset.name}
            </button>
          )
        })}
      </div>
      {SLIDERS.map((spec) => (
        <label key={spec.key} title={spec.hint} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', color: colors.textSecondary }}>
          <span style={{ width: 84 }}>{spec.label}</span>
          <input
            type="range"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={forces[spec.key]}
            aria-label={spec.label}
            onChange={(e) => setForces({ ...forces, [spec.key]: Number(e.target.value) })}
            style={{ flex: 1 }}
          />
          <span style={{ width: 36, textAlign: 'right', color: colors.textTertiary, fontVariantNumeric: 'tabular-nums' }}>{forces[spec.key]}</span>
        </label>
      ))}
      <div style={{ color: colors.textTertiary, marginTop: 6 }}>Forces are saved with a view.</div>
    </div>
  )
}
