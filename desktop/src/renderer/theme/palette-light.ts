/**
 * Ion Light palette — the light sibling of Ion Dark: white base, surface
 * layering via black alpha, the same blue accent family at 600 weight for
 * contrast on white. Key set must match `darkColors` exactly (enforced by
 * palette-parity.test.ts).
 */

import type { ColorPalette } from "./palette-dark";

export const lightColors: ColorPalette = {
  // Container (glass surfaces)
  containerBg: "#fbfbfc",
  containerBgCollapsed: "#f4f4f6",
  containerBorder: "rgba(0, 0, 0, 0.08)",
  containerShadow:
    "0 8px 28px rgba(0, 0, 0, 0.08), 0 1px 6px rgba(0, 0, 0, 0.04)",
  cardShadow: "0 2px 8px rgba(0,0,0,0.06)",
  cardShadowCollapsed: "0 2px 6px rgba(0,0,0,0.08)",

  // Surface layers
  surfacePrimary: "#f2f2f4",
  surfaceSecondary: "#e9e9ec",
  surfaceHover: "rgba(0, 0, 0, 0.04)",
  surfaceActive: "rgba(0, 0, 0, 0.06)",

  // Input
  inputBg: "transparent",
  inputBorder: "rgba(0, 0, 0, 0.08)",
  inputFocusBorder: "#2B5FE8",
  inputPillBg: "#ffffff",

  // Text
  textPrimary: "#18181b",
  textSecondary: "#4b4b52",
  textTertiary: "#74747c",
  textMuted: "#e4e4e7",

  // Accent — blue (600 weight for contrast on white)
  accent: "#2B5FE8",
  accentHover: "#2453D3",
  accentPressed: "#1D47BC",
  accentLight: "rgba(43, 95, 232, 0.10)",
  accentSoft: "rgba(43, 95, 232, 0.14)",

  // Focus (keyboard focus-visible ring + focused input shell)
  focusBorder: "#2B5FE8",
  focusRing: "rgba(43, 95, 232, 0.24)",

  // Interaction layers (see also surfaceHover / surfaceActive above)
  surfacePressed: "rgba(0, 0, 0, 0.08)",
  surfaceSelected: "rgba(0, 0, 0, 0.04)",
  borderSubtle: "rgba(0, 0, 0, 0.06)",

  // Drag & drop
  dragOverBg: "rgba(43, 95, 232, 0.10)",
  dragOverBorder: "rgba(43, 95, 232, 0.45)",
  dragInsertIndicator: "#2B5FE8",

  // Bash-mode input ring (pink inset on the input pill)
  bashModeRing: "rgba(219, 39, 119, 0.5)",

  // Status dots
  statusIdle: "#74747c",
  // Terracotta-orange running dot, shared verbatim with Ion Dark and Ion
  // Classic (see palette-dark.ts for the rationale). This is the one status
  // token that is NOT deepened for the light surface: the value is shared
  // across all three built-ins by design, and #d97757 on #FBFBFC clears the
  // WCAG 1.4.11 non-text 3:1 minimum.
  statusRunning: "#d97757",
  statusRunningBg: "rgba(217, 119, 87, 0.10)",
  statusCompacting: "#3b82f6",
  statusCompactingBg: "rgba(59, 130, 246, 0.1)",
  statusComplete: "#059669",
  statusCompleteBg: "rgba(5, 150, 105, 0.10)",
  statusError: "#dc2626",
  statusErrorBg: "rgba(220, 38, 38, 0.08)",
  statusWarning: "#f59e0b",
  statusDead: "#dc2626",
  // Shell-activity dot — see palette-dark.ts for the rationale. Deepened for
  // a light surface: it must hold contrast against white while staying
  // unmistakably pink rather than drifting toward statusError's red (#dc2626).
  statusBash: "#e6007a",
  statusBashGlow: "rgba(230, 0, 122, 0.3)",
  statusAsync: "#c026d3",
  statusAsyncGlow: "rgba(192, 38, 211, 0.3)",
  statusPermission: "#d97706",
  statusPermissionGlow: "rgba(217, 119, 6, 0.3)",
  // "Awaiting children" state — see palette-dark.ts for full rationale.
  // Amber-500 vs the permission dot's amber-600 (one weight lighter each
  // than the dark palette, for contrast on white).
  statusWaitingChildren: "#f59e0b",
  statusWaitingChildrenGlow: "rgba(245, 158, 11, 0.3)",
  // Dedicated question dot (deeper violet for light-bg contrast), independent
  // of the shared blue `infoText`.
  statusQuestion: "#7C3AED",

  // Tab
  tabActive: "#f2f2f4",
  tabActiveBorder: "rgba(0, 0, 0, 0.10)",
  tabInactive: "transparent",
  tabHover: "rgba(0, 0, 0, 0.04)",

  // User message bubble
  userBubble: "#f2f2f4",
  userBubbleBorder: "rgba(0, 0, 0, 0.08)",
  userBubbleText: "#18181b",

  // Tool card
  toolBg: "#f6f6f8",
  toolBorder: "rgba(0, 0, 0, 0.06)",
  toolRunningBorder: "rgba(43, 95, 232, 0.35)",
  toolRunningBg: "rgba(43, 95, 232, 0.05)",

  // Timeline
  timelineLine: "#e9e9ec",
  timelineNode: "rgba(43, 95, 232, 0.25)",
  timelineNodeActive: "#2B5FE8",
  timelineSlashCommand: "#7E22CE",
  timelineSlashCommandActive: "#9333EA",

  // Scrollbar
  scrollThumb: "rgba(0, 0, 0, 0.10)",
  scrollThumbHover: "rgba(0, 0, 0, 0.18)",

  // Stop button
  stopBg: "#ef4444",
  stopHover: "#dc2626",

  // Send button
  sendBg: "#2B5FE8",
  sendHover: "#2453D3",
  sendDisabled: "rgba(43, 95, 232, 0.35)",

  // Modal backdrop scrim (theme-neutral black; kept as a token so every
  // dialog dims identically)
  scrim: "rgba(0, 0, 0, 0.4)",

  // Popover
  popoverBg: "#ffffff",
  popoverBorder: "rgba(0, 0, 0, 0.08)",
  popoverShadow: "0 4px 20px rgba(0,0,0,0.1), 0 1px 4px rgba(0,0,0,0.06)",

  // Code block
  codeBg: "#eeeef1",
  // Inline `code` chip — neutral subtle surface (not the accent tint).
  inlineCodeBg: "rgba(0, 0, 0, 0.06)",
  // Syntax highlighting — shared code tokens, parity-pinned (see palette-dark).
  codeKeyword: "#8E44AD",
  codeString: "#0A7A3E",
  codeNumber: "#B7791F",
  codeComment: "#8A8A93",
  codeFunction: "#2563EB",
  codeType: "#0E7C86",
  codeVariable: "#B4322A",
  codeOperator: "#4B4B52",

  // Mic button
  micBg: "#f2f2f4",
  micHover: "#e9e9ec",
  micPressed: "#dfdfe4",
  micColor: "#4b4b52",
  micDisabled: "#d4d4d8",

  // Placeholder
  placeholder: "#9d9da5",

  // Disabled button color
  btnDisabled: "#d4d4d8",

  // Text on accent backgrounds
  textOnAccent: "#ffffff",
  textOnAccentMuted: "rgba(255, 255, 255, 0.7)",

  // Button hover (CSS-only stack buttons)
  btnHoverColor: "#18181b",
  btnHoverBg: "rgba(0, 0, 0, 0.05)",

  // Accent border variants (replaces hex-alpha concatenation antipattern)
  accentBorder: "rgba(43, 95, 232, 0.22)",
  accentBorderMedium: "rgba(43, 95, 232, 0.32)",

  // Semantic foregrounds (text/icon weight of the status families)
  infoFg: "#2563eb",
  successFg: "#059669",
  warningFg: "#b45309",
  dangerFg: "#dc2626",

  // Permission card (amber)
  permissionBorder: "rgba(245, 158, 11, 0.3)",
  permissionShadow: "0 2px 12px rgba(245, 158, 11, 0.08)",
  permissionHeaderBg: "rgba(245, 158, 11, 0.06)",
  permissionHeaderBorder: "rgba(245, 158, 11, 0.12)",

  // Permission allow (green)
  permissionAllowBg: "rgba(5, 150, 105, 0.10)",
  permissionAllowHoverBg: "rgba(5, 150, 105, 0.20)",
  permissionAllowBorder: "rgba(5, 150, 105, 0.30)",

  // Permission deny (red)
  permissionDenyBg: "rgba(220, 38, 38, 0.08)",
  permissionDenyHoverBg: "rgba(220, 38, 38, 0.16)",
  permissionDenyBorder: "rgba(220, 38, 38, 0.22)",

  // Permission denied card
  permissionDeniedBorder: "rgba(220, 38, 38, 0.30)",
  permissionDeniedHeaderBorder: "rgba(220, 38, 38, 0.12)",

  // Info / question card (blue)
  infoBg: "rgba(59, 130, 246, 0.08)",
  infoHoverBg: "rgba(59, 130, 246, 0.12)",
  infoBorder: "rgba(59, 130, 246, 0.25)",
  infoText: "#2563eb",
  infoShadow: "rgba(59, 130, 246, 0.06)",

  // Tab waiting-state glows
  tabGlowPlanReady: "rgba(5, 150, 105, 0.5)",
  tabGlowPlanReadyShadow: "rgba(5, 150, 105, 0.2)",
  tabGlowQuestion: "rgba(124, 58, 237, 0.5)",
  tabGlowQuestionShadow: "rgba(124, 58, 237, 0.2)",

  // Git file status
  gitAdded: "#059669",
  gitModified: "#2563eb",
  gitDeleted: "#dc2626",
  gitRenamed: "#7c3aed",
  gitUntracked: "#d97706",
  gitConflict: "#c2410c",

  // Worktree branch indicator
  worktreeGreen: "#059669",
  /**
   * Unlanded-commit count on a worktree row.
   *
   * Deliberately NOT worktreeGreen. Green is the panel's ATTENTION colour --
   * the dirty dot and the reviewed-good check both use it -- and the commit
   * counts wearing it made them the first thing the eye landed on. They are
   * a fact worth reading, not the most urgent one in the row. A subdued
   * violet stays legible without competing for first glance.
   */
  unlandedCount: "#7c3aed",

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
  worktreeDirty: "#dc2626",

  // Diff (inline edit diffs + git diff viewer)
  diffAddBg: "rgba(5, 150, 105, 0.10)",
  diffAddText: "#059669",
  diffRemoveBg: "rgba(220, 38, 38, 0.08)",
  diffRemoveText: "#dc2626",

  // Status-bar mode pickers
  modeThinking: "#7c3aed",
  modeAcceptEdits: "#0d9488",

  // File-type icon colors (file explorer)
  iconBlue: "#2563eb",
  iconYellow: "#a16207",
  iconGreen: "#15803d",
  iconSky: "#0284c7",
  iconPurple: "#7e22ce",
  iconOrange: "#c2410c",
  iconGray: "#6b7280",

  // User-bubble prose (code/pre/table accents inside the user bubble)
  bubbleCodeBg: "rgba(0, 0, 0, 0.12)",
  bubblePreBg: "rgba(0, 0, 0, 0.1)",
  bubblePreBorder: "rgba(0, 0, 0, 0.1)",
  bubbleThBg: "rgba(0, 0, 0, 0.08)",

  // ANSI terminal palette (SGR 30-37 / 90-97) — dark-on-light terminal set
  ansiBlack: "#000000",
  ansiRed: "#b3231a",
  ansiGreen: "#1a8c19",
  ansiYellow: "#8a8a1e",
  ansiBlue: "#3b24b8",
  ansiMagenta: "#aa2caa",
  ansiCyan: "#1f8f99",
  ansiWhite: "#6b6b6b",
  ansiBrightBlack: "#5a5c5c",
  ansiBrightRed: "#d32f1a",
  ansiBrightGreen: "#1f9c17",
  ansiBrightYellow: "#9a9c17",
  ansiBrightBlue: "#4629cc",
  ansiBrightMagenta: "#c22cc1",
  ansiBrightCyan: "#0e9c9c",
  ansiBrightWhite: "#525252",
};
