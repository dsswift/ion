/**
 * One-time clean-up of saved settings no code reads any more.
 *
 * A retired feature leaves its keys behind in the Environment document and
 * in every person's overlay. Nothing reads them, but they are not harmless:
 * a client that loads the effective settings and saves a full document back
 * sends them with it, and a key the registry does not know is written into
 * that person's overlay, so a dead value spreads into a file it never lived
 * in. Each retirement below drops its keys from every document once, each
 * file backed up beside itself first (`<file>.<backupSuffix>.bak`). A marker
 * per retirement makes a second boot a no-op.
 *
 * Conversations keep whatever retired fields they were saved with in the
 * tabs file: the loaders pick fields by name and never read them, and the
 * next save writes the record without them.
 */
import { copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import { dataDir } from '../paths'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { readSettings, writeSettings } from './settings-store'
import { listOverlays, overlayFilePath, replaceOverlay } from './user-settings-store'
import { log as _log, error as _error } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('settings-retired-keys', msg, fields) }
function error(msg: string, fields?: Record<string, unknown>): void { _error('settings-retired-keys', msg, fields) }

/** One retirement: the keys it drops, its marker, and its backup suffix. Listed by name because the registry no longer knows them. */
export interface RetiredSettings {
  name: string
  marker: string
  backupSuffix: string
  keys: readonly string[]
}

/** The Tab Strip and its tab groups: the group list, grouping mode, auto-move rules, stashed layout, and the strip's visibility. */
export const RETIRED_TAB_GROUPS: RetiredSettings = {
  name: 'tab groups',
  marker: '.settings-tab-groups-v1',
  backupSuffix: 'pre-tab-groups',
  keys: [
    'tabGroups', 'tabGroupMode', 'autoGroupMovement', 'autoGroupOrder',
    'planningGroupId', 'inProgressGroupId', 'doneGroupId',
    'stashedManualGroups', 'stashedManualTabAssignments',
    'studioTabStripVisible',
  ],
}

/**
 * Keys of the retired overlay window and older panels: collapse-keeping,
 * tall-view defaults, panel split ratios, font sizes and toggles that have
 * since moved to other keys or been removed. No code reads any of them.
 */
export const RETIRED_PANEL_SETTINGS: RetiredSettings = {
  name: 'retired panel settings',
  marker: '.settings-retired-panels-v1',
  backupSuffix: 'pre-retired-panels',
  keys: [
    'agentDetailPopup', 'closeExplorerOnFileOpen', 'conversationFontSize',
    'defaultTallConversation', 'defaultTallTerminal', 'expandOnTabSwitch',
    'gitPanelIntegrationOpen', 'gitPanelSplitRatio', 'gitPanelWorktreesOpen',
    'hideOnExternalLaunch', 'keepExplorerOnCollapse', 'keepGitPanelOnCollapse',
    'keepStatusDrawerOnCollapse', 'keepTerminalOnCollapse', 'previewFontSize',
    'thinkingEnabled',
  ],
}

/** Every retirement, in the order they run at boot. */
export const RETIREMENTS: readonly RetiredSettings[] = [RETIRED_TAB_GROUPS, RETIRED_PANEL_SETTINGS]

function backup(path: string, suffix: string): void {
  if (!existsSync(path)) return
  const target = `${path}.${suffix}.bak`
  if (existsSync(target)) return
  copyFileSync(path, target)
  log('backed up', { path, backup: target })
}

/** `doc` without `keys`, and which of them were there. */
export function stripRetiredKeys(doc: Record<string, unknown>, keys: readonly string[]): { next: Record<string, unknown>; removed: string[] } {
  const removed = keys.filter((key) => Object.prototype.hasOwnProperty.call(doc, key))
  if (removed.length === 0) return { next: doc, removed }
  const next = { ...doc }
  for (const key of removed) delete next[key]
  return { next, removed }
}

/** Runs one retirement unless its marker is present. */
export function runRetirement(retirement: RetiredSettings, dir: string = dataDir()): { ran: boolean; removed: Record<string, string[]> } {
  const markerPath = join(dir, retirement.marker)
  if (existsSync(markerPath)) {
    log('marker present; skipping', { retirement: retirement.name })
    return { ran: false, removed: {} }
  }
  const removed: Record<string, string[]> = {}
  try {
    const settingsPath = join(dir, 'settings.json')
    const environment = stripRetiredKeys(readSettings() as Record<string, unknown>, retirement.keys)
    if (environment.removed.length > 0) {
      backup(settingsPath, retirement.backupSuffix)
      writeSettings(environment.next as never)
      removed['settings.json'] = environment.removed
    }
    for (const overlay of listOverlays()) {
      const stripped = stripRetiredKeys(overlay.settings, retirement.keys)
      if (stripped.removed.length === 0) continue
      backup(overlayFilePath(overlay.subject), retirement.backupSuffix)
      replaceOverlay(overlay.subject, stripped.next)
      removed[`overlay:${overlay.subject}`] = stripped.removed
    }
  } catch (err) {
    // No marker: the next boot tries again. The backups stay.
    error('retirement failed; will retry on next boot', { retirement: retirement.name, error: String(err) })
    return { ran: false, removed }
  }
  try {
    atomicWriteFileSync(markerPath, new Date().toISOString() + '\n', 0o644)
  } catch (err) {
    error('marker write failed; retirement will re-run on next boot', { retirement: retirement.name, error: String(err) })
  }
  log('retired settings removed', { retirement: retirement.name, files: Object.keys(removed).length, removed })
  return { ran: true, removed }
}

/** Runs every retirement at boot. */
export function runRetiredSettingsMigrations(dir: string = dataDir()): void {
  for (const retirement of RETIREMENTS) runRetirement(retirement, dir)
}
