/**
 * Ion Contrast Dark palette — desktop half of the high-contrast dark theme,
 * the desktop counterpart to iOS `IonContrastDarkTheme`. Forced dark scheme.
 *
 * Built by spreading `darkColors` and overriding only the tokens the shared
 * parity fixture pins (`assets/theme-parity.json` → the 30 iOS AppTheme tokens
 * mapped onto their desktop ColorPalette keys). Every override value is the
 * ratified contrast hex from the iOS style guide Section 5 / palette-additions.
 *
 * The many desktop-only tokens the iOS palette has no counterpart for
 * (container shadows, ANSI terminal palette, git file-status colors, tab
 * waiting-state glows, permission-card families, diff colors, file-type icons)
 * inherit the Ion Dark values through the spread. The guide never priced them
 * for the contrast pair and the fixture does not pin them, so inheriting the
 * base dark values is the correct, honest mapping rather than an invented one.
 *
 * Key set matches `darkColors` exactly (via spread), satisfying
 * palette-parity's identical-key-set contract.
 */

import { darkColors, type ColorPalette } from './palette-dark'

export const contrastDarkColors: ColorPalette = {
  ...darkColors,

  // Surfaces + base (ratified). background→containerBg,
  // surfaceElevated→surfacePrimary, surfaceSunken→containerBgCollapsed.
  containerBg: '#000000',
  containerBgCollapsed: '#0b0b0d',
  surfacePrimary: '#141418',
  surfaceSecondary: '#202126',

  // Text
  textPrimary: '#ffffff',
  textSecondary: '#d7d7de',
  textTertiary: '#bdbdc7',

  // Accent (accentSubtle→accentLight, accentGlow→accentSoft). Alpha 0.12/0.18
  // resolve to the same 0x1F/0x2E bytes the iOS opacity-derived values produce.
  accent: '#80a7ff',
  accentLight: 'rgba(128, 167, 255, 0.12)',
  accentSoft: 'rgba(128, 167, 255, 0.18)',

  // borderSubtle is an OPAQUE tone-backed hairline in the contrast palette
  // (2.93:1), not the base theme's 6%-white overlay.
  borderSubtle: '#5e6068',

  // Status (statusDone→statusComplete, statusPending & statusIdle→statusIdle).
  statusRunning: '#ff9a70',
  statusComplete: '#5ce6ae',
  statusError: '#ff7b7b',
  statusIdle: '#bdbdc7',
  statusWaitingChildren: '#ffd45a',
  statusBash: '#ff6eb4',
  statusWarning: '#ffc14d',
  statusQuestion: '#c3a6ff',
  worktreeDirty: '#ff9a70',

  // Code (userBubbleTint→userBubble). Syntax tokens reuse the Ion Dark values
  // via the spread — identical to what iOS IonContrastDarkTheme carries.
  codeBg: '#0b0b0d',
  userBubble: '#202126',
}
