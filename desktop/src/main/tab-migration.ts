import { existsSync, readFileSync, copyFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log } from './logger'
import { engineBridge } from './state'
import { atomicWriteFileSync } from './utils/atomicWrite'
import {
  tabsFileForBackend,
  sessionLabelsFileForBackend,
  getCurrentBackend,
  SETTINGS_DIR,
} from './settings-store'
import type { PersistedTab, PersistedTabState } from '../shared/types'

function log(msg: string): void {
  _log('main', msg)
}

export interface MigrationResult {
  backupPaths: string[]
  migrated: Array<{ conversationId: string; newConversationId: string; title: string }>
  failed: Array<{ conversationId: string; title: string; error: string }>
}

// ─── Loading other backend's tabs ───

export function loadOtherBackendTabs(): Array<{
  conversationId: string
  title: string
  customTitle: string | null
  workingDirectory: string
  permissionMode: string
}> {
  const current = getCurrentBackend()
  const other: 'api' | 'cli' = current === 'api' ? 'cli' : 'api'
  const tabsPath = tabsFileForBackend(other)

  if (!existsSync(tabsPath)) return []

  try {
    const state: PersistedTabState = JSON.parse(readFileSync(tabsPath, 'utf-8'))
    const labels = loadLabelsForBackend(other)

    return (state.tabs || [])
      .filter((tab) => tab.conversationId)
      .map((tab) => ({
        conversationId: tab.conversationId!,
        title: labels[tab.conversationId!] || tab.customTitle || tab.title || 'Untitled',
        customTitle: tab.customTitle,
        workingDirectory: tab.workingDirectory,
        permissionMode: tab.permissionMode,
      }))
  } catch (err) {
    log(`Failed to load other backend tabs: ${err}`)
    return []
  }
}

function loadLabelsForBackend(backend: 'api' | 'cli'): Record<string, string> {
  const labelsPath = sessionLabelsFileForBackend(backend)
  if (!existsSync(labelsPath)) return {}
  try {
    return JSON.parse(readFileSync(labelsPath, 'utf-8'))
  } catch {
    return {}
  }
}

// ─── Backup snapshots ───

export function createBackupSnapshot(
  sourceBackend: 'api' | 'cli',
  targetBackend: 'api' | 'cli',
): string[] {
  const ts = Date.now()
  const paths: string[] = []

  for (const backend of [sourceBackend, targetBackend]) {
    for (const fileFn of [tabsFileForBackend, sessionLabelsFileForBackend]) {
      const src = fileFn(backend)
      if (existsSync(src)) {
        const backup = `${src}.pre-migration.${ts}`
        copyFileSync(src, backup)
        paths.push(backup)
      }
    }
  }

  log(`Created ${paths.length} backup snapshots`)
  return paths
}

// ─── Tab record transfer ───

export function transferTabRecord(
  conversationId: string,
  newConversationId: string,
  sourceBackend: 'api' | 'cli',
  targetBackend: 'api' | 'cli',
): void {
  const srcPath = tabsFileForBackend(sourceBackend)
  const dstPath = tabsFileForBackend(targetBackend)

  const srcState: PersistedTabState = existsSync(srcPath)
    ? JSON.parse(readFileSync(srcPath, 'utf-8'))
    : { activeSessionId: null, tabs: [] }

  const dstState: PersistedTabState = existsSync(dstPath)
    ? JSON.parse(readFileSync(dstPath, 'utf-8'))
    : { activeSessionId: null, tabs: [] }

  const tabIndex = srcState.tabs.findIndex((t) => t.conversationId === conversationId)
  if (tabIndex === -1) return

  const tab = { ...srcState.tabs[tabIndex] }

  // Rewrite session references for the new backend
  tab.conversationId = newConversationId
  tab.historicalSessionIds = undefined
  tab.lastKnownSessionId = undefined
  tab.forkedFromSessionId = undefined
  // Preserve planFilePath, pillColor, customTitle, workingDirectory

  dstState.tabs.push(tab)

  // Remove from source
  srcState.tabs.splice(tabIndex, 1)
  if (srcState.activeSessionId === conversationId) {
    srcState.activeSessionId = srcState.tabs[0]?.conversationId ?? null
  }

  atomicWriteFileSync(srcPath, JSON.stringify(srcState, null, 2), 0o644)
  atomicWriteFileSync(dstPath, JSON.stringify(dstState, null, 2), 0o644)
}

export function transferSessionLabel(
  conversationId: string,
  newConversationId: string,
  sourceBackend: 'api' | 'cli',
  targetBackend: 'api' | 'cli',
): void {
  const srcLabels = loadLabelsForBackend(sourceBackend)
  const label = srcLabels[conversationId]
  if (!label) return

  const dstLabels = loadLabelsForBackend(targetBackend)
  dstLabels[newConversationId] = label

  const dstPath = sessionLabelsFileForBackend(targetBackend)
  atomicWriteFileSync(dstPath, JSON.stringify(dstLabels, null, 2), 0o644)
}

// ─── Claude CLI project directory encoding ───

function encodeClaudeProjectPath(projectPath: string): string {
  // Claude CLI encodes project paths by replacing / and . with -
  return projectPath.replace(/[/.]/g, '-')
}

function claudeProjectDir(workingDirectory: string): string {
  const encoded = encodeClaudeProjectPath(workingDirectory)
  return join(homedir(), '.claude', 'projects', encoded)
}

// ─── Migration orchestrator ───

export async function migrateTabsToBackend(
  conversationIds: string[],
  targetBackend: 'api' | 'cli',
): Promise<MigrationResult> {
  const sourceBackend: 'api' | 'cli' = targetBackend === 'api' ? 'cli' : 'api'

  // Determine directories
  const home = homedir()
  const ionConvDir = join(home, '.ion', 'conversations')

  const targetFormat = targetBackend === 'cli' ? 'claude_code' : 'ion'

  // Step 1: Backup
  const backupPaths = createBackupSnapshot(sourceBackend, targetBackend)

  // Step 2: Migrate each tab via engine
  const migrated: MigrationResult['migrated'] = []
  const failed: MigrationResult['failed'] = []

  // Load tab info for titles
  const srcTabsPath = tabsFileForBackend(sourceBackend)
  const srcLabels = loadLabelsForBackend(sourceBackend)
  let srcState: PersistedTabState = { activeSessionId: null, tabs: [] }
  if (existsSync(srcTabsPath)) {
    try {
      srcState = JSON.parse(readFileSync(srcTabsPath, 'utf-8'))
    } catch {}
  }

  for (const conversationId of conversationIds) {
    const tab = srcState.tabs.find((t) => t.conversationId === conversationId)
    const title = srcLabels[conversationId] || tab?.customTitle || tab?.title || 'Untitled'

    try {
      // Compute source and target directories based on the tab's working directory
      const workDir = tab?.workingDirectory || home
      let sourceDir: string
      let targetDir: string

      if (sourceBackend === 'cli') {
        sourceDir = claudeProjectDir(workDir)
        targetDir = ionConvDir
      } else {
        sourceDir = ionConvDir
        targetDir = claudeProjectDir(workDir)
      }

      const result = await engineBridge.migrateConversation(
        conversationId,
        targetFormat,
        targetDir,
        sourceDir,
      )

      if (!result.ok || !result.data) {
        failed.push({ conversationId, title, error: result.error || 'Unknown error' })
        continue
      }

      // Step 3: Transfer tab record + label on success
      transferTabRecord(conversationId, result.data.newSessionId, sourceBackend, targetBackend)
      transferSessionLabel(conversationId, result.data.newSessionId, sourceBackend, targetBackend)

      migrated.push({
        conversationId,
        newConversationId: result.data.newSessionId,
        title,
      })

      log(`Migrated "${title}" (${conversationId} → ${result.data.newSessionId}): ${result.data.messageCount} msgs`)
    } catch (err: any) {
      failed.push({ conversationId, title, error: err.message || String(err) })
    }
  }

  log(`Migration complete: ${migrated.length} succeeded, ${failed.length} failed`)
  return { backupPaths, migrated, failed }
}
