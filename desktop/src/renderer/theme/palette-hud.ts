/**
 * Jarvis HUD palette — arc-reactor cyan on deep navy. Forced dark scheme.
 *
 * FULLY SELF-CONTAINED: this palette deliberately does NOT spread another
 * palette. Every key is pinned explicitly so edits to Ion Dark can never
 * leak into the HUD look. The frozen values are snapshotted by
 * palette-parity.test.ts — a change here must be an intentional HUD change.
 */

import type { ColorPalette } from "./palette-dark";

export const hudColors: ColorPalette = {
  // Surfaces — deep navy instead of neutral gray
  containerBg: "rgba(4, 12, 26, 0.96)",
  containerBgCollapsed: "rgba(4, 12, 26, 0.96)",
  containerBorder: "rgba(51, 195, 247, 0.18)",
  containerShadow: "0 8px 28px rgba(0, 0, 0, 0.6)",
  cardShadow: "0 2px 8px rgba(0,0,0,0.35)",
  cardShadowCollapsed: "0 2px 6px rgba(0,0,0,0.4)",

  surfacePrimary: "rgba(6, 18, 34, 0.98)",
  surfaceSecondary: "rgba(8, 22, 40, 0.98)",
  surfaceHover: "rgba(51, 195, 247, 0.06)",
  surfaceActive: "rgba(51, 195, 247, 0.10)",

  // Input
  inputBg: "transparent",
  inputBorder: "rgba(51, 195, 247, 0.35)",
  inputFocusBorder: "rgba(51, 195, 247, 0.65)",
  inputPillBg: "rgba(10, 30, 50, 0.60)",

  // Text — cyan-tinted
  textPrimary: "rgba(190, 235, 255, 0.92)",
  textSecondary: "rgba(130, 195, 235, 0.65)",
  textTertiary: "rgba(80, 150, 195, 0.55)",
  textMuted: "rgba(51, 195, 247, 0.10)",

  // Accent — cyan
  accent: "#33C3F7",
  accentHover: "#22b3e7",
  accentPressed: "#189fd3",
  accentLight: "rgba(51, 195, 247, 0.10)",
  accentSoft: "rgba(51, 195, 247, 0.15)",

  // Focus (keyboard focus-visible ring + focused input shell)
  focusBorder: "#33C3F7",
  focusRing: "rgba(51, 195, 247, 0.25)",

  // Interaction layers
  surfacePressed: "rgba(51, 195, 247, 0.14)",
  surfaceSelected: "rgba(51, 195, 247, 0.06)",
  borderSubtle: "rgba(51, 195, 247, 0.12)",

  // Drag & drop
  dragOverBg: "rgba(51, 195, 247, 0.10)",
  dragOverBorder: "rgba(51, 195, 247, 0.45)",
  dragInsertIndicator: "#33C3F7",

  // Bash-mode input ring — pins the pre-token hardcoded pink so the HUD
  // look is unchanged by the tokenization.
  bashModeRing: "rgba(244, 114, 182, 0.5)",

  // Status dots
  statusIdle: "#8a8a80",
  statusRunning: "#33C3F7",
  statusRunningBg: "rgba(51, 195, 247, 0.10)",
  statusCompacting: "#60a5fa",
  statusCompactingBg: "rgba(96, 165, 250, 0.1)",
  statusComplete: "#7aac8c",
  statusCompleteBg: "rgba(122, 172, 140, 0.1)",
  statusError: "#c47060",
  statusErrorBg: "rgba(196, 112, 96, 0.08)",
  statusWarning: "#f59e0b",
  statusDead: "#c47060",
  // Shell-activity dot — see palette-dark.ts for the rationale. HUD is a dark
  // surface, so it takes the same blaze pink as Ion Dark. The previous value
  // (#cc6b9a, shared with Classic) read as washed-out mauve at 6px.
  statusBash: "#ff2d95",
  statusBashGlow: "rgba(255, 45, 149, 0.4)",
  statusAsync: "#e879f9",
  statusAsyncGlow: "rgba(232, 121, 249, 0.4)",
  statusPermission: "#d97757",
  statusPermissionGlow: "rgba(217, 119, 87, 0.4)",
  // Amber "awaiting children" stays distinct from the cyan running color
  // so the foreground-vs-background visual vocabulary is preserved in the
  // HUD theme too; deliberately not cyan-tinted because a second cyan dot
  // would collide with statusRunning at a glance.
  statusWaitingChildren: "#f59e0b",
  statusWaitingChildrenGlow: "rgba(245, 158, 11, 0.4)",
  // Question dot — matches this theme's existing info blue (unchanged look).
  statusQuestion: "rgba(96, 165, 250, 0.85)",

  // Tab
  tabActive: "rgba(8, 22, 40, 0.95)",
  tabActiveBorder: "rgba(51, 195, 247, 0.30)",
  tabInactive: "transparent",
  tabHover: "rgba(51, 195, 247, 0.06)",

  // User message bubble
  userBubble: "rgba(6, 18, 34, 0.98)",
  userBubbleBorder: "rgba(51, 195, 247, 0.22)",
  userBubbleText: "rgba(190, 235, 255, 0.92)",

  // Tool card
  toolBg: "rgba(6, 18, 34, 0.98)",
  toolBorder: "rgba(51, 195, 247, 0.18)",
  toolRunningBorder: "rgba(51, 195, 247, 0.35)",
  toolRunningBg: "rgba(51, 195, 247, 0.05)",

  // Timeline
  timelineLine: "#353530",
  timelineNode: "rgba(217, 119, 87, 0.2)",
  timelineNodeActive: "#d97757",
  timelineSlashCommand: "#c084fc",
  timelineSlashCommandActive: "#e9d5ff",
  timelinePlanImplementation: "#7fd98c",
  timelinePlanImplementationActive: "#b7f5c0",

  // Scrollbar
  scrollThumb: "rgba(51, 195, 247, 0.20)",
  scrollThumbHover: "rgba(51, 195, 247, 0.35)",

  // Stop button
  stopBg: "#ef4444",
  stopHover: "#dc2626",

  // Send button — cyan
  sendBg: "#33C3F7",
  sendHover: "#22b3e7",
  sendDisabled: "rgba(51, 195, 247, 0.3)",

  // Modal backdrop scrim — pins the pre-token value
  scrim: "rgba(0, 0, 0, 0.4)",

  // Popover
  popoverBg: "rgba(4, 14, 28, 0.98)",
  popoverBorder: "rgba(51, 195, 247, 0.22)",
  popoverShadow: "0 4px 20px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.3)",

  // Code block
  codeBg: "#1a1a18",
  // Inline `code` chip — neutral subtle surface (not the accent tint).
  inlineCodeBg: "rgba(255, 255, 255, 0.07)",
  // Syntax highlighting — HUD cyan/amber family. jarvis-hud is intentionally
  // absent from the parity fixture (two-part theme; see theme-parity.json).
  codeKeyword: "#33C3F7",
  codeString: "#7FD98C",
  codeNumber: "#F5B942",
  codeComment: "#5C6B73",
  codeFunction: "#8AD8F8",
  codeType: "#4EC9B0",
  codeVariable: "#F2A9A2",
  codeOperator: "#A8B8C0",

  // Mic button
  micBg: "#353530",
  micHover: "#3e3e39",
  micPressed: "#474741",
  micColor: "#c0bdb2",
  micDisabled: "#42423d",

  // Placeholder
  placeholder: "rgba(80, 150, 195, 0.45)",

  // Disabled button color
  btnDisabled: "#42423d",

  // Text on accent backgrounds
  textOnAccent: "#ffffff",
  textOnAccentMuted: "rgba(255, 255, 255, 0.7)",

  // Button hover (CSS-only stack buttons)
  btnHoverColor: "#c0bdb2",
  btnHoverBg: "#302f2d",

  // Accent border variants — cyan
  accentBorder: "rgba(51, 195, 247, 0.19)",
  accentBorderMedium: "rgba(51, 195, 247, 0.25)",

  // Semantic foregrounds — pin the HUD's current status hues
  infoFg: "#60a5fa",
  successFg: "#7aac8c",
  warningFg: "#f59e0b",
  dangerFg: "#c47060",

  // Permission card (amber)
  permissionBorder: "rgba(245, 158, 11, 0.3)",
  permissionShadow: "0 2px 12px rgba(245, 158, 11, 0.08)",
  permissionHeaderBg: "rgba(245, 158, 11, 0.06)",
  permissionHeaderBorder: "rgba(245, 158, 11, 0.12)",

  // Permission allow (green)
  permissionAllowBg: "rgba(34, 197, 94, 0.1)",
  permissionAllowHoverBg: "rgba(34, 197, 94, 0.22)",
  permissionAllowBorder: "rgba(34, 197, 94, 0.25)",

  // Permission deny (red)
  permissionDenyBg: "rgba(239, 68, 68, 0.08)",
  permissionDenyHoverBg: "rgba(239, 68, 68, 0.18)",
  permissionDenyBorder: "rgba(239, 68, 68, 0.22)",

  // Permission denied card
  permissionDeniedBorder: "rgba(196, 112, 96, 0.3)",
  permissionDeniedHeaderBorder: "rgba(196, 112, 96, 0.12)",

  // Info / question card (blue)
  infoBg: "rgba(96, 165, 250, 0.1)",
  infoHoverBg: "rgba(96, 165, 250, 0.15)",
  infoBorder: "rgba(96, 165, 250, 0.25)",
  infoText: "rgba(96, 165, 250, 0.85)",
  infoShadow: "rgba(96, 165, 250, 0.06)",

  // Tab waiting-state glows
  tabGlowPlanReady: "rgba(122, 172, 140, 0.5)",
  tabGlowPlanReadyShadow: "rgba(122, 172, 140, 0.25)",
  tabGlowQuestion: "rgba(96, 165, 250, 0.5)",
  tabGlowQuestionShadow: "rgba(96, 165, 250, 0.25)",

  // Git file status — pins the pre-token hardcoded values so the HUD git
  // UI is unchanged by the tokenization.
  gitAdded: "#7aac8c",
  gitModified: "#6b9bd2",
  gitDeleted: "#c47060",
  gitRenamed: "#b08fd8",
  gitUntracked: "#d4a843",
  gitConflict: "#d97757",

  // Worktree branch indicator
  worktreeGreen: "#4ade80",
  /**
   * Unlanded-commit count on a worktree row.
   *
   * Deliberately NOT worktreeGreen. Green is the panel's ATTENTION colour --
   * the dirty dot and the reviewed-good check both use it -- and the commit
   * counts wearing it made them the first thing the eye landed on. They are
   * a fact worth reading, not the most urgent one in the row. A subdued
   * violet stays legible without competing for first glance.
   */
  unlandedCount: "#a78bfa",

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
  worktreeDirty: "#c47060",

  // Diff (inline edit diffs + git diff viewer)
  diffAddBg: "rgba(122, 172, 140, 0.12)",
  diffAddText: "#7aac8c",
  diffRemoveBg: "rgba(196, 112, 96, 0.1)",
  diffRemoveText: "#c47060",

  // Status-bar mode pickers — pins pre-token hardcoded values
  modeThinking: "#8b7fd4",
  modeAcceptEdits: "#2eb8a6",

  // File-type icon colors — pins pre-token hardcoded values
  iconBlue: "#3b82f6",
  iconYellow: "#eab308",
  iconGreen: "#22c55e",
  iconSky: "#60a5fa",
  iconPurple: "#a855f7",
  iconOrange: "#f97316",
  iconGray: "#9ca3af",

  // User-bubble prose — pins the pre-token stylesheet values
  bubbleCodeBg: "rgba(0, 0, 0, 0.12)",
  bubblePreBg: "rgba(0, 0, 0, 0.1)",
  bubblePreBorder: "rgba(0, 0, 0, 0.1)",
  bubbleThBg: "rgba(0, 0, 0, 0.08)",

  // ANSI terminal palette — pins pre-token hardcoded values
  ansiBlack: "#000",
  ansiRed: "#c23621",
  ansiGreen: "#25bc24",
  ansiYellow: "#adad27",
  ansiBlue: "#492ee1",
  ansiMagenta: "#d338d3",
  ansiCyan: "#33bbc8",
  ansiWhite: "#cbcccd",
  ansiBrightBlack: "#818383",
  ansiBrightRed: "#fc391f",
  ansiBrightGreen: "#31e722",
  ansiBrightYellow: "#eaec23",
  ansiBrightBlue: "#5833ff",
  ansiBrightMagenta: "#f935f8",
  ansiBrightCyan: "#14f0f0",
  ansiBrightWhite: "#e9ebeb",
};
