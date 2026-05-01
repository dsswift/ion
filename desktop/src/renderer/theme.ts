/**
 * Re-export hub for theme tokens + reactive color hook.
 *
 * Tokens (darkColors, lightColors, applyTheme, etc.) live in `theme-tokens.ts`
 * — a leaf module preferences.ts can import without creating a cycle. The
 * reactive `useColors`/`getColors` hook lives in preferences.ts (it reads the
 * Zustand store). Components keep importing from `./theme` for both kinds.
 */

export * from './theme-tokens'
export { useColors, getColors } from './preferences'
