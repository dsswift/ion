/**
 * Fallback sources for role-specific palette tokens.
 *
 * Each key is a token that names one specific pairing; its value is the
 * broader token a theme pack's color is taken from when the pack does not set
 * the key itself. A pack that sets only the source keeps one color across
 * both; a pack that sets the key controls that pairing on its own.
 *
 * One level deep: a fallback source is never itself a key here.
 */

import type { ColorPalette } from '@ion/server/renderer/theme/palette-dark'

export const TOKEN_FALLBACKS = {
  textOnSurface: 'textOnAccent',
  textOnSurfaceMuted: 'textOnAccentMuted',
  textOnDanger: 'textOnAccent',
  textOnDangerMuted: 'textOnAccentMuted',
  textOnWarning: 'textOnAccent',
  textOnWarningMuted: 'textOnAccentMuted',
  textOnInfo: 'containerBg',
  textOnRunning: 'textPrimary',
  sendFg: 'textOnAccent',
  sendPressed: 'accentPressed',
  agentPillText: 'textOnAccent',
} as const satisfies Partial<Record<keyof ColorPalette, keyof ColorPalette>>
