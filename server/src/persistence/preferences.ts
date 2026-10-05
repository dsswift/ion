import { SETTINGS_DEFAULTS } from './settings-store'
import { readEffectiveSettings, writeEffectiveSettings } from './effective-settings'
import { isEphemeralWorkspaceDirectory } from '@ion/shared/recent-directories'
import { sanitizeProjectRegistry, type ProjectRegistry } from '@ion/shared/project-registry'
import type { EngineProfile } from '@ion/shared/types-engine'
import type { QuickTool } from '@ion/shared/types-session'

/**
 * Server-side stand-in for the desktop renderer's `usePreferencesStore`.
 *
 * The renderer's preferences store is a zustand hook wired to `useColors()`
 * theming, `localStorage`, and window-scoped UI state — genuinely
 * renderer-bound (device/UI preferences, not server-owned "server" keys per
 * the `settings.json` key split in `baseline.md` §3). The moved session
 * store only reads and writes a small number of "server" keys through it
 * (recent directories, model preferences, worktree branch defaults, tab
 * group stashing); this module reads and writes those same keys directly,
 * which is what the renderer store itself does through
 * `window.ion.saveSettings`/`loadSettings` — same persisted keys, same
 * files, no zustand/React/localStorage dependency.
 *
 * Every key exposed here is a PERSONAL preference: none appears in
 * `ENVIRONMENT_OWNED_SETTINGS_KEYS`, so `settings.save` already routes each
 * one to the calling identity's overlay rather than the Environment document.
 * Reads and writes here therefore BOTH resolve per-identity
 * (see effective-settings.ts). Reading the Environment copy instead is what
 * made a new conversation start at a thinking level the operator had already
 * replaced in Settings.
 *
 * Read and write must stay on the same side of that split. A getter that
 * prefers the overlay while its setter persists to the Environment document
 * writes a value it can never read back: the stale overlay entry shadows it
 * forever, so the setter reports success and the next read still resolves
 * the old value.
 *
 * Exposed with the same `usePreferencesStore.getState()` shape zustand
 * generates, so every moved call site keeps working unchanged.
 */
export const usePreferencesStore = { getState }

function getState() {
  const disk = readEffectiveSettings()
  // Personal-preference writes land in the caller's overlay, the same place
  // `settings.save` puts them and the same place `disk` read them from. A
  // narrow patch, never a whole-document spread: spreading `disk` would
  // freeze every inherited Environment default into this identity's overlay.
  const writePersonal = (patch: Record<string, unknown>): void => {
    writeEffectiveSettings(patch)
  }
  return {
    get defaultBaseDirectory(): string {
      return typeof disk.defaultBaseDirectory === 'string' ? disk.defaultBaseDirectory : ''
    },
    get engineProfiles(): EngineProfile[] {
      return Array.isArray(disk.engineProfiles) ? disk.engineProfiles : []
    },
    get gitOpsMode(): 'manual' | 'worktree' {
      return disk.gitOpsMode === 'worktree' ? 'worktree' : 'manual'
    },
    get inboxAutoSettleDays(): number {
      return typeof disk.inboxAutoSettleDays === 'number' ? disk.inboxAutoSettleDays : SETTINGS_DEFAULTS.inboxAutoSettleDays
    },
    get usageLimitAutoResume(): boolean {
      return typeof disk.usageLimitAutoResume === 'boolean' ? disk.usageLimitAutoResume : SETTINGS_DEFAULTS.usageLimitAutoResume
    },
    get usageLimitResumePrompt(): string {
      return typeof disk.usageLimitResumePrompt === 'string' ? disk.usageLimitResumePrompt : SETTINGS_DEFAULTS.usageLimitResumePrompt
    },
    get quotaExpiryAlertHours(): number {
      return typeof disk.quotaExpiryAlertHours === 'number' ? disk.quotaExpiryAlertHours : SETTINGS_DEFAULTS.quotaExpiryAlertHours
    },
    get quotaExpiryUnusedPercent(): number {
      return typeof disk.quotaExpiryUnusedPercent === 'number' ? disk.quotaExpiryUnusedPercent : SETTINGS_DEFAULTS.quotaExpiryUnusedPercent
    },
    get aiAssistPromptOverrides(): Record<string, string> {
      return (disk.aiAssistPromptOverrides && typeof disk.aiAssistPromptOverrides === 'object') ? disk.aiAssistPromptOverrides : {}
    },
    get preferredModel(): string {
      // Empty, not an invented model id -- see SETTINGS_DEFAULTS.preferredModel.
      return typeof disk.preferredModel === 'string' && disk.preferredModel ? disk.preferredModel : ''
    },
    get quickTools(): QuickTool[] {
      // An Account setting: a quick tool is a shell command, and it names
      // programs and paths on THIS server. `runQuickTool` looks the command
      // up here by id, so a client never supplies the command text.
      return Array.isArray(disk.quickTools) ? disk.quickTools : []
    },
    get worktreeCompletionStrategy(): 'merge-ff' | 'merge' | 'pr' {
      return disk.worktreeCompletionStrategy === 'merge' || disk.worktreeCompletionStrategy === 'pr'
        ? disk.worktreeCompletionStrategy
        : 'merge-ff'
    },
    get worktreeBranchDefaults(): Record<string, string> {
      return (disk.worktreeBranchDefaults && typeof disk.worktreeBranchDefaults === 'object') ? disk.worktreeBranchDefaults : {}
    },
    get recentBaseDirectories(): string[] {
      return Array.isArray(disk.recentBaseDirectories) ? disk.recentBaseDirectories : []
    },
    get directoryUsageCounts(): Record<string, number> {
      return (disk.directoryUsageCounts && typeof disk.directoryUsageCounts === 'object') ? disk.directoryUsageCounts : {}
    },
    get planModelSplitEnabled(): boolean {
      return typeof disk.planModelSplitEnabled === 'boolean' ? disk.planModelSplitEnabled : false
    },
    get planModeModel(): string {
      return typeof disk.planModeModel === 'string' ? disk.planModeModel : ''
    },
    get implementModeModel(): string {
      return typeof disk.implementModeModel === 'string' ? disk.implementModeModel : ''
    },
    get engineDefaultModel(): string {
      return typeof disk.engineDefaultModel === 'string' ? disk.engineDefaultModel : ''
    },
    get projects(): ProjectRegistry {
      return sanitizeProjectRegistry(disk.projects)
    },

    addRecentBaseDirectory(dir: string): void {
      if (isEphemeralWorkspaceDirectory(dir)) return
      const current = (Array.isArray(disk.recentBaseDirectories) ? disk.recentBaseDirectories : []).filter((d: string) => d !== dir)
      const updated = [dir, ...current].slice(0, 12)
      const counts = { ...(disk.directoryUsageCounts ?? {}), [dir]: (disk.directoryUsageCounts?.[dir] ?? 0) + 1 }
      writePersonal({ recentBaseDirectories: updated, directoryUsageCounts: counts })
    },

    setWorktreeBranchDefault(repoPath: string, branch: string): void {
      const current = (disk.worktreeBranchDefaults && typeof disk.worktreeBranchDefaults === 'object') ? disk.worktreeBranchDefaults : {}
      writePersonal({ worktreeBranchDefaults: { ...current, [repoPath]: branch } })
    },
  }
}
