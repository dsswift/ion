/**
 * Palette-derived Shiki theme for conversation code blocks.
 *
 * Builds a Shiki `ThemeRegistration` from the active Ion palette's code
 * tokens, so syntax colors follow the theme (built-in or custom pack) instead
 * of a canned Shiki theme. The name is a stable hash of the token values —
 * codeHighlight.ts registers one theme per distinct palette and reuses it,
 * and the hash doubles as the cache key component that invalidates highlights
 * on theme switch.
 */

import type { ColorPalette } from '../../theme-tokens'

/** The palette keys a Shiki theme derives from (order matters for hashing). */
const CODE_TOKEN_KEYS = [
  'codeBg', 'textPrimary', 'codeKeyword', 'codeString', 'codeNumber',
  'codeComment', 'codeFunction', 'codeType', 'codeVariable', 'codeOperator',
] as const

/** Minimal structural type for a Shiki theme registration — kept local so
 * this module doesn't import shiki at build time (it stays lazy-loaded). */
export interface IonThemeRegistration {
  name: string
  type: 'dark' | 'light'
  colors: Record<string, string>
  settings: Array<{
    scope?: string[]
    settings: { foreground?: string; background?: string; fontStyle?: string }
  }>
}

/** djb2 — tiny, deterministic, good enough to key a handful of palettes. */
function hashTokens(values: string[]): string {
  let h = 5381
  const s = values.join('|')
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/** Stable per-palette theme name — same palette in, same name out. */
export function ionThemeName(colors: ColorPalette): string {
  return `ion-code-${hashTokens(CODE_TOKEN_KEYS.map((k) => colors[k]))}`
}

/**
 * Build the Shiki theme registration for a palette. TextMate scopes are
 * mapped onto the shared code tokens; anything unmapped falls back to the
 * global foreground (textPrimary).
 */
export function buildIonShikiTheme(
  colors: ColorPalette,
  scheme: 'dark' | 'light',
): IonThemeRegistration {
  return {
    name: ionThemeName(colors),
    type: scheme,
    colors: {
      'editor.background': colors.codeBg,
      'editor.foreground': colors.textPrimary,
    },
    settings: [
      // Global default — Shiki requires a scope-less first entry.
      { settings: { foreground: colors.textPrimary, background: colors.codeBg } },
      {
        scope: ['keyword', 'storage.type', 'storage.modifier', 'keyword.control'],
        settings: { foreground: colors.codeKeyword },
      },
      {
        scope: ['string', 'string.regexp', 'punctuation.definition.string'],
        settings: { foreground: colors.codeString },
      },
      {
        scope: ['constant.numeric', 'constant.language.boolean', 'constant.language'],
        settings: { foreground: colors.codeNumber },
      },
      {
        scope: ['comment', 'punctuation.definition.comment'],
        settings: { foreground: colors.codeComment, fontStyle: 'italic' },
      },
      {
        scope: ['entity.name.function', 'support.function', 'meta.function-call'],
        settings: { foreground: colors.codeFunction },
      },
      {
        scope: [
          'entity.name.type', 'entity.name.class', 'entity.name.namespace',
          'support.type', 'support.class',
        ],
        settings: { foreground: colors.codeType },
      },
      {
        scope: [
          'variable', 'variable.other.property', 'entity.other.attribute-name',
          'variable.parameter',
        ],
        settings: { foreground: colors.codeVariable },
      },
      {
        scope: ['keyword.operator', 'punctuation'],
        settings: { foreground: colors.codeOperator },
      },
      // Markup tags read as keywords (HTML/JSX/XML).
      {
        scope: ['entity.name.tag', 'punctuation.definition.tag'],
        settings: { foreground: colors.codeKeyword },
      },
    ],
  }
}
