/**
 * The unbound edge tokens are opaque in every palette. Sigma composites
 * with premultiplied alpha, so a translucent token accumulates: twenty
 * edges over one pixel reached 92% of a pale blue and every hub drew as a
 * white fan. An opaque token cannot accumulate; alpha is reserved for the
 * states that genuinely mean "fainter" (the opacity channel, dimming).
 */
import { describe, expect, it } from 'vitest'
import { parseColor } from './color-alpha'
import { darkColors } from '../../theme/palette-dark'
import { lightColors } from '../../theme/palette-light'
import { classicColors } from '../../theme/palette-classic'
import { hudColors } from '../../theme/palette-hud'
import { contrastDarkColors } from '../../theme/palette-contrast-dark'
import { contrastLightColors } from '../../theme/palette-contrast-light'

const PALETTES = { dark: darkColors, light: lightColors, classic: classicColors, hud: hudColors, contrastDark: contrastDarkColors, contrastLight: contrastLightColors }

describe('graph edge tokens', () => {
  for (const [name, palette] of Object.entries(PALETTES)) {
    it(`${name}: default, mediated, and dangling edge tokens are opaque and distinct`, () => {
      for (const token of [palette.graphEdgeDefault, palette.graphEdgeMediated, palette.graphEdgeDangling]) {
        const parsed = parseColor(token)
        expect(parsed, token).not.toBeNull()
        expect(parsed!.a).toBe(1)
      }
      expect(new Set([palette.graphEdgeDefault, palette.graphEdgeMediated, palette.graphEdgeDangling]).size).toBe(3)
    })

    it(`${name}: the anchor class has its own colour, distinct from documents, topics, and sections`, () => {
      expect(new Set([palette.graphNodeDefault, palette.graphNodeGroup, palette.graphNodeAnchor, palette.graphNodeSection]).size).toBe(4)
    })
  }
})
