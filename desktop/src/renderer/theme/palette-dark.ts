/**
 * Ion Dark palette — the default theme and the source of the ColorPalette type.
 *
 * Design system: cool near-black neutral base, surface layering via white
 * alpha (4% surfaces/hover, 6–8% borders, ~8% input shell, 10% pressed),
 * and a single blue accent reserved for primary actions, the input focus
 * treatment, and selection. Amber is the "needs attention" family.
 *
 * Leaf module: imports nothing. `theme-tokens.ts` re-exports this palette along
 * with the theme utilities; components consume it reactively via `useColors()`.
 */

export const darkColors = {
  // Container (glass surfaces)
  containerBg: '#131316',
  containerBgCollapsed: '#101013',
  containerBorder: 'rgba(255, 255, 255, 0.08)',
  containerShadow: '0 8px 28px rgba(0, 0, 0, 0.5), 0 1px 6px rgba(0, 0, 0, 0.35)',
  cardShadow: '0 2px 8px rgba(0,0,0,0.45)',
  cardShadowCollapsed: '0 2px 6px rgba(0,0,0,0.5)',

  // Surface layers
  surfacePrimary: '#1e1e23',
  surfaceSecondary: '#26262c',
  surfaceHover: 'rgba(255, 255, 255, 0.04)',
  surfaceActive: 'rgba(255, 255, 255, 0.07)',

  // Input
  inputBg: 'transparent',
  inputBorder: 'rgba(255, 255, 255, 0.06)',
  inputFocusBorder: '#366FFB',
  inputPillBg: '#26262b',

  // Text
  textPrimary: '#f5f5f5',
  textSecondary: '#b9b9c0',
  textTertiary: '#818188',
  textMuted: '#2e2e33',

  // Accent — blue
  accent: '#366FFB',
  accentHover: '#2B60EA',
  accentPressed: '#2453D3',
  accentLight: 'rgba(54, 111, 251, 0.12)',
  accentSoft: 'rgba(54, 111, 251, 0.18)',

  // Focus (keyboard focus-visible ring + focused input shell)
  focusBorder: '#366FFB',
  focusRing: 'rgba(54, 111, 251, 0.24)',

  // Interaction layers (see also surfaceHover / surfaceActive above)
  surfacePressed: 'rgba(255, 255, 255, 0.10)',
  surfaceSelected: 'rgba(255, 255, 255, 0.04)',
  borderSubtle: 'rgba(255, 255, 255, 0.06)',

  // Drag & drop
  dragOverBg: 'rgba(54, 111, 251, 0.10)',
  dragOverBorder: 'rgba(54, 111, 251, 0.45)',
  dragInsertIndicator: '#366FFB',

  // Bash-mode input ring (pink inset on the input pill)
  bashModeRing: 'rgba(236, 72, 153, 0.5)',

  // Status dots
  statusIdle: '#818188',
  // Running is Ion Classic's terracotta orange, shared verbatim by Ion Dark,
  // Ion Light, and Ion Classic so the "working" dot is one recognizable hue
  // across all three built-ins. Deliberately distinct from the blue `accent`
  // so the pulsing dot never reads as the accent color, and warm against the
  // cool palette so it carries at a glance.
  statusRunning: '#d97757',
  statusRunningBg: 'rgba(217, 119, 87, 0.12)',
  statusCompacting: '#60a5fa',
  statusCompactingBg: 'rgba(96, 165, 250, 0.1)',
  statusComplete: '#34d399',
  statusCompleteBg: 'rgba(16, 185, 129, 0.12)',
  statusError: '#f87171',
  statusErrorBg: 'rgba(239, 68, 68, 0.10)',
  statusWarning: '#f59e0b',
  statusDead: '#f87171',
  // Shell-activity dot — a shell is executing in this tab, whether the user
  // typed a `!` command or an agent started a background command. Blaze pink:
  // deliberately far from statusError's red (#f87171), since error is the
  // top-priority state and must never be mistaken for "a shell is running",
  // and far from the violet statusQuestion (#A78BFA). Pinned by
  // palette-parity.test.ts.
  statusBash: '#ff2d95',
  statusBashGlow: 'rgba(255, 45, 149, 0.4)',
  statusPermission: '#f59e0b',
  statusPermissionGlow: 'rgba(245, 158, 11, 0.4)',
  // "Awaiting children" state — orchestrator is idle but dispatched
  // background agents are still executing. Amber ⇒ "in flight, not yet
  // done", consistent with the permission cards; amber-400 vs the
  // permission dot's amber-500 keeps the two attention states legible
  // side by side. Amber also stays separable from the terracotta
  // statusRunning so a quick glance tells the user whether foreground or
  // background work is active.
  statusWaitingChildren: '#fbbf24',
  statusWaitingChildrenGlow: 'rgba(251, 191, 36, 0.4)',
  // Question / "waiting on you" dot. Dedicated token (NOT `infoText`, which is
  // shared with info cards) so the dot's purple is independent of that blue and
  // stays distinct from the orange running dot.
  statusQuestion: '#A78BFA',

  // Tab
  tabActive: '#202025',
  tabActiveBorder: 'rgba(255, 255, 255, 0.10)',
  tabInactive: 'transparent',
  tabHover: 'rgba(255, 255, 255, 0.04)',

  // User message bubble
  userBubble: '#1e1e23',
  userBubbleBorder: 'rgba(255, 255, 255, 0.08)',
  userBubbleText: '#f5f5f5',

  // Tool card
  toolBg: '#1a1a1f',
  toolBorder: 'rgba(255, 255, 255, 0.06)',
  toolRunningBorder: 'rgba(54, 111, 251, 0.35)',
  toolRunningBg: 'rgba(54, 111, 251, 0.06)',

  // Timeline
  timelineLine: '#26262c',
  timelineNode: 'rgba(54, 111, 251, 0.25)',
  timelineNodeActive: '#366FFB',
  timelineSlashCommand: '#A855F7',
  timelineSlashCommandActive: '#C084FC',

  // Scrollbar
  scrollThumb: 'rgba(255, 255, 255, 0.10)',
  scrollThumbHover: 'rgba(255, 255, 255, 0.18)',

  // Stop button
  stopBg: '#ef4444',
  stopHover: '#dc2626',

  // Send button
  sendBg: '#366FFB',
  sendHover: '#2B60EA',
  sendDisabled: 'rgba(54, 111, 251, 0.35)',

  // Modal backdrop scrim (theme-neutral black; kept as a token so every
  // dialog dims identically)
  scrim: 'rgba(0, 0, 0, 0.4)',

  // Popover
  popoverBg: '#1a1a1f',
  popoverBorder: 'rgba(255, 255, 255, 0.08)',
  popoverShadow: '0 4px 20px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.35)',

  // Code block
  codeBg: '#0e0e11',
  // Inline `code` chip — a neutral subtle surface, NOT the accent tint, so
  // inline code reads as a quiet chip instead of smattering accent blue
  // through prose. Text uses the primary text color.
  inlineCodeBg: 'rgba(255, 255, 255, 0.08)',
  // Syntax highlighting — the shared code-syntax tokens. Pinned identical to
  // the iOS themes by the parity fixture (assets/theme-parity.json); desktop
  // maps TextMate scopes onto these (ionShikiTheme.ts), iOS maps highlight.js
  // classes onto them (IonCodeTheme.swift). Base code fg/bg reuse
  // textPrimary/codeBg.
  codeKeyword: '#C792EA',
  codeString: '#98C379',
  codeNumber: '#F59E0B',
  codeComment: '#6B6B73',
  codeFunction: '#82AAFF',
  codeType: '#4EC9B0',
  codeVariable: '#E06C75',
  codeOperator: '#B9B9C0',

  // Mic button
  micBg: '#1e1e23',
  micHover: '#26262c',
  micPressed: '#2e2e33',
  micColor: '#b9b9c0',
  micDisabled: '#2e2e33',

  // Placeholder
  placeholder: '#6b6b73',

  // Disabled button color
  btnDisabled: '#3a3a41',

  // Text on accent backgrounds
  textOnAccent: '#ffffff',
  textOnAccentMuted: 'rgba(255, 255, 255, 0.7)',

  // Button hover (CSS-only stack buttons)
  btnHoverColor: '#f5f5f5',
  btnHoverBg: 'rgba(255, 255, 255, 0.06)',

  // Accent border variants (replaces hex-alpha concatenation antipattern)
  accentBorder: 'rgba(54, 111, 251, 0.22)',
  accentBorderMedium: 'rgba(54, 111, 251, 0.32)',

  // Semantic foregrounds (text/icon weight of the status families)
  infoFg: '#60a5fa',
  successFg: '#34d399',
  warningFg: '#fbbf24',
  dangerFg: '#f87171',

  // Permission card (amber)
  permissionBorder: 'rgba(245, 158, 11, 0.3)',
  permissionShadow: '0 2px 12px rgba(245, 158, 11, 0.08)',
  permissionHeaderBg: 'rgba(245, 158, 11, 0.06)',
  permissionHeaderBorder: 'rgba(245, 158, 11, 0.12)',

  // Permission allow (green)
  permissionAllowBg: 'rgba(16, 185, 129, 0.12)',
  permissionAllowHoverBg: 'rgba(16, 185, 129, 0.22)',
  permissionAllowBorder: 'rgba(16, 185, 129, 0.30)',

  // Permission deny (red)
  permissionDenyBg: 'rgba(239, 68, 68, 0.08)',
  permissionDenyHoverBg: 'rgba(239, 68, 68, 0.18)',
  permissionDenyBorder: 'rgba(239, 68, 68, 0.22)',

  // Permission denied card
  permissionDeniedBorder: 'rgba(248, 113, 113, 0.3)',
  permissionDeniedHeaderBorder: 'rgba(248, 113, 113, 0.12)',

  // Info / question card (blue)
  infoBg: 'rgba(96, 165, 250, 0.1)',
  infoHoverBg: 'rgba(96, 165, 250, 0.15)',
  infoBorder: 'rgba(96, 165, 250, 0.25)',
  infoText: '#60a5fa',
  infoShadow: 'rgba(96, 165, 250, 0.06)',

  // Tab waiting-state glows
  tabGlowPlanReady: 'rgba(52, 211, 153, 0.5)',
  tabGlowPlanReadyShadow: 'rgba(52, 211, 153, 0.25)',
  tabGlowQuestion: 'rgba(167, 139, 250, 0.5)',
  tabGlowQuestionShadow: 'rgba(167, 139, 250, 0.25)',

  // Git file status
  gitAdded: '#34d399',
  gitModified: '#60a5fa',
  gitDeleted: '#f87171',
  gitRenamed: '#a78bfa',
  gitUntracked: '#fbbf24',
  gitConflict: '#fb923c',

  // Worktree branch indicator
  worktreeGreen: '#34d399',
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
  worktreeDirty: '#f87171',

  // Diff (inline edit diffs + git diff viewer)
  diffAddBg: 'rgba(16, 185, 129, 0.12)',
  diffAddText: '#34d399',
  diffRemoveBg: 'rgba(239, 68, 68, 0.10)',
  diffRemoveText: '#f87171',

  // Status-bar mode pickers
  modeThinking: '#a78bfa',
  modeAcceptEdits: '#2dd4bf',

  // File-type icon colors (file explorer)
  iconBlue: '#60a5fa',
  iconYellow: '#eab308',
  iconGreen: '#22c55e',
  iconSky: '#7dd3fc',
  iconPurple: '#a855f7',
  iconOrange: '#f97316',
  iconGray: '#9ca3af',

  // User-bubble prose (code/pre/table accents inside the user bubble)
  bubbleCodeBg: 'rgba(0, 0, 0, 0.25)',
  bubblePreBg: 'rgba(0, 0, 0, 0.22)',
  bubblePreBorder: 'rgba(0, 0, 0, 0.22)',
  bubbleThBg: 'rgba(0, 0, 0, 0.18)',

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
} as const

export type ColorPalette = { [K in keyof typeof darkColors]: string }
