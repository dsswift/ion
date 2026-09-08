/**
 * Alpha compositing for palette colors. Sigma's edge and node display data
 * carry a `color` string and no separate opacity, so any channel or state
 * that means "draw this fainter" — the edge-opacity encoding, dimming
 * non-neighbours of a selection — has to ride the color's alpha byte.
 *
 * Palette tokens arrive as three-, six-, or eight-digit hex, or as the CSS
 * rgb / rgba functions; anything else is returned unchanged so an unexpected
 * token degrades to "not dimmed" rather than to an invalid color Sigma
 * would reject.
 */

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const RGBA_RE = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/** Parse a palette color into its channels, or null when the form is unknown. */
export function parseColor(color: string): { r: number; g: number; b: number; a: number } | null {
  const hex = HEX_RE.exec(color.trim())
  if (hex) {
    let h = hex[1]
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return { r, g, b, a }
  }
  const rgba = RGBA_RE.exec(color.trim())
  if (rgba) {
    return {
      r: parseInt(rgba[1], 10),
      g: parseInt(rgba[2], 10),
      b: parseInt(rgba[3], 10),
      a: rgba[4] === undefined ? 1 : parseFloat(rgba[4]),
    }
  }
  return null
}

/**
 * Replace the color's alpha with `alpha` (0..1). The result is always the
 * CSS rgba function form, which every consumer here (Sigma, canvas 2D) accepts.
 */
export function withAlpha(color: string, alpha: number): string {
  const parsed = parseColor(color)
  if (!parsed) return color
  const a = clamp01(Number.isFinite(alpha) ? alpha : 1)
  return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${Number(a.toFixed(3))})` // hardcoded-ok: re-emits the caller's palette token with a new alpha
}

/**
 * Multiply the color's existing alpha by `factor` (0..1). Used for dimming,
 * where a token that is already translucent should get fainter still rather
 * than snap to a fixed alpha.
 */
export function scaleAlpha(color: string, factor: number): string {
  const parsed = parseColor(color)
  if (!parsed) return color
  return withAlpha(color, parsed.a * clamp01(factor))
}

/**
 * Mix `color` toward `toward` by `t` (0 keeps the color, 1 is `toward`),
 * preserving the color's own alpha. Used to derive a second lightness step
 * of a categorical hue: mixing toward the theme's text color lightens on a
 * dark stage and darkens on a light one, so the step reads as a variant of
 * the hue rather than a different hue on either.
 */
export function mixColors(color: string, toward: string, t: number): string {
  const a = parseColor(color)
  const b = parseColor(toward)
  if (!a || !b) return color
  const k = clamp01(Number.isFinite(t) ? t : 0)
  const mix = (x: number, y: number): number => Math.round(x + (y - x) * k)
  return `rgba(${mix(a.r, b.r)}, ${mix(a.g, b.g)}, ${mix(a.b, b.b)}, ${Number(a.a.toFixed(3))})` // hardcoded-ok: re-emits the caller's palette tokens blended
}
