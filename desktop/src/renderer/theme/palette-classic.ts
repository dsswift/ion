/**
 * Ion Classic palette — the original Ion look: warm gray surfaces with the
 * orange accent. Forced dark scheme.
 *
 * FULLY SELF-CONTAINED preservation palette: every key is pinned explicitly
 * so evolution of Ion Dark can never alter the classic look. Values for
 * tokens introduced after the blue-neutral redesign (focus, pressed, drag,
 * git, icons, ANSI, …) pin what the equivalent surfaces rendered in the
 * classic era. Freeze-tested in palette-parity.test.ts.
 */

import type { ColorPalette } from './palette-dark'

export const classicColors: ColorPalette = {
  // Container (glass surfaces)
  containerBg: '#242422',
  containerBgCollapsed: '#21211e',
  containerBorder: '#3b3b36',
  containerShadow: '0 8px 28px rgba(0, 0, 0, 0.35), 0 1px 6px rgba(0, 0, 0, 0.25)',
  cardShadow: '0 2px 8px rgba(0,0,0,0.35)',
  cardShadowCollapsed: '0 2px 6px rgba(0,0,0,0.4)',

  // Surface layers
  surfacePrimary: '#353530',
  surfaceSecondary: '#42423d',
  surfaceHover: 'rgba(255, 255, 255, 0.05)',
  surfaceActive: 'rgba(255, 255, 255, 0.08)',

  // Input
  inputBg: 'transparent',
  inputBorder: '#3b3b36',
  inputFocusBorder: 'rgba(217, 119, 87, 0.4)',
  inputPillBg: '#2a2a27',

  // Text
  textPrimary: '#ccc9c0',
  textSecondary: '#c0bdb2',
  textTertiary: '#76766e',
  textMuted: '#353530',

  // Accent — orange
  accent: '#d97757',
  accentHover: '#c96442',
  accentPressed: '#b5583a',
  accentLight: 'rgba(217, 119, 87, 0.1)',
  accentSoft: 'rgba(217, 119, 87, 0.15)',

  // Focus (keyboard focus-visible ring + focused input shell)
  focusBorder: '#d97757',
  focusRing: 'rgba(217, 119, 87, 0.24)',

  // Interaction layers
  surfacePressed: 'rgba(255, 255, 255, 0.10)',
  surfaceSelected: 'rgba(255, 255, 255, 0.05)',
  borderSubtle: '#3b3b36',

  // Drag & drop
  dragOverBg: 'rgba(217, 119, 87, 0.10)',
  dragOverBorder: 'rgba(217, 119, 87, 0.45)',
  dragInsertIndicator: '#d97757',

  // Bash-mode input ring — the classic-era pink
  bashModeRing: 'rgba(244, 114, 182, 0.5)',

  // Status dots
  statusIdle: '#8a8a80',
  statusRunning: '#d97757',
  statusRunningBg: 'rgba(217, 119, 87, 0.1)',
  statusCompacting: '#60a5fa',
  statusCompactingBg: 'rgba(96, 165, 250, 0.1)',
  statusComplete: '#7aac8c',
  statusCompleteBg: 'rgba(122, 172, 140, 0.1)',
  statusError: '#c47060',
  statusErrorBg: 'rgba(196, 112, 96, 0.08)',
  statusWarning: '#f59e0b',
  statusDead: '#c47060',
  // Shell-activity dot — see palette-dark.ts for the rationale. Classic's
  // language is muted and earthy (statusRunning #d97757, statusError #c47060),
  // so this is a saturated pink rather than the neon blaze the dark themes
  // use: bright enough to read as pink at 6px (the previous #cc6b9a read as
  // washed-out mauve) without breaking the theme's register, and clearly
  // separated from the terracotta error/permission tones.
  statusBash: '#e0559b',
  statusBashGlow: 'rgba(224, 85, 155, 0.4)',
  statusPermission: '#d97757',
  statusPermissionGlow: 'rgba(217, 119, 87, 0.4)',
  // Amber "awaiting children" — distinct from the orange running dot so a
  // glance tells foreground from background work (the classic vocabulary).
  statusWaitingChildren: '#f59e0b',
  statusWaitingChildrenGlow: 'rgba(245, 158, 11, 0.4)',
  // Question dot — matches this theme's existing info blue (unchanged look).
  statusQuestion: 'rgba(96, 165, 250, 0.85)',

  // Tab
  tabActive: '#353530',
  tabActiveBorder: '#4a4a45',
  tabInactive: 'transparent',
  tabHover: 'rgba(255, 255, 255, 0.05)',

  // User message bubble
  userBubble: '#353530',
  userBubbleBorder: '#4a4a45',
  userBubbleText: '#ccc9c0',

  // Tool card
  toolBg: '#353530',
  toolBorder: '#4a4a45',
  toolRunningBorder: 'rgba(217, 119, 87, 0.3)',
  toolRunningBg: 'rgba(217, 119, 87, 0.05)',

  // Timeline
  timelineLine: '#353530',
  timelineNode: 'rgba(217, 119, 87, 0.2)',
  timelineNodeActive: '#d97757',
  timelineSlashCommand: '#A855F7',
  timelineSlashCommandActive: '#C084FC',

  // Scrollbar
  scrollThumb: 'rgba(255, 255, 255, 0.15)',
  scrollThumbHover: 'rgba(255, 255, 255, 0.25)',

  // Stop button
  stopBg: '#ef4444',
  stopHover: '#dc2626',

  // Send button
  sendBg: '#d97757',
  sendHover: '#c96442',
  sendDisabled: 'rgba(217, 119, 87, 0.3)',

  // Modal backdrop scrim
  scrim: 'rgba(0, 0, 0, 0.4)',

  // Popover
  popoverBg: '#292927',
  popoverBorder: '#3b3b36',
  popoverShadow: '0 4px 20px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.2)',

  // Code block
  codeBg: '#1a1a18',
  // Inline `code` chip — neutral subtle surface (not the accent tint).
  inlineCodeBg: 'rgba(255, 255, 255, 0.06)',

  // Mic button
  micBg: '#353530',
  micHover: '#3e3e39',
  micPressed: '#474741',
  micColor: '#c0bdb2',
  micDisabled: '#42423d',

  // Placeholder
  placeholder: '#6b6b60',

  // Disabled button color
  btnDisabled: '#42423d',

  // Text on accent backgrounds
  textOnAccent: '#ffffff',
  textOnAccentMuted: 'rgba(255, 255, 255, 0.7)',

  // Button hover (CSS-only stack buttons)
  btnHoverColor: '#c0bdb2',
  btnHoverBg: '#302f2d',

  // Accent border variants
  accentBorder: 'rgba(217, 119, 87, 0.19)',
  accentBorderMedium: 'rgba(217, 119, 87, 0.25)',

  // Semantic foregrounds — the classic status hues
  infoFg: '#60a5fa',
  successFg: '#7aac8c',
  warningFg: '#f59e0b',
  dangerFg: '#c47060',

  // Permission card (amber)
  permissionBorder: 'rgba(245, 158, 11, 0.3)',
  permissionShadow: '0 2px 12px rgba(245, 158, 11, 0.08)',
  permissionHeaderBg: 'rgba(245, 158, 11, 0.06)',
  permissionHeaderBorder: 'rgba(245, 158, 11, 0.12)',

  // Permission allow (green)
  permissionAllowBg: 'rgba(34, 197, 94, 0.1)',
  permissionAllowHoverBg: 'rgba(34, 197, 94, 0.22)',
  permissionAllowBorder: 'rgba(34, 197, 94, 0.25)',

  // Permission deny (red)
  permissionDenyBg: 'rgba(239, 68, 68, 0.08)',
  permissionDenyHoverBg: 'rgba(239, 68, 68, 0.18)',
  permissionDenyBorder: 'rgba(239, 68, 68, 0.22)',

  // Permission denied card
  permissionDeniedBorder: 'rgba(196, 112, 96, 0.3)',
  permissionDeniedHeaderBorder: 'rgba(196, 112, 96, 0.12)',

  // Info / question card (blue)
  infoBg: 'rgba(96, 165, 250, 0.1)',
  infoHoverBg: 'rgba(96, 165, 250, 0.15)',
  infoBorder: 'rgba(96, 165, 250, 0.25)',
  infoText: 'rgba(96, 165, 250, 0.85)',
  infoShadow: 'rgba(96, 165, 250, 0.06)',

  // Tab waiting-state glows
  tabGlowPlanReady: 'rgba(122, 172, 140, 0.5)',
  tabGlowPlanReadyShadow: 'rgba(122, 172, 140, 0.25)',
  tabGlowQuestion: 'rgba(96, 165, 250, 0.5)',
  tabGlowQuestionShadow: 'rgba(96, 165, 250, 0.25)',

  // Git file status — the classic-era colors
  gitAdded: '#7aac8c',
  gitModified: '#6b9bd2',
  gitDeleted: '#c47060',
  gitRenamed: '#b08fd8',
  gitUntracked: '#d4a843',
  gitConflict: '#d97757',

  // Worktree branch indicator
  worktreeGreen: '#4ade80',
  /**
   * Unlanded-commit count on a worktree row.
   *
   * Deliberately NOT worktreeGreen. Green is the panel's ATTENTION colour --
   * the dirty dot and the reviewed-good check both use it -- and the commit
   * counts wearing it made them the first thing the eye landed on. They are
   * a fact worth reading, not the most urgent one in the row. A subdued
   * violet stays legible without competing for first glance.
   */
  unlandedCount: '#a78bfa',

  /**
   * Uncommitted changes in a worktree.
   *
   * Rendered as a small `!` rather than a filled shape, which is what lets it
   * borrow the danger hue without claiming a failure. `git status` has trained
   * everyone to read a terse mark beside a path as "this file has changes", and
   * at this size, next to the commit count, that is what it reads as -- not an
   * error banner.
   *
   * Earlier attempts: worktreeGreen said SUCCESS about unsaved work, and a teal
   * square landed between statusRunning (#5EA9C9) and statusComplete (#34d399),
   * two cyan-greens already in this same gutter. Amber is unavailable -- it is
   * the base-moved sync signal on the same row.
   */
  worktreeDirty: '#c47060',

  // Diff (inline edit diffs + git diff viewer)
  diffAddBg: 'rgba(122, 172, 140, 0.12)',
  diffAddText: '#7aac8c',
  diffRemoveBg: 'rgba(196, 112, 96, 0.1)',
  diffRemoveText: '#c47060',

  // Status-bar mode pickers
  modeThinking: '#8b7fd4',
  modeAcceptEdits: '#2eb8a6',

  // File-type icon colors
  iconBlue: '#3b82f6',
  iconYellow: '#eab308',
  iconGreen: '#22c55e',
  iconSky: '#60a5fa',
  iconPurple: '#a855f7',
  iconOrange: '#f97316',
  iconGray: '#9ca3af',

  // User-bubble prose
  bubbleCodeBg: 'rgba(0, 0, 0, 0.12)',
  bubblePreBg: 'rgba(0, 0, 0, 0.1)',
  bubblePreBorder: 'rgba(0, 0, 0, 0.1)',
  bubbleThBg: 'rgba(0, 0, 0, 0.08)',

  // ANSI terminal palette (SGR 30-37 / 90-97)
  ansiBlack: '#000',
  ansiRed: '#c23621',
  ansiGreen: '#25bc24',
  ansiYellow: '#adad27',
  ansiBlue: '#492ee1',
  ansiMagenta: '#d338d3',
  ansiCyan: '#33bbc8',
  ansiWhite: '#cbcccd',
  ansiBrightBlack: '#818383',
  ansiBrightRed: '#fc391f',
  ansiBrightGreen: '#31e722',
  ansiBrightYellow: '#eaec23',
  ansiBrightBlue: '#5833ff',
  ansiBrightMagenta: '#f935f8',
  ansiBrightCyan: '#14f0f0',
  ansiBrightWhite: '#e9ebeb',
}
