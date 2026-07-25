/**
 * Ion Design Tokens — theme registry and utilities.
 *
 * Palettes live in `theme/palette-{dark,light,classic,hud}.ts`; this module
 * re-exports them alongside the registry, CSS-variable sync, and non-color
 * scales.
 *
 * Theme selection is single-axis: every built-in theme declares its color
 * scheme via `forcedColorScheme`, and the theme picker is the only control.
 * There is no separate dark/light mode toggle.
 *
 * Leaf module: imports nothing from preferences. Importing from theme.ts
 * brings these in along with the reactive `useColors` hook; importing here
 * directly avoids the preferences ↔ theme cycle.
 */

import { darkColors, type ColorPalette } from './theme/palette-dark'
import { lightColors } from './theme/palette-light'
import { classicColors } from './theme/palette-classic'
import { hudColors } from './theme/palette-hud'
import type { CustomThemeForRenderer } from '../shared/theme-pack-types'

export { darkColors, lightColors, classicColors, hudColors }
export type { ColorPalette }

// ─── Theme utilities ───

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}

export function syncTokensToCss(tokens: ColorPalette): void {
  const style = document.documentElement.style
  for (const [key, value] of Object.entries(tokens)) {
    style.setProperty(`--ion-${camelToKebab(key)}`, value)
  }
}

/** The color scheme a theme renders: its declared scheme, else derived from
 * which palette it carries (defensive fallback for a malformed registry
 * entry — every built-in declares `forcedColorScheme`). */
export function themeScheme(theme: ThemeDefinition): 'dark' | 'light' {
  return theme.forcedColorScheme ?? (theme.colors === lightColors ? 'light' : 'dark')
}

/** Apply a theme by id: sync its palette to CSS variables, set the
 * dark/light root classes from the theme's scheme, and set/clear the
 * theme background image var consumed by `.ion-theme-backdrop`. */
export function applyTheme(themeId: string): void {
  const theme = getTheme(themeId)
  const isDark = themeScheme(theme) === 'dark'
  document.documentElement.classList.toggle('dark', isDark)
  document.documentElement.classList.toggle('light', !isDark)
  syncTokensToCss(theme.colors)
  const style = document.documentElement.style
  if (theme.backgroundImageUrl) {
    style.setProperty('--ion-theme-background-image', `url("${theme.backgroundImageUrl}")`)
  } else {
    style.removeProperty('--ion-theme-background-image')
  }
}

// ─── Theme registry ───

export interface ThemeDefinition {
  id: string
  displayName: string
  colors: ColorPalette
  forcedColorScheme?: 'light' | 'dark'
  /** True for disk-loaded theme packs (absent on built-ins). */
  custom?: boolean
  /** Data URL of the pack's background asset, rendered by `.ion-theme-backdrop`. */
  backgroundImageUrl?: string
  /** Data URL of the pack's logo asset, shown in Settings → Appearance. */
  logoUrl?: string
}

export const themes: ThemeDefinition[] = [
  { id: 'ion-dark',    displayName: 'Ion Dark',    colors: darkColors,    forcedColorScheme: 'dark' },
  { id: 'ion-light',   displayName: 'Ion Light',   colors: lightColors,   forcedColorScheme: 'light' },
  { id: 'ion-classic', displayName: 'Ion Classic', colors: classicColors, forcedColorScheme: 'dark' },
  { id: 'jarvis-hud',  displayName: 'Jarvis HUD',  colors: hudColors,     forcedColorScheme: 'dark' },
]

// Custom themes are loaded from theme packs on disk (main process scans
// ~/.ion/themes + the system root, renderer receives them via IPC at boot
// and via the ion:themes-changed push). Module-level so the registry stays
// a leaf — the store subscribes through onThemeRegistryChanged.
let customThemes: ThemeDefinition[] = []
const registryListeners = new Set<() => void>()

/** Resolve one pack payload into a full ThemeDefinition: the base built-in
 * palette filled with the pack's token overlay. Only known ColorPalette
 * keys are applied (the loader validates, this stays defensive). */
export function resolveCustomThemeDefinition(t: CustomThemeForRenderer): ThemeDefinition {
  const base = themes.find((b) => b.id === t.base) ?? themes[0]
  // ColorPalette is homomorphic over the as-const dark palette, so its
  // properties are readonly — build through a mutable record, then narrow.
  const colors: Record<string, string> = { ...base.colors }
  for (const key of Object.keys(colors)) {
    const v = t.tokens[key]
    if (typeof v === 'string') colors[key] = v
  }
  return {
    id: t.id,
    displayName: t.name,
    colors: colors as ColorPalette,
    forcedColorScheme: t.forcedColorScheme ?? base.forcedColorScheme,
    custom: true,
    ...(t.backgroundDataUrl ? { backgroundImageUrl: t.backgroundDataUrl } : {}),
    ...(t.logoDataUrl ? { logoUrl: t.logoDataUrl } : {}),
  }
}

/** Replace the custom-theme set (wholesale — snapshot semantics) and notify
 * subscribers so pickers re-render and the active theme re-applies. */
export function registerCustomThemes(payloads: CustomThemeForRenderer[]): void {
  customThemes = payloads.map(resolveCustomThemeDefinition)
  for (const listener of registryListeners) listener()
}

/** Built-ins followed by installed custom themes (picker order). */
export function getAllThemes(): ThemeDefinition[] {
  return [...themes, ...customThemes]
}

/** Subscribe to registry changes (custom-theme set replaced). */
export function onThemeRegistryChanged(listener: () => void): () => void {
  registryListeners.add(listener)
  return () => registryListeners.delete(listener)
}

export function getTheme(id: string): ThemeDefinition {
  return themes.find((t) => t.id === id)
    ?? customThemes.find((t) => t.id === id)
    ?? themes[0]  // Defaults to ion-dark (also covers a stale custom id)
}

/** Returns the color palette for the given theme id (unknown ids fall back
 * to the default Ion Dark theme). */
export function resolveColors(selectedTheme: string): ColorPalette {
  return getTheme(selectedTheme).colors
}

// Legacy static export — components migrating to useColors() may still read this.
export const colors = darkColors

// ─── Spacing ───

export const spacing = {
  contentWidth: 460,
  containerRadius: 20,
  containerPadding: 12,
  tabHeight: 32,
  inputMinHeight: 44,
  inputMaxHeight: 160,
  conversationMaxHeight: 380,
  pillRadius: 9999,
  circleSize: 36,
  circleGap: 8,
} as const

// ─── Radius scale ───
// Standard corner radii for chrome elements. The pill/circle shapes
// (spacing.pillRadius, spacing.containerRadius) are layout constants above.

export const radius = {
  sm: 6,
  md: 8,
  lg: 10,
  xl: 14,
} as const

// ─── Transition timing ───
// Standard durations for interactive-state changes. Use `base` for
// hover/pressed/focus color and background shifts; `fast` for small
// glyph movement (chevron rotation); `slow` for panel-level changes.

export const transitions = {
  fast: '120ms ease',
  base: '150ms ease',
  slow: '250ms ease',
} as const

// ─── Animation ───

export const motion = {
  spring: { type: 'spring' as const, stiffness: 500, damping: 30 },
  easeOut: { duration: 0.2, ease: [0.25, 0.46, 0.45, 0.94] as const },
  fadeIn: {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -4 },
    transition: { duration: 0.15 },
  },
} as const
