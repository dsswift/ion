/**
 * A headless Studio client on the server's local Unix-socket listener, the
 * same transport scripts/studio-wire-smoke.mts uses over TCP, minus pairing:
 * the local door grants every scope to the same-machine caller.
 */
import WebSocket from 'ws'
import { randomBytes, randomUUID } from 'crypto'
import { encodeFrame, decodeFrame } from '@ion/shared/studio-wire/codec'
import { PROTOCOL_VERSION } from '@ion/shared/studio-wire/version'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { log } from './env.mts'

type ActionResult = Extract<StudioFrame, { type: 'studio_action_result' }>
type Welcome = Extract<StudioFrame, { type: 'studio_welcome' }>

/** A fresh W3C traceparent: version 00, random trace and span ids, sampled. */
export function newTraceparent(): string {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`
}

export class LocalClient {
  private ws!: WebSocket
  private listeners = new Set<(frame: StudioFrame) => void>()
  private readonly socketPath: string
  constructor(socketPath: string) { this.socketPath = socketPath }

  async open(): Promise<Welcome> {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(`ws+unix://${this.socketPath}:/studio`)
      this.ws.once('open', () => resolve())
      this.ws.once('error', (err) => reject(err))
      this.ws.on('message', (data, isBinary) => {
        if (isBinary) return
        let frame: StudioFrame
        try { frame = decodeFrame(data.toString()) } catch (err) { log('undecodable frame dropped', { error: String(err) }); return }
        for (const l of [...this.listeners]) l(frame)
      })
    })
    const welcomeP = this.waitFor((f): f is Welcome | Extract<StudioFrame, { type: 'studio_refused' }> => f.type === 'studio_welcome' || f.type === 'studio_refused', 15_000, 'welcome')
    const clientId = `perf-${randomUUID()}`
    this.send({ type: 'studio_hello', protocolVersion: PROTOCOL_VERSION, clientId, clientKind: 'desktop', capabilities: [], credential: { kind: 'local' } })
    const welcome = await welcomeP
    if (welcome.type === 'studio_refused') throw new Error(`hello refused: ${welcome.reason} ${welcome.detail ?? ''}`)
    log('connected', { environment: welcome.environmentId, engine: welcome.engineVersion, server: welcome.serverVersion, tabs: welcome.snapshot.tabs.length })
    return welcome
  }

  send(frame: StudioFrame): void { this.ws.send(encodeFrame(frame)) }

  on(listener: (frame: StudioFrame) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  waitFor<T extends StudioFrame>(pred: (frame: StudioFrame) => frame is T, timeoutMs: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)) }, timeoutMs)
      const off = this.on((frame) => { if (pred(frame)) { clearTimeout(timer); off(); resolve(frame) } })
    })
  }

  async action(name: string, args: unknown[], traceparent?: string, timeoutMs = 30_000): Promise<unknown> {
    const id = randomUUID()
    const reply = this.waitFor((f): f is ActionResult => f.type === 'studio_action_result' && f.id === id, timeoutMs, `${name} result`)
    const frame: StudioFrame = { type: 'studio_action', id, action: name, args }
    if (traceparent) (frame as { traceparent?: string }).traceparent = traceparent
    this.send(frame)
    const result = await reply
    if (!result.ok) {
      const why = result.refusal ? `${result.refusal.code}: ${result.refusal.message}` : result.error ? `${result.error.code}: ${result.error.message}` : 'unknown'
      throw new Error(`${name} failed: ${why}`)
    }
    return result.value
  }

  /** Submits one prompt with a fresh trace and resolves when the run settles (task_complete, error, or an idle/failed status). */
  async prompt(tabId: string, text: string, timeoutMs: number): Promise<{ end: string; chunks: number; traceparent: string }> {
    let chunks = 0
    const done = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`tab ${tabId}: no completion within ${timeoutMs}ms`)) }, timeoutMs)
      const off = this.on((f) => {
        if (f.type !== 'studio_event') return
        if (f.channel === 'ion:normalized-event') {
          const [evTab, ev] = f.payload as [string, { type: string }]
          if (evTab !== tabId) return
          if (ev.type === 'text_chunk') chunks += 1
          if (ev.type === 'task_complete' || ev.type === 'error') { clearTimeout(timer); off(); resolve(ev.type) }
        } else if (f.channel === 'ion:tab-status-change') {
          const p = f.payload as { tabId: string; status: string }
          if (p.tabId === tabId && (p.status === 'idle' || p.status === 'failed')) { clearTimeout(timer); off(); resolve(`status:${p.status}`) }
        }
      })
    })
    const traceparent = newTraceparent()
    await this.action('submit', [tabId, text, { traceparent }], traceparent)
    const end = await done
    return { end, chunks, traceparent }
  }

  async snapshot(timeoutMs = 15_000): Promise<number> {
    const snapP = this.waitFor((f): f is Extract<StudioFrame, { type: 'studio_snapshot' }> => f.type === 'studio_snapshot', timeoutMs, 'studio_snapshot')
    this.send({ type: 'studio_snapshot_request' })
    return (await snapP).snapshot.tabs.length
  }

  close(): void { this.ws.close() }
}
