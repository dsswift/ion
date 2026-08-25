import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { log as _log, warn as _warn } from '../logger'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { cloneDefinition, isAutomationDefinition, type AutomationDefinition, type AutomationDocument } from '../../shared/types-automation'

const TAG = 'automation.store'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export function automationDirectory(): string { return join(homedir(), '.ion', 'automation') }
export function projectAutomationDirectory(projectPath: string): string { return join(projectPath, '.ion', 'automation') }
export function projectAutomationStateFile(projectPath: string): string { return join(homedir(), '.ion', 'automation-project-state', `${createHash('sha256').update(projectPath).digest('hex')}.json`) }

export class AutomationDefinitionSource {
  private cached: AutomationDefinition[] | null = null
  private watcher: FSWatcher | null = null
  constructor(private readonly directory: string) {}
  load(): AutomationDefinition[] {
    if (this.cached) return this.cached.map(cloneDefinition)
    const definitions: AutomationDefinition[] = []
    try {
      if (!existsSync(this.directory)) return []
      for (const item of readdirSync(this.directory, { withFileTypes: true })) {
        if (!item.isFile() || !item.name.endsWith('.json')) continue
        const path = join(this.directory, item.name)
        try { definitions.push(...readDefinitions(JSON.parse(readFileSync(path, 'utf8')))) }
        catch (err) { warn('automation definition unreadable', { path, error: String(err) }) }
      }
    } catch (err) { warn('automation source unreadable', { directory: this.directory, error: String(err) }) }
    this.cached = definitions.map(cloneDefinition)
    return definitions.map(cloneDefinition)
  }
  startWatcher(onChange: () => void): void {
    this.stopWatcher()
    if (!existsSync(this.directory)) return
    try { this.watcher = watch(this.directory, () => { this.cached = null; onChange() }) }
    catch (err) { warn('automation source watch unavailable', { directory: this.directory, error: String(err) }) }
  }
  stopWatcher(): void { this.watcher?.close(); this.watcher = null }
}

export class AutomationStore {
  constructor(private readonly directory: string = automationDirectory()) {}
  load(): AutomationDefinition[] { return new AutomationDefinitionSource(this.directory).load() }
  save(definitions: readonly AutomationDefinition[]): void {
    validateUniqueDefinitions(definitions)
    try {
      mkdirSync(this.directory, { recursive: true })
      const expected = new Set(definitions.map((d) => `${d.id}.json`))
      for (const item of readdirSync(this.directory, { withFileTypes: true })) if (item.isFile() && item.name.endsWith('.json') && !expected.has(item.name)) unlinkSync(join(this.directory, item.name))
      for (const definition of definitions) atomicWriteFileSync(join(this.directory, `${definition.id}.json`), JSON.stringify({ version: 2, definitions: [cloneDefinition(definition)] }, null, 2), 0o600)
      log('user automations saved', { directory: this.directory, count: definitions.length })
    } catch (err) { warn('user automations save failed', { directory: this.directory, error: String(err) }); throw err }
  }
}

export class ProjectAutomationStateStore {
  constructor(private readonly file: string) {}
  loadDisabledIds(): string[] {
    try { if (!existsSync(this.file)) return []; const value = JSON.parse(readFileSync(this.file, 'utf8')) as { disabledIds?: unknown }; return Array.isArray(value.disabledIds) ? value.disabledIds.filter((id): id is string => typeof id === 'string') : [] }
    catch (err) { warn('project automation ledger unreadable', { path: this.file, error: String(err) }); return [] }
  }
  saveDisabledIds(ids: readonly string[]): void { mkdirSync(dirname(this.file), { recursive: true }); atomicWriteFileSync(this.file, JSON.stringify({ version: 1, disabledIds: [...new Set(ids)] }, null, 2), 0o600) }
}

export function validateUniqueDefinitions(definitions: readonly AutomationDefinition[]): void {
  const ids = new Set<string>()
  for (const definition of definitions) { if (!isAutomationDefinition(definition)) throw new Error('Automation definition has invalid shape'); if (ids.has(definition.id)) throw new Error(`Duplicate automation id: ${definition.id}`); ids.add(definition.id) }
}
function readDefinitions(value: unknown): AutomationDefinition[] {
  if (isAutomationDefinition(value)) return [cloneDefinition(value)]
  const raw = value && typeof value === 'object' ? (value as Partial<AutomationDocument>).definitions : undefined
  return Array.isArray(raw) ? raw.filter(isAutomationDefinition).map(cloneDefinition) : []
}
