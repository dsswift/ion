/**
 * Ion Contrast Light palette — desktop half of the high-contrast light theme,
 * the desktop counterpart to iOS `IonContrastLightTheme`. Forced light scheme.
 *
 * Built by spreading `lightColors` and overriding only the tokens the shared
 * parity fixture pins. Every override value is the ratified contrast hex from
 * the iOS style guide Section 5 / palette-additions.
 *
 * Desktop-only tokens with no iOS contrast counterpart (shadows, ANSI, git,
 * tab glows, permission families, diff, icons) inherit the Ion Light values
 * through the spread — the correct mapping, since the guide never priced them
 * for the contrast pair and the fixture does not pin them.
 *
 * Key set matches `darkColors`/`lightColors` exactly (via spread).
 */

import { lightColors } from './palette-light'
import { type ColorPalette } from './palette-dark'

export const contrastLightColors: ColorPalette = {
  ...lightColors,

  // Surfaces + base (ratified).
  containerBg: '#ffffff',
  containerBgCollapsed: '#f5f5f7',
  surfacePrimary: '#f0f1f4',
  surfaceSecondary: '#e4e5ea',

  // Text
  textPrimary: '#121318',
  textSecondary: '#303139',
  textTertiary: '#4b4d57',

  // Accent (alpha 0.10/0.14 resolve to the 0x1A/0x24 bytes iOS produces).
  accent: '#1248c6',
  accentLight: 'rgba(18, 72, 198, 0.10)',
  accentSoft: 'rgba(18, 72, 198, 0.14)',

  // borderSubtle: opaque tone-backed hairline (2.96:1).
  borderSubtle: '#8a8c96',

  // Status.
  statusRunning: '#a23d18',
  statusComplete: '#006b45',
  statusError: '#b42318',
  statusIdle: '#4b4d57',
  statusWaitingChildren: '#785a00',
  statusBash: '#b0005a',
  statusWarning: '#8a4b00',
  statusQuestion: '#5930a5',
  worktreeDirty: '#b42318',

  // Code. Syntax tokens reuse Ion Light via the spread.
  codeBg: '#f5f5f7',
  userBubble: '#e4e5ea',
}
