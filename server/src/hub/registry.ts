/**
 * HubRegistry — every server a hub knows: who enrolled, the credential each
 * was issued, its last Fleet Report, and the socket it has open now. The
 * record of each server is kept in `<data dir>/hub-servers.json`, so a hub
 * that restarts still shows every server with its last numbers.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { HUB_PROTOCOL_VERSION, type HubAction, type HubActionResponse, type HubAgentFrame, type HubFrame, type HubRefusal, type HubServer } from '@ion/shared/fleet-hub'
import type { FleetReport } from '@ion/shared/types-fleet'
import { mergeFleetDeploy, parseFleetDeployRecord, type FleetDeploy } from '@ion/shared/types-fleet-deploy'
import type { HostInstallProgress } from '@ion/shared/host-install'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('hub.registry', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('hub.registry', msg, fields)
}

const FILE = 'hub-servers.json'
/** Reports arrive from every server every minute; the file is written at most this often. */
const SAVE_DELAY_MS = 5_000
const ACTION_TIMEOUT_MS = 60_000

interface ServerRecord {
  id: string
  /** The name the server reports under. */
  label: string
  /** The name given on the hub; shown instead of `label`. */
  name?: string
  /** SHA-256 of the credential this server was issued. */
  credentialHash: string
  manage: boolean
  enrolledAt: number
  lastSeenAt: number | null
  readAt: number | null
  report: FleetReport | null
  /** The newest step of the server restarting or installing on itself. */
  install?: HostInstallProgress
}

interface RegistryFile {
  version: 1
  servers: ServerRecord[]
  /** The newest deploys the hub was told of, newest first. Absent in a file written before the hub kept them. */
  deploys?: FleetDeploy[]
  /** Servers an operator removed. Their old credential is answered `removed`; the enrollment token lets one back in. */
  removed: string[]
}

/** The part of a socket the registry uses. */
export interface AgentSocket {
  send(frame: HubFrame): void
  close(): void
}

export type HelloOutcome = { ok: true; id: string; welcome: Extract<HubFrame, { type: 'hub_welcome' }> } | { ok: false; reason: HubRefusal }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const INSTALL_STAGES: ReadonlyArray<HostInstallProgress['stage']> = ['requested', 'refused', 'downloading', 'installing', 'restarting', 'failed', 'completed']
const INSTALL_KINDS: ReadonlyArray<HostInstallProgress['kind']> = ['restart', 'release', 'artifact']

/**
 * Reads a Fleet Report from a server. The hub passes a report on to its page
 * as it came, so it only makes sure of the parts the page walks: an object
 * with a list of accounts and a list of providers.
 */
function parseReport(raw: unknown): FleetReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Partial<FleetReport>
  if (!Array.isArray(r.accounts) || !Array.isArray(r.providers)) return null
  return raw as FleetReport
}

/** Reads an install step from a server, keeping only what the type names. */
function parseInstallProgress(raw: unknown): HostInstallProgress | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const stage = INSTALL_STAGES.find((s) => s === p.stage)
  const kind = INSTALL_KINDS.find((k) => k === p.kind)
  if (!stage || !kind || typeof p.at !== 'number' || !Number.isFinite(p.at)) return null
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value.slice(0, 2_000) : undefined)
  return { stage, kind, at: p.at, ...(text(p.message) ? { message: text(p.message) } : {}), ...(text(p.code) ? { code: text(p.code) } : {}), ...(text(p.version) ? { version: text(p.version) } : {}) }
}

export interface HubRegistryOptions {
  dir: string
  label: string
  enrollmentTokens: readonly string[]
  /** Test seam. */
  actionTimeoutMs?: number
}

export class HubRegistry {
  private readonly servers = new Map<string, ServerRecord>()
  private readonly removed = new Set<string>()
  private deploys: FleetDeploy[] = []
  private readonly sockets = new Map<string, AgentSocket>()
  private readonly pending = new Map<string, { serverId: string; resolve(response: HubActionResponse): void; timer: ReturnType<typeof setTimeout> }>()
  private readonly listeners = new Set<() => void>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private nextActionId = 1

  constructor(private readonly opts: HubRegistryOptions) {
    const path = join(opts.dir, FILE)
    if (!existsSync(path)) return
    try {
      const file = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RegistryFile>
      for (const record of Array.isArray(file.servers) ? file.servers : []) {
        if (typeof record?.id === 'string' && typeof record.credentialHash === 'string') this.servers.set(record.id, record)
      }
      for (const id of Array.isArray(file.removed) ? file.removed : []) if (typeof id === 'string') this.removed.add(id)
      for (const held of Array.isArray(file.deploys) ? file.deploys : []) {
        const record = parseFleetDeployRecord(held)
        if (record && typeof held.receivedAt === 'number') this.deploys.push({ ...record, receivedAt: held.receivedAt, reportedBy: held.reportedBy })
      }
      log('hub servers loaded', { server_count: this.servers.size, removed_count: this.removed.size, deploy_count: this.deploys.length })
    } catch (err) {
      warn('hub-servers.json unreadable; starting with no servers', { error: String(err) })
    }
  }

  /** Judges a server's hello. A server with no credential yet enrolls with a token and is issued one. */
  hello(frame: Extract<HubAgentFrame, { type: 'hub_hello' }>): HelloOutcome {
    if (frame.protocol !== HUB_PROTOCOL_VERSION) {
      warn('hello refused: protocol mismatch', { environment_id: frame.environmentId, protocol: frame.protocol })
      return { ok: false, reason: 'protocol_mismatch' }
    }
    if (typeof frame.environmentId !== 'string' || !frame.environmentId || typeof frame.label !== 'string') {
      warn('hello refused: no server id or label')
      return { ok: false, reason: 'malformed' }
    }
    const id = frame.environmentId
    const record = this.servers.get(id)
    if (typeof frame.credential === 'string' && frame.credential) {
      if (!record) {
        const reason: HubRefusal = this.removed.has(id) ? 'removed' : 'bad_credential'
        warn('hello refused: credential for a server this hub does not hold', { environment_id: id, reason })
        return { ok: false, reason }
      }
      if (!same(sha256(frame.credential), record.credentialHash)) {
        warn('hello refused: credential does not match', { environment_id: id })
        return { ok: false, reason: 'bad_credential' }
      }
      record.label = frame.label
      record.manage = frame.manage === true
      log('server recognised', { environment_id: id, label: frame.label, manage: record.manage })
      return { ok: true, id, welcome: { type: 'hub_welcome', hubLabel: this.opts.label } }
    }
    const token = typeof frame.enrollmentToken === 'string' ? frame.enrollmentToken : ''
    if (!token || !this.opts.enrollmentTokens.some((accepted) => same(sha256(accepted), sha256(token)))) {
      warn('hello refused: enrollment token not accepted', { environment_id: id, has_token: !!token })
      return { ok: false, reason: 'bad_enrollment_token' }
    }
    const credential = randomBytes(32).toString('base64url')
    this.servers.set(id, {
      id,
      label: frame.label,
      name: record?.name,
      credentialHash: sha256(credential),
      manage: frame.manage === true,
      enrolledAt: record?.enrolledAt ?? Date.now(),
      lastSeenAt: record?.lastSeenAt ?? null,
      readAt: record?.readAt ?? null,
      report: record?.report ?? null,
    })
    this.removed.delete(id)
    this.saveNow()
    log('server enrolled', { environment_id: id, label: frame.label, re_enrolled: !!record })
    return { ok: true, id, welcome: { type: 'hub_welcome', hubLabel: this.opts.label, credential } }
  }

  /** The server's socket is open. An older socket of the same server is closed: one server, one link. */
  attach(id: string, socket: AgentSocket): void {
    const previous = this.sockets.get(id)
    if (previous && previous !== socket) {
      // What the old socket was asked is never answered on the new one.
      this.failPending(id, 'the server reconnected before it answered')
      previous.close()
    }
    this.sockets.set(id, socket)
    const record = this.servers.get(id)
    if (record) record.lastSeenAt = Date.now()
    log('server connected', { environment_id: id })
    this.changed()
  }

  detach(id: string, socket: AgentSocket): void {
    if (this.sockets.get(id) !== socket) return
    this.sockets.delete(id)
    const record = this.servers.get(id)
    if (record) record.lastSeenAt = Date.now()
    this.failPending(id, 'the server disconnected before it answered')
    log('server disconnected', { environment_id: id })
    this.changed()
  }

  /** Answers every action still waiting on a server, which will not answer now. */
  private failPending(id: string, error: string): void {
    for (const [actionId, wait] of this.pending) {
      if (wait.serverId !== id) continue
      clearTimeout(wait.timer)
      this.pending.delete(actionId)
      wait.resolve({ ok: false, error })
    }
  }

  report(id: string, raw: unknown): void {
    const record = this.servers.get(id)
    const report = parseReport(raw)
    if (!record || !report) {
      warn('fleet report dropped', { environment_id: id, known_server: !!record, readable: !!report })
      return
    }
    record.report = report
    record.readAt = Date.now()
    record.lastSeenAt = record.readAt
    log('fleet report received', { environment_id: id, account_count: report.accounts.length })
    this.changed()
  }

  /** A deploy's newest record, from the server on the machine that runs it. */
  deploy(id: string, raw: unknown): void {
    const server = this.servers.get(id)
    const record = parseFleetDeployRecord(raw)
    if (!server || !record) {
      warn('deploy record dropped', { environment_id: id, known_server: !!server, readable: !!record })
      return
    }
    const known = this.deploys.some((d) => d.id === record.id)
    this.deploys = mergeFleetDeploy(this.deploys, { ...record, receivedAt: Date.now(), reportedBy: { id, label: server.label } })
    if (!known || record.state !== 'running') log('deploy record received', { environment_id: id, deploy_id: record.id, state: record.state, target_count: record.targets.length, known })
    this.changed()
  }

  /** A step of a server restarting or installing on itself, as it reported it. */
  install(id: string, raw: unknown): void {
    const record = this.servers.get(id)
    const progress = parseInstallProgress(raw)
    if (!record || !progress) {
      warn('install step dropped', { environment_id: id, known_server: !!record, readable: !!progress })
      return
    }
    record.install = progress
    log('install step received', { environment_id: id, stage: progress.stage, kind: progress.kind })
    this.changed()
  }

  /** The newest deploys the hub was told of, newest first. */
  listDeploys(): FleetDeploy[] {
    return this.deploys
  }

  /** An action's answer, from the server `id`. Only the server that was asked may answer. */
  actionResult(id: string, frame: Extract<HubAgentFrame, { type: 'hub_action_result' }>): void {
    const wait = this.pending.get(frame.id)
    if (!wait) return
    if (wait.serverId !== id) {
      warn('action result dropped: not from the server that was asked', { environment_id: id, action_id: frame.id, asked: wait.serverId })
      return
    }
    clearTimeout(wait.timer)
    this.pending.delete(frame.id)
    wait.resolve(frame.ok === true ? { ok: true, value: frame.value } : { ok: false, error: typeof frame.error === 'string' && frame.error ? frame.error.slice(0, 2_000) : 'the server refused' })
  }

  list(): HubServer[] {
    return [...this.servers.values()]
      .map((r) => ({ id: r.id, label: r.name ?? r.label, ...(r.name && r.name !== r.label ? { reportedLabel: r.label } : {}), online: this.sockets.has(r.id), manage: r.manage, enrolledAt: r.enrolledAt, lastSeenAt: r.lastSeenAt, readAt: r.readAt, report: r.report, ...(r.install ? { install: r.install } : {}) }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  }

  /** `unknown`: no such server. `offline`: its socket is closed. `report_only`: it does not run this hub's actions. */
  async action(id: string, action: HubAction, args: unknown[]): Promise<HubActionResponse | 'unknown' | 'offline' | 'report_only'> {
    const record = this.servers.get(id)
    if (!record) return 'unknown'
    const socket = this.sockets.get(id)
    if (!socket) return 'offline'
    if (!record.manage) return 'report_only'
    const actionId = `a${this.nextActionId++}`
    log('action sent to server', { environment_id: id, action, action_id: actionId })
    const response = await new Promise<HubActionResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(actionId)
        resolve({ ok: false, error: 'the server did not answer in time' })
      }, this.opts.actionTimeoutMs ?? ACTION_TIMEOUT_MS)
      this.pending.set(actionId, { serverId: id, resolve, timer })
      socket.send({ type: 'hub_action', id: actionId, action, args })
    })
    log('action answered', { environment_id: id, action, action_id: actionId, ok: response.ok, error: response.ok ? undefined : response.error })
    return response
  }

  /** Gives a server the hub's own name; an empty one goes back to the name it reports under. False when the hub does not hold it. */
  rename(id: string, name: string): boolean {
    const record = this.servers.get(id)
    if (!record) return false
    const trimmed = name.trim().slice(0, 120)
    record.name = trimmed || undefined
    this.saveNow()
    log('server renamed', { environment_id: id, named: !!trimmed })
    for (const listener of this.listeners) listener()
    return true
  }

  /** Forgets a server and closes its socket. False when the hub does not hold it. */
  remove(id: string): boolean {
    if (!this.servers.delete(id)) return false
    this.removed.add(id)
    const socket = this.sockets.get(id)
    if (socket) {
      socket.send({ type: 'hub_refused', reason: 'removed' })
      socket.close()
      this.sockets.delete(id)
    }
    this.failPending(id, 'the server was removed from the hub')
    this.saveNow()
    log('server removed', { environment_id: id })
    for (const listener of this.listeners) listener()
    return true
  }

  /** Called on every change to what `list()` returns. Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveNow()
    for (const wait of this.pending.values()) clearTimeout(wait.timer)
    this.pending.clear()
    for (const socket of this.sockets.values()) socket.close()
    this.sockets.clear()
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DELAY_MS)
  }

  private saveNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    const file: RegistryFile = { version: 1, servers: [...this.servers.values()], removed: [...this.removed], deploys: this.deploys }
    try {
      atomicWriteFileSync(join(this.opts.dir, FILE), JSON.stringify(file), 0o600)
    } catch (err) {
      warn('hub-servers.json could not be written', { error: String(err) })
    }
  }
}
