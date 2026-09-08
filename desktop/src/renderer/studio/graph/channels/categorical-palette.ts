/**
 * The graph's categorical colour cycle, and the one place a community
 * number becomes a colour.
 *
 * The cycle is the palette's `graphCategorical*` tokens, tuned per theme
 * for the stage they draw on rather than borrowed from the UI icon accents
 * (which are saturated for 16px glyphs and read as candy at node scale),
 * followed by a second lightness step of the same hues. A corpus routinely
 * carries more distinct values than there are hues (twelve record types
 * against nine hues was the case that surfaced it), and a cycle that
 * wrapped silently made two values indistinguishable with no legend row
 * saying so. Eighteen appearances, then the tail is shown as unknown and
 * counted (see `channels/scales.ts`).
 *
 * Every consumer — the colour channel, the hull tint, the border-tint
 * ring, the legend — reads through here so a community is the same hue
 * everywhere it appears.
 */

import type { ColorPalette } from '../../../theme-tokens'
import { mixColors } from '../color-alpha'

/** How far the second step moves each hue toward the theme's text colour. */
const SECOND_STEP_MIX = 0.38

export function categoricalColorPalette(colors: ColorPalette): string[] {
  const base = [
    colors.graphCategorical1,
    colors.graphCategorical2,
    colors.graphCategorical3,
    colors.graphCategorical4,
    colors.graphCategorical5,
    colors.graphCategorical6,
    colors.graphCategorical7,
    colors.graphCategorical8,
    colors.graphCategorical9,
  ]
  return [...base, ...base.map((hue) => mixColors(hue, colors.textPrimary, SECOND_STEP_MIX))]
}

/** The colour a community is tinted with wherever it is drawn as a region. A negative community (none assigned) gets the unknown grey. */
export function communityColor(colors: ColorPalette, community: number): string {
  if (!Number.isInteger(community) || community < 0) return colors.graphUnknown
  const cycle = categoricalColorPalette(colors)
  return cycle[community % cycle.length]
}
