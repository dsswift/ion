/**
 * HubLink — this server's socket to one Fleet Hub. The server dials out,
 * says who it is, sends its Fleet Report on a timer, and runs the actions
 * the hub asks for when the link allows it. A dropped socket is redialed
 * with backoff; a hub that turns the server away is tried again slowly,
 * except one that removed the server, which is not tried again.
 */
import WebSocket from 'ws'
import { HUB_PROTOCOL_VERSION, hubAgentUrl, isHubAction, type FleetHubState, type HubAction, type HubAgentFrame, type HubFrame, type HubRefusal } from '@ion/shared/fleet-hub'
import type { FleetReport } from '@ion/shared/types-fleet'
import type { FleetDeployRecord } from '@ion/shared/types-fleet-deploy'
import type { HostInstallProgress } from '@ion/shared/host-install'
import { watchSocketLiveness } from '@ion/shared/socket-liveness'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('fleet.hub-link', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('fleet.hub-link', msg, fields)
}

const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 60_000
/** A hub that refused the server is asked again this often: its operator may have fixed the token. */
const REFUSED_RETRY_MS = 5 * 60_000
/** A hub that does not finish the handshake, or does not answer the hello, by now is redialed. */
const ANSWER_TIMEOUT_MS = 15_000

export type HubActionOutcome = { ok: true; value: unknown } | { ok: false; error: string }

export interface HubLinkOptions {
  /** Normalized hub URL. */
  url: string
  manage: boolean
  enrollmentToken: string
  environmentId: string
  label: string
  reportSeconds: number
  credential(): string | null
  saveCredential(credential: string): void
  clearCredential(): void
  buildReport(): Promise<FleetReport>
  runAction(action: HubAction, args: unknown[]): Promise<HubActionOutcome>
  /** What a hub that just welcomed the server is told at once: the deploys still running, and an install under way or just over. */
  standing?(): { deploys: FleetDeployRecord[]; install: HostInstallProgress | null }
  /** Test seam. */
  connect?: (url: string) => WebSocket
}

export interface HubLinkStatus {
  state: FleetHubState
  /** The hub's own name, once it has answered. */
  hubLabel: string | null
  detail?: string
  lastReportAt?: number
}

const REFUSAL_TEXT: Record<HubRefusal, string> = {
  bad_enrollment_token: 'the hub does not accept this enrollment token',
  bad_credential: 'the hub no longer knows this server; enrolling again',
  removed: 'the hub removed this server; add the hub again to rejoin',
  protocol_mismatch: 'the hub speaks a different version',
  malformed: 'the hub could not read this server\'s hello',
}

export class HubLink {
  private ws: WebSocket | null = null
  private closed = false
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private stopLiveness: (() => void) | null = null
  private current: HubLinkStatus = { state: 'connecting', hubLabel: null }
  private readonly waiting = new Set<() => void>()

  constructor(private readonly opts: HubLinkOptions) {}

  get url(): string { return this.opts.url }
  get manage(): boolean { return this.opts.manage }
  status(): HubLinkStatus { return this.current }

  /**
   * Resolves once the link has an answer — the hub welcomed the server, the
   * hub refused it, or the hub did not answer — or after `timeoutMs` with
   * the link still connecting. For a caller that just added the hub and
   * wants to say how it went.
   */
  settled(timeoutMs: number): Promise<void> {
    if (this.current.state !== 'connecting' || this.closed) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.waiting.delete(done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      this.waiting.add(done)
    })
  }

  private setStatus(next: HubLinkStatus): void {
    this.current = next
    if (next.state === 'connecting') return
    for (const done of [...this.waiting]) done()
  }

  start(): void {
    this.dial()
  }

  close(): void {
    this.closed = true
    for (const done of [...this.waiting]) done()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.stopReporting()
    this.ws?.close()
    this.ws = null
    log('hub link closed', { hub_url: this.opts.url })
  }

  private dial(): void {
    if (this.closed) return
    const address = hubAgentUrl(this.opts.url)
    const ws = this.opts.connect ? this.opts.connect(address) : new WebSocket(address, { handshakeTimeout: ANSWER_TIMEOUT_MS })
    this.ws = ws
    let refused = false
    let answerTimer: ReturnType<typeof setTimeout> | null = null
    const answered = (): void => {
      if (answerTimer) clearTimeout(answerTimer)
      answerTimer = null
    }
    ws.on('open', () => {
      answerTimer = setTimeout(() => {
        warn('hub did not answer the hello in time; redialing', { hub_url: this.opts.url })
        ws.terminate()
      }, ANSWER_TIMEOUT_MS)
      const credential = this.opts.credential()
      const hello: HubAgentFrame = {
        type: 'hub_hello',
        protocol: HUB_PROTOCOL_VERSION,
        environmentId: this.opts.environmentId,
        label: this.opts.label,
        manage: this.opts.manage,
        ...(credential ? { credential } : { enrollmentToken: this.opts.enrollmentToken }),
      }
      this.send(hello)
      log('hub link open; hello sent', { hub_url: this.opts.url, enrolling: !credential })
    })
    ws.on('message', (raw: WebSocket.RawData) => {
      const frame = parseFrame(raw)
      if (!frame) {
        warn('hub sent a frame this server cannot read', { hub_url: this.opts.url })
        return
      }
      answered()
      if (frame.type === 'hub_refused') refused = true
      try {
        this.handle(frame)
      } catch (err) {
        // A hub's frame must never take this server down.
        warn('hub frame could not be handled; redialing', { hub_url: this.opts.url, frame_type: frame.type, error: String(err) })
        ws.terminate()
      }
    })
    ws.on('error', (err: Error) => {
      warn('hub link error', { hub_url: this.opts.url, error: String(err) })
    })
    ws.on('close', () => {
      answered()
      if (this.ws !== ws) return
      this.ws = null
      this.stopReporting()
      if (this.closed) return
      if (refused) return
      this.setStatus({ state: 'unreachable', hubLabel: this.current.hubLabel, detail: 'the hub is not answering', lastReportAt: this.current.lastReportAt })
      this.retry(Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_MAX_MS) + Math.random() * 1_000)
      this.attempt += 1
    })
  }

  private handle(frame: HubFrame): void {
    switch (frame.type) {
      case 'hub_welcome': {
        if (frame.credential) this.opts.saveCredential(frame.credential)
        this.attempt = 0
        this.setStatus({ state: 'connected', hubLabel: frame.hubLabel, lastReportAt: this.current.lastReportAt })
        log('hub welcomed this server', { hub_url: this.opts.url, hub_label: frame.hubLabel, enrolled: !!frame.credential })
        this.startReporting()
        this.sendStanding()
        return
      }
      case 'hub_refused': {
        warn('hub refused this server', { hub_url: this.opts.url, reason: frame.reason })
        this.setStatus({ state: 'refused', hubLabel: this.current.hubLabel, detail: REFUSAL_TEXT[frame.reason] ?? frame.reason })
        this.ws?.close()
        if (frame.reason === 'removed') {
          // Rejoining a hub that removed the server is an admin's call, made by adding the hub again.
          this.opts.clearCredential()
          return
        }
        if (frame.reason === 'bad_credential') {
          // The hub lost its record of this server. The enrollment token is still this server's to present.
          this.opts.clearCredential()
          this.retry(BACKOFF_BASE_MS)
          return
        }
        this.retry(REFUSED_RETRY_MS)
        return
      }
      case 'hub_action':
        void this.runAction(frame.id, frame.action, frame.args)
        return
    }
  }

  private async runAction(id: string, action: unknown, args: unknown): Promise<void> {
    if (!this.opts.manage) {
      warn('hub action refused: this link only reports', { hub_url: this.opts.url, action })
      this.send({ type: 'hub_action_result', id, ok: false, error: 'this server only reports to this hub' })
      return
    }
    if (!isHubAction(action)) {
      warn('hub action refused: not an action a hub may ask for', { hub_url: this.opts.url, action })
      this.send({ type: 'hub_action_result', id, ok: false, error: 'not an action a hub may ask for' })
      return
    }
    log('hub action started', { hub_url: this.opts.url, action, action_id: id })
    let outcome: HubActionOutcome
    try {
      outcome = await this.opts.runAction(action, Array.isArray(args) ? args : [])
    } catch (err) {
      outcome = { ok: false, error: String(err) }
    }
    log('hub action finished', { hub_url: this.opts.url, action, action_id: id, ok: outcome.ok, error: outcome.ok ? undefined : outcome.error })
    this.send(outcome.ok ? { type: 'hub_action_result', id, ok: true, value: outcome.value } : { type: 'hub_action_result', id, ok: false, error: outcome.error })
    // What the action changed is what the hub's page should show next.
    void this.report()
  }

  private startReporting(): void {
    this.stopReporting()
    const ws = this.ws
    if (ws) this.stopLiveness = watchSocketLiveness(ws, { onDead: () => warn('hub link went quiet; closing it', { hub_url: this.opts.url }) })
    void this.report()
    this.reportTimer = setInterval(() => void this.report(), this.opts.reportSeconds * 1_000)
  }

  private stopReporting(): void {
    if (this.reportTimer) clearInterval(this.reportTimer)
    this.reportTimer = null
    this.stopLiveness?.()
    this.stopLiveness = null
  }

  private async report(): Promise<void> {
    if (this.current.state !== 'connected') return
    try {
      const report = await this.opts.buildReport()
      if (!this.send({ type: 'hub_report', report })) return
      this.current = { ...this.current, lastReportAt: Date.now() }
      log('fleet report sent to hub', { hub_url: this.opts.url, account_count: report.accounts.length })
    } catch (err) {
      warn('fleet report for hub could not be built', { hub_url: this.opts.url, error: String(err) })
    }
  }

  /** Tells the hub of a deploy's newest record. False when the link is not open; the next welcome sends what still stands. */
  sendDeploy(deploy: FleetDeployRecord): boolean {
    return this.current.state === 'connected' && this.send({ type: 'hub_deploy', deploy })
  }

  /** Tells the hub of a step of this server's own restart or install. */
  sendInstall(progress: HostInstallProgress): boolean {
    return this.current.state === 'connected' && this.send({ type: 'hub_install', progress })
  }

  /** A hub that was not listening while a deploy or an install went on is told where each stands. */
  private sendStanding(): void {
    const standing = this.opts.standing?.()
    if (!standing) return
    for (const deploy of standing.deploys) this.sendDeploy(deploy)
    if (standing.install) this.sendInstall(standing.install)
    log('hub told what stands', { hub_url: this.opts.url, deploy_count: standing.deploys.length, install_stage: standing.install?.stage ?? '' })
  }

  private send(frame: HubAgentFrame): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(frame))
    return true
  }

  private retry(delayMs: number): void {
    if (this.closed) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    log('hub link will redial', { hub_url: this.opts.url, delay_ms: Math.round(delayMs) })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.dial()
    }, delayMs)
  }
}

function parseFrame(raw: WebSocket.RawData): HubFrame | null {
  try {
    const frame = JSON.parse(String(raw)) as Record<string, unknown> | null
    if (!frame || typeof frame !== 'object') return null
    const text = (value: unknown): value is string => typeof value === 'string' && value !== ''
    if (frame.type === 'hub_welcome' && text(frame.hubLabel) && (frame.credential === undefined || text(frame.credential))) return frame as HubFrame
    if (frame.type === 'hub_refused' && text(frame.reason)) return frame as HubFrame
    if (frame.type === 'hub_action' && text(frame.id)) return frame as HubFrame
    return null
  } catch {
    // silent-ok: the caller logs the unreadable frame
    return null
  }
}
