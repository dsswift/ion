/**
 * Settings-files guard — whether the agent may change this server's own Ion
 * settings files.
 *
 * ── What it protects ────────────────────────────────────────────────────────
 * The files that decide what the engine and this server permit: the engine
 * config (`engine.json`, global and per project), this server's settings
 * document, and the per-person overlays. An agent that can rewrite them can
 * widen its own permissions, so the decision belongs to the server the files
 * live on, never to whichever device happens to be connected.
 *
 * The enterprise config sources are protected too, and differently: they are
 * the sealed layer above all of this, so no setting and no approval opens
 * them.
 *
 * ── How it decides ──────────────────────────────────────────────────────────
 * `allowSettingsEdits` is an Environment setting (`admin` to change).
 *   off  The call is refused. Nobody is asked.
 *   on   The call is refused until the person at the conversation approves
 *        that file for that conversation. The approval is asked through the
 *        ordinary permission card, so Studio and the phone both show it. It
 *        lasts for the life of this server process and is never written down.
 *
 * The tool gate answers in milliseconds and cannot wait on a person, so an
 * unapproved call is refused at once with a reason that tells the model it
 * has been put to the user. When they approve, the conversation is told to
 * retry.
 *
 * ── What counts as a call on a settings file ────────────────────────────────
 * A file-writing tool is judged by its target path. A `Bash` call is judged by
 * its command text: a literal mention of a protected file refuses the call,
 * whatever the verb, because a shell command's effect on a named file cannot
 * be read from its text. The refusal says to use `Read` to look at the file.
 * A path built at run time (`"$HOME/.ion/engine.json"` through a variable)
 * cannot be resolved and is not guessed at.
 */
import { homedir } from 'os'
import { isAbsolute, join, normalize, sep } from 'path'
import { dataDir } from '../paths'
import { readSettings } from '../persistence/settings-store'
import { currentEnterprisePolicy } from '../enterprise-policy-source'
import { deriveEnterpriseSettingsEditsPolicy } from '@ion/shared/enterprise-settings-edits-policy'
import { log as _log } from '../logger'

const TAG = 'settings-guard'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

export const SETTINGS_GUARD_QUESTION_PREFIX = 'settings-guard:'
export const SETTINGS_GUARD_ALLOW = 'allow-conversation'
export const SETTINGS_GUARD_DENY = 'deny'

const FILE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

export interface SettingsGuardRequest {
  tabId: string
  /** The engine session key: the tab id, or `tabId:instanceId` for an extension-hosted conversation. */
  sessionKey: string
  toolName: string
  input: Record<string, unknown>
  cwd: string
}

export type SettingsGuardDecision =
  | { kind: 'not-applicable' }
  | { kind: 'allow'; path: string }
  | { kind: 'deny'; path: string; reason: string }
  /** Refused for now; the person at the conversation is to be asked. */
  | { kind: 'ask'; path: string; reason: string }

/**
 * `path` when it is an enterprise config source, else null. These are the
 * sealed layer: what IT set for this machine, which nothing below it may
 * change. No setting and no approval opens them. The list mirrors the
 * engine's own source order (engine/internal/config/enterprise.go).
 */
export function enterpriseConfigFile(path: string): string | null {
  const clean = normalize(path)
  const override = process.env.ION_ENTERPRISE_CONFIG
  if (override && clean === normalize(override)) return clean
  if (clean.startsWith(`${sep}Library${sep}Managed Preferences${sep}`) && clean.endsWith('com.ion.engine.plist')) return clean
  if (clean === normalize('/etc/ion/config.json') || clean.startsWith(normalize('/etc/ion/config.d') + sep)) return clean
  const programData = process.env.ProgramData
  if (programData) {
    const root = join(normalize(programData), 'Ion')
    if (clean === join(root, 'enterprise-config.json') || clean.startsWith(join(root, 'enterprise-config.d') + sep)) return clean
  }
  return null
}

/** `path` when it is one of this server's protected settings files, else null. */
export function protectedSettingsFile(path: string): string | null {
  const clean = normalize(path)
  if (enterpriseConfigFile(clean)) return clean
  const root = normalize(dataDir())
  if (clean === join(root, 'engine.json') || clean === join(root, 'settings.json')) return clean
  if (clean.startsWith(join(root, 'user-settings') + sep)) return clean
  // A project's own engine config, wherever the project is.
  if (clean.endsWith(`${sep}.ion${sep}engine.json`)) return clean
  return null
}

function expandHome(token: string): string {
  if (token === '~') return homedir()
  if (token.startsWith('~/')) return join(homedir(), token.slice(2))
  if (token.startsWith('$HOME/')) return join(homedir(), token.slice(6))
  if (token.startsWith('${HOME}/')) return join(homedir(), token.slice(8))
  return token
}

/** The first protected settings file a shell command names literally, or null. */
export function protectedFileInCommand(command: string, cwd: string): string | null {
  // Split on whitespace, quotes, and shell operators: enough to isolate a
  // literal path token without parsing the shell.
  for (const raw of command.split(/[\s"'`;|&<>()=]+/)) {
    if (!raw || !(raw.includes('.json') || raw.includes('.plist'))) continue
    const expanded = expandHome(raw)
    const absolute = isAbsolute(expanded) ? expanded : cwd ? join(cwd, expanded) : ''
    if (!absolute) continue
    const hit = protectedSettingsFile(absolute)
    if (hit) return hit
  }
  return null
}

function targetOf(req: SettingsGuardRequest): string | null {
  if (req.toolName === 'Bash') {
    const command = req.input['command']
    return typeof command === 'string' && command ? protectedFileInCommand(command, req.cwd) : null
  }
  if (!FILE_TOOLS.has(req.toolName)) return null
  for (const key of ['file_path', 'path', 'filePath', 'notebook_path']) {
    const v = req.input[key]
    if (typeof v !== 'string' || !v) continue
    const absolute = isAbsolute(v) ? v : req.cwd ? join(req.cwd, v) : ''
    return absolute ? protectedSettingsFile(absolute) : null
  }
  return null
}

// ── approvals, per conversation per file, for this process only ────────────

const grants = new Map<string, Set<string>>()

export function grantSettingsEdit(tabId: string, path: string): void {
  const set = grants.get(tabId) ?? new Set<string>()
  set.add(path)
  grants.set(tabId, set)
  log('settings edit approved for conversation', { tab_id: tabId, path })
}

export function hasSettingsEditGrant(tabId: string, path: string): boolean {
  return grants.get(tabId)?.has(path) === true
}

export function clearSettingsEditGrants(tabId?: string): void {
  if (tabId === undefined) grants.clear()
  else grants.delete(tabId)
}

/**
 * Whether this server lets the agent be approved to edit settings files at
 * all. The organization's seal, when there is one, outranks the saved setting.
 */
export function settingsEditsAllowed(): boolean {
  const sealed = deriveEnterpriseSettingsEditsPolicy(currentEnterprisePolicy())
  if (sealed) return sealed.allowed
  return readSettings().allowSettingsEdits === true
}

export function evaluateSettingsGuard(req: SettingsGuardRequest): SettingsGuardDecision {
  const path = targetOf(req)
  if (!path) return { kind: 'not-applicable' }
  const readHint = req.toolName === 'Bash' ? ' To look at the file, use the Read tool.' : ''
  if (enterpriseConfigFile(path)) {
    log('settings edit refused: enterprise config is sealed', { tab_id: req.tabId, tool: req.toolName, path })
    return {
      kind: 'deny', path,
      reason: `${path} is this machine's enterprise configuration. It is set by the organization and cannot be changed from a conversation, with or without approval. Do not try another way to write it.${readHint}`,
    }
  }
  if (!settingsEditsAllowed()) {
    log('settings edit refused: turned off on this server', { tab_id: req.tabId, tool: req.toolName, path })
    const sealed = deriveEnterpriseSettingsEditsPolicy(currentEnterprisePolicy()) !== null
    const how = sealed
      ? 'The organization has sealed this off; no setting or approval opens it.'
      : 'An administrator of this server can turn on "Allow settings edits by the agent" in Settings.'
    return {
      kind: 'deny', path,
      reason: `${path} is an Ion settings file, and this server does not let the agent change its settings files. ${how} Do not try another way to write it.${readHint}`,
    }
  }
  if (hasSettingsEditGrant(req.tabId, path)) {
    log('settings edit allowed: approved for this conversation', { tab_id: req.tabId, tool: req.toolName, path })
    return { kind: 'allow', path }
  }
  log('settings edit refused: approval requested', { tab_id: req.tabId, tool: req.toolName, path })
  return {
    kind: 'ask', path,
    reason: `${path} is an Ion settings file. The user has been asked to approve changes to it in this conversation. Stop here and do not try another way to write it; you will be told when they approve.${readHint}`,
  }
}

// ── the question put to the person ─────────────────────────────────────────

export interface SettingsGuardQuestion {
  questionId: string
  tabId: string
  sessionKey: string
  path: string
  toolName: string
  toolInput: Record<string, unknown>
}

const pending = new Map<string, SettingsGuardQuestion>()
let sequence = 0

/** The open question for this conversation and file, or a new one. `isNew` is false when one is already on screen. */
export function openSettingsGuardQuestion(req: SettingsGuardRequest, path: string): { question: SettingsGuardQuestion; isNew: boolean } {
  for (const q of pending.values()) {
    if (q.tabId === req.tabId && q.path === path) return { question: q, isNew: false }
  }
  sequence += 1
  const question: SettingsGuardQuestion = {
    questionId: `${SETTINGS_GUARD_QUESTION_PREFIX}${Date.now()}-${sequence}`,
    tabId: req.tabId, sessionKey: req.sessionKey, path, toolName: req.toolName, toolInput: req.input,
  }
  pending.set(question.questionId, question)
  return { question, isNew: true }
}

export function isSettingsGuardQuestion(questionId: string): boolean {
  return questionId.startsWith(SETTINGS_GUARD_QUESTION_PREFIX)
}

/** Remove and return the question being answered; null when it is unknown (answered already, or from before a restart). */
export function takeSettingsGuardQuestion(questionId: string): SettingsGuardQuestion | null {
  const q = pending.get(questionId) ?? null
  pending.delete(questionId)
  return q
}

export function resetSettingsGuardForTest(): void {
  grants.clear()
  pending.clear()
  sequence = 0
}
