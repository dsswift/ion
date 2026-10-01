#!/usr/bin/env node
// @file-size-exception: one end-to-end smoke run, read top to bottom
/**
 * studio-wire-smoke -- a headless Studio client that proves a remote
 * Environment end to end over the same wire the desktop uses (ADR-033).
 *
 * Steps, each reported PASS/FAIL:
 *   1. pair      mint a pairing link on the host (over ssh) or take --link,
 *                redeem it against POST /auth/pair (X25519, same code path
 *                as the desktop's connections/pairing.ts)
 *   2. connect   GET /auth/config nonce, WebSocket to /studio, studio_hello
 *                with the paired credential, studio_welcome
 *   2b. environment  the Environment page's actions: server.info,
 *                host.toolchains, fs.browse, projects.list, git.author.get,
 *                purge.appraise (admin), transfer.preflight for a repo the
 *                host lacks; then a real clone job of a small public
 *                repository followed by ion:project-job to completion,
 *                registration in projects.list, and removal with its files
 *   3. create    createConversationTab on the remote server; watch the
 *                studio:tabs-sync event carry the new tab back
 *   4. files     fs.readDir on the remote home directory
 *   5. git       git.isRepo on the conversation directory
 *   6. terminal  terminal.create + terminal.write; watch ion:terminal-incoming
 *   7. prompt    submitRemotePrompt; watch ion:normalized-event stream to a
 *                completion (real LLM round trip through the remote engine)
 *   8. snapshot  studio_snapshot_request -> studio_snapshot
 *   9. unpair    auth.revokeClient{self:true} on the run's own pairing, so a
 *                smoke leaves no device row behind (--keep keeps it)
 *
 * usage: scripts/studio-wire-smoke.sh --host devbox.local [--link <ion-studio://...>] [--dir <remote dir>] [--keep] [--delete-tab <id>]...
 *
 * Run from the repo root (imports @ion/shared through the workspace). Node
 * strips the types itself; no build step.
 */
import { execFileSync } from 'child_process'
import { hostname } from 'os'
import WebSocket from 'ws'
import { Bonjour } from 'bonjour-service'
import { generateKeyPair, deriveSharedSecret, createAuthProof } from '@ion/shared/e2e'
import { parsePairingLink } from '@ion/shared/pairing-link'
import { encodeFrame, decodeFrame } from '@ion/shared/studio-wire/codec'
import { sealRelayFrame, openRelayFrame } from '@ion/shared/studio-wire/relay-envelope'
import { PROTOCOL_VERSION } from '@ion/shared/studio-wire/version'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

interface Args { host: string; link?: string; dir?: string; keep: boolean; port: string; deleteTabs: string[] }
function parseArgs(argv: string[]): Args {
  const args: Args = { host: '', keep: false, port: '7331', deleteTabs: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--host') args.host = argv[++i]
    else if (a === '--link') args.link = argv[++i]
    else if (a === '--dir') args.dir = argv[++i]
    else if (a === '--port') args.port = argv[++i]
    else if (a === '--keep') args.keep = true
    else if (a === '--delete-tab') args.deleteTabs.push(argv[++i])
    else throw new Error(`unknown argument ${a}`)
  }
  if (!args.host) throw new Error('--host is required')
  return args
}

const results: Array<{ step: string; ok: boolean; detail: string }> = []
function report(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${step.padEnd(9)} ${detail}\n`)
}

/**
 * A paired client on a sealed TCP listener wraps every frame either way in
 * the AES-256-GCM envelope keyed by the pairing's shared secret, exactly as
 * the desktop's sealed socket does; `sealedSecret` undefined means a plain
 * socket (a server that predates sealed TCP).
 */
class Client {
  private ws!: WebSocket
  private listeners = new Set<(frame: StudioFrame) => void>()
  private readonly wsUrl: string
  private readonly sealedSecret: Buffer | undefined
  constructor(wsUrl: string, sealedSecret?: Buffer) { this.wsUrl = wsUrl; this.sealedSecret = sealedSecret }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl)
      this.ws.once('open', () => resolve())
      this.ws.once('error', (err) => reject(err))
      this.ws.on('message', (data, isBinary) => {
        if (isBinary) return
        let text = data.toString()
        if (this.sealedSecret) {
          const opened = openRelayFrame(text, this.sealedSecret)
          if (!opened || opened.isBinary) return
          text = opened.bytes.toString()
        }
        let frame: StudioFrame
        try { frame = decodeFrame(text) } catch { return }
        for (const l of [...this.listeners]) l(frame)
      })
    })
  }
  send(frame: StudioFrame): void {
    const encoded = encodeFrame(frame)
    this.ws.send(this.sealedSecret ? sealRelayFrame(encoded, this.sealedSecret) : encoded)
  }
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
  async action(name: string, args: unknown[], timeoutMs = 30_000): Promise<unknown> {
    const id = crypto.randomUUID()
    const reply = this.waitFor((f): f is Extract<StudioFrame, { type: 'studio_action_result' }> => f.type === 'studio_action_result' && f.id === id, timeoutMs, `${name} result`)
    this.send({ type: 'studio_action', id, action: name, args })
    const frame = await reply
    if (!frame.ok) throw new Error(`${name} failed: ${frame.refusal ? `${frame.refusal.code}: ${frame.refusal.message}` : frame.error ? `${frame.error.code}: ${frame.error.message}` : 'unknown'}`)
    return frame.value
  }
  close(): void { this.ws.close() }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const httpBase = `http://${args.host}:${args.port}`

  // 1. pair
  let link = args.link
  if (!link) {
    // The bundle's own `ion studio pair`; admin so the purge appraisal step can run.
    const out = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'IgnoreUnknown=WarnWeakCrypto', '-o', 'WarnWeakCrypto=no', args.host, `~/.ion/studio-server/current/bin/ion studio pair --json --label "smoke ${hostname()}" --scopes conversations:read,conversations:operate,terminal:operate,git:write,admin`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    const jsonLine = out.trim().split('\n').reverse().find((l) => l.startsWith('{'))
    link = jsonLine ? (JSON.parse(jsonLine) as { url?: string }).url ?? '' : ''
  }
  const parsed = parsePairingLink(link)
  if (!parsed.ok) { report('pair', false, `link did not parse: ${parsed.reason}`); return 1 }
  const keyPair = generateKeyPair()
  const pairRes = await fetch(`${parsed.link.url}/auth/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: parsed.link.code, peerPublicKey: keyPair.publicKey.toString('base64'), label: `smoke ${hostname()}`, kind: 'desktop', deviceId: `smoke-${hostname()}` }) })
  const pairBody = await pairRes.json() as { clientId?: string; ourPublicKey?: string; scopes?: string[]; error?: string }
  if (pairRes.status !== 200 || !pairBody.clientId || !pairBody.ourPublicKey) { report('pair', false, `POST /auth/pair -> ${pairRes.status} ${pairBody.error ?? ''}`); return 1 }
  const sharedSecret = deriveSharedSecret(keyPair.secretKey, Buffer.from(pairBody.ourPublicKey, 'base64'))
  report('pair', true, `clientId=${pairBody.clientId} scopes=${(pairBody.scopes ?? []).join(',')}`)

  // 2. connect
  const config = await (await fetch(`${httpBase}/auth/config`)).json() as { nonce: string; environmentId: string; label: string; sealedTcp?: boolean }
  // `?client=<id>` asks a sealing server for a sealed socket keyed by this
  // pairing; a server that does not advertise `sealedTcp` gets a plain one.
  const client = config.sealedTcp === true
    ? new Client(`ws://${args.host}:${args.port}/studio?client=${encodeURIComponent(pairBody.clientId)}`, sharedSecret)
    : new Client(`ws://${args.host}:${args.port}/studio`)
  await client.open()
  const welcomeP = client.waitFor((f): f is Extract<StudioFrame, { type: 'studio_welcome' | 'studio_refused' }> => f.type === 'studio_welcome' || f.type === 'studio_refused', 15_000, 'welcome')
  client.send({ type: 'studio_hello', protocolVersion: PROTOCOL_VERSION, clientId: pairBody.clientId, clientKind: 'desktop', capabilities: [], credential: { kind: 'paired', clientId: pairBody.clientId, proof: createAuthProof(config.nonce, sharedSecret) } })
  const welcome = await welcomeP
  if (welcome.type === 'studio_refused') { report('connect', false, `refused: ${welcome.reason} ${welcome.detail ?? ''}`); client.close(); return 1 }
  report('connect', true, `environment=${welcome.label} (${welcome.environmentId}) principal=${welcome.principal.subject} engine=${welcome.engineVersion} server=${welcome.serverVersion} tabs=${welcome.snapshot.tabs.length}`)
  for (const staleTab of args.deleteTabs) {
    await client.action('deleteConversationTab', [staleTab]).then(() => report('purge', true, `deleted ${staleTab}`)).catch((err) => report('purge', false, String(err)))
  }
  const home = (welcome.snapshot.tabs[0]?.workingDirectory ?? '/').replace(/\/[^/]*$/, '') || '/'
  const dir = args.dir ?? welcome.snapshot.tabs[0]?.workingDirectory ?? home

  // 2b. environment
  try {
    const info = await client.action('environment.server.info', []) as { serverVersion: string; engineVersion: string | null; hostname: string; bundle: { version: { server: string } } | null; runningConversations?: number | null; formats?: Array<{ id: string; version: string }> }
    const tools = await client.action('environment.host.toolchains', []) as { tools: Array<{ name: string; path: string | null }> }
    const browse = await client.action('environment.fs.browse', [{ path: '~', showHidden: false }]) as { path: string; entries: unknown[] }
    const projects = await client.action('environment.projects.list', []) as Array<{ dir: string }>
    const author = await client.action('environment.git.author.get', []) as { name: string; email: string }
    const purge = await client.action('environment.purge.appraise', []) as { conversations: number; clonedProjects: unknown[]; bundle: { version: string } | null }
    const preflight = await client.action('transfer.preflight', [{ repoRemote: 'example.org/nobody/nothing', sourceBranch: 'main' }]) as { projectDir: string | null }
    const ok = typeof info.serverVersion === 'string' && Array.isArray(info.formats) && info.formats.some((f) => f.id === 'transfer-archive') && Array.isArray(tools.tools) && browse.path.length > 0 && Array.isArray(projects) && preflight.projectDir === null
    report('environment', ok, `server=${info.serverVersion} engine=${info.engineVersion} transfer=${info.formats?.find((f) => f.id === 'transfer-archive')?.version ?? 'unknown'} running=${info.runningConversations ?? 'unknown'} bundle=${info.bundle?.version.server ?? 'none'} tools=${tools.tools.filter((t) => t.path).map((t) => t.name).join(',') || 'none'} home=${browse.path} (${browse.entries.length} dirs) projects=${projects.length} author=${author.name ? 'set' : 'unset'} conversations=${purge.conversations} clones=${purge.clonedProjects.length}`)
  } catch (err) { report('environment', false, String(err)) }

  // 2b'. LAN discovery: open a one-minute window, find the announcement from
  // THIS machine over mDNS, read the live code, then close the window. A
  // sealed host is a pass too: the seal is the configured behaviour.
  try {
    type Status = { mode: string; advertising: boolean; until: number | null; code: string | null }
    const before = await client.action('environment.discovery.status', []) as Status
    if (before.mode === 'sealed') {
      report('discovery', true, 'sealed by enterprise policy; nothing is announced')
    } else {
      const opened = await client.action('environment.discovery.open', [{ minutes: 1 }]) as Status
      const found = await new Promise<{ label: string; port: number } | null>((resolve) => {
        const bonjour = new Bonjour()
        const done = (value: { label: string; port: number } | null): void => { clearTimeout(timer); try { browser.stop(); bonjour.destroy() } catch { /* best effort */ } resolve(value) }
        const timer = setTimeout(() => done(null), 8000)
        const browser = bonjour.find({ type: 'ion-studio' }, (service) => {
          const txt = (service.txt ?? {}) as Record<string, unknown>
          if (txt.id === welcome.environmentId) done({ label: String(txt.label ?? ''), port: service.port })
        })
      })
      const closed = await client.action('environment.discovery.close', []) as Status
      const codeOk = typeof opened.code === 'string' && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(opened.code)
      const restored = closed.mode === before.mode && closed.code === null
      report('discovery', opened.advertising && codeOk && found !== null && restored, `window opened advertising=${opened.advertising} code=${codeOk ? 'live' : 'missing'} found-over-mdns=${found ? `${found.label}:${found.port}` : 'no'} after-close mode=${closed.mode} (was ${before.mode})`)
    }
  } catch (err) { report('discovery', false, String(err)) }

  // 2c. clone job: a small public repository, followed to completion, then removed with its files.
  try {
    const url = 'https://github.com/octocat/Hello-World.git'
    const parentDir = '~/ion-smoke-clone'
    const jobDone = new Promise<{ phase: string; dir: string; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('clone job did not settle within 120s')) }, 120_000)
      const off = client.on((f) => {
        if (f.type !== 'studio_event' || f.channel !== 'ion:project-job') return
        const job = f.payload as { kind: string; url?: string; phase: string; dir: string; error?: string }
        if (job.kind !== 'clone' || job.url !== url || job.phase === 'running') return
        clearTimeout(timer); off(); resolve(job)
      })
    })
    const started = await client.action('environment.projects.clone', [{ url, parentDir, runSetup: false }]) as { jobId: string; dir: string }
    const job = await jobDone
    const listed = (await client.action('environment.projects.list', []) as Array<{ dir: string; entry: { clonedByIon?: boolean; repoRemote?: string } }>).find((p) => p.dir === started.dir)
    const removed = await client.action('environment.projects.remove', [{ dir: started.dir, deleteFiles: true }]) as { removed: boolean; deletedFiles: boolean }
    const after = (await client.action('environment.projects.list', []) as Array<{ dir: string }>).some((p) => p.dir === started.dir)
    const ok = job.phase === 'done' && !!listed?.entry.clonedByIon && listed.entry.repoRemote === 'github.com/octocat/Hello-World' && removed.deletedFiles && !after
    report('clone', ok, `job=${job.phase}${job.error ? ` ${job.error.split('\n')[0]}` : ''} dir=${started.dir} registered=${!!listed} repoRemote=${listed?.entry.repoRemote ?? ''} removed=${removed.removed}/${removed.deletedFiles} gone=${!after}`)
  } catch (err) { report('clone', false, String(err)) }

  // 3. create
  let tabId = ''
  try {
    // Every tabs-sync is a full projection, and earlier steps can leave one in
    // flight, so wait for the sync that carries the new tab rather than the
    // first one to arrive after the action. Subscribe before acting: the sync
    // can land before the action result does.
    const seen: string[][] = []
    let settle: ((ids: string[]) => void) | undefined
    const off = client.on((f) => {
      if (f.type !== 'studio_event' || f.channel !== 'studio:tabs-sync') return
      const ids = ((f.payload as { tabs?: Array<{ id: string }> }).tabs ?? []).map((t) => t.id)
      seen.push(ids); settle?.(ids)
    })
    tabId = String(await client.action('createConversationTab', [dir, {}]))
    const present = await new Promise<boolean>((resolve) => {
      if (seen.some((ids) => ids.includes(tabId))) { resolve(true); return }
      const timer = setTimeout(() => resolve(false), 15_000)
      settle = (ids) => { if (ids.includes(tabId)) { clearTimeout(timer); resolve(true) } }
    })
    off()
    report('create', present, `tabId=${tabId} dir=${dir} tabs-sync carried it=${present} (${seen.length} syncs seen)`)
  } catch (err) { report('create', false, String(err)) }

  // 4. files
  try {
    const listing = await client.action('fs.readDir', [{ directory: dir }]) as { entries?: unknown[] } | unknown[]
    const count = Array.isArray(listing) ? listing.length : Array.isArray((listing as { entries?: unknown[] }).entries) ? (listing as { entries: unknown[] }).entries.length : -1
    report('files', count >= 0, `fs.readDir ${dir}: ${count} entries`)
  } catch (err) { report('files', false, String(err)) }

  // 5. git
  try {
    const isRepo = await client.action('git.isRepo', [dir])
    report('git', typeof isRepo === 'boolean' || (isRepo !== null && typeof isRepo === 'object'), `git.isRepo ${dir}: ${JSON.stringify(isRepo)}`)
  } catch (err) { report('git', false, String(err)) }

  // 6. terminal
  if (tabId) {
    const key = `${tabId}:smoke`
    let transcript = ''
    let chunks = 0
    try {
      // Output is matched on the accumulated transcript, stripped of the
      // terminal's escape sequences, not chunk by chunk: a pty is free to
      // split the marker across two chunks (ConPTY does, and colours the
      // echoed command line in the middle of it), and a per-chunk test then
      // never sees a whole marker although every byte arrived.
      const dataP = client.waitFor((f): f is Extract<StudioFrame, { type: 'studio_event' }> => {
        if (f.type !== 'studio_event' || f.channel !== 'ion:terminal-incoming' || !Array.isArray(f.payload) || (f.payload as unknown[])[0] !== key) return false
        transcript += String((f.payload as unknown[])[1])
        chunks += 1
        return /ION_SMOKE_[A-Za-z0-9.-]+_OK/.test(transcript.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, ''))
      }, 30_000, 'terminal output')
      // The waiter is armed before create so the first output cannot be
      // missed; if create itself fails the waiter must not become an
      // unhandled rejection when it later times out.
      dataP.catch(() => undefined)
      await client.action('terminal.create', [{ key, cwd: dir }])
      // The shell echoes the typed command back before running it, so the
      // marker must only match once expanded: `$(hostname)` in the echo, a
      // host name in the output. `$(...)` and a bare `hostname` mean the
      // same thing in bash, zsh and PowerShell, so one line serves a
      // Windows host too (`hostname -s` is a POSIX-only flag). The line ends
      // in a carriage return because that is what the Enter key sends: a
      // Unix tty translates it to a newline, while a Windows console reads a
      // bare line feed as shift-enter and waits on a continuation prompt.
      client.send({ type: 'studio_action', id: crypto.randomUUID(), action: 'terminal.write', args: [{ key, data: 'echo ION_SMOKE_$(hostname)_OK\r' }] })
      await dataP
      const token = /ION_SMOKE_[A-Za-z0-9.-]+_OK/.exec(transcript.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, ''))?.[0] ?? ''
      report('terminal', true, `remote shell answered: ${token}`)
    } catch (err) {
      // What did arrive is the diagnosis: no chunks at all is a delivery
      // problem, chunks without the marker is the shell's.
      report('terminal', false, `${String(err)} (${chunks} chunks, transcript tail ${JSON.stringify(transcript.slice(-160))})`)
    }
    // Destroyed on every path: a shell left behind by a failed step is a
    // process the host keeps until someone notices it.
    await client.action('terminal.destroy', [{ key }]).catch(() => undefined)
  }

  // 7. prompt
  if (tabId) {
    try {
      let chunks = 0
      let errorDetail = ''
      const done = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('no completion within 120s')) }, 120_000)
        const off = client.on((f) => {
          if (f.type !== 'studio_event') return
          if (f.channel === 'ion:normalized-event') {
            const [evTab, ev] = f.payload as [string, { type: string; [k: string]: unknown }]
            if (evTab !== tabId) return
            if (ev.type === 'text_chunk') chunks += 1
            if (ev.type === 'error') errorDetail = JSON.stringify(ev).slice(0, 400)
            if (ev.type === 'task_complete' || ev.type === 'error') { clearTimeout(timer); off(); resolve(ev.type) }
          } else if (f.channel === 'ion:enriched-error') {
            const [evTab, error] = f.payload as [string, unknown]
            if (evTab === tabId) errorDetail = JSON.stringify(error).slice(0, 400)
          } else if (f.channel === 'ion:tab-status-change') {
            const p = f.payload as { tabId: string; status: string }
            if (p.tabId === tabId && (p.status === 'idle' || p.status === 'failed')) { clearTimeout(timer); off(); resolve(`status:${p.status}`) }
          }
        })
      })
      await client.action('submitRemotePrompt', [tabId, 'Reply with exactly the single word PONG and nothing else.'])
      const end = await done
      report('prompt', !end.includes('error') && !end.includes('failed'), `streamed ${chunks} text chunks, ended with ${end}${errorDetail ? ` ${errorDetail}` : ''}`)
    } catch (err) { report('prompt', false, String(err)) }
  }

  // 8. snapshot
  try {
    const snapP = client.waitFor((f): f is Extract<StudioFrame, { type: 'studio_snapshot' }> => f.type === 'studio_snapshot', 15_000, 'studio_snapshot')
    client.send({ type: 'studio_snapshot_request' })
    const snap = await snapP
    report('snapshot', snap.snapshot.tabs.some((t) => t.id === tabId), `studio_snapshot: ${snap.snapshot.tabs.length} tabs, includes created tab=${snap.snapshot.tabs.some((t) => t.id === tabId)}`)
  } catch (err) { report('snapshot', false, String(err)) }

  if (tabId && !args.keep) {
    await client.action('deleteConversationTab', [tabId]).then(() => report('cleanup', true, `deleted ${tabId}`)).catch((err) => report('cleanup', false, String(err)))
  } else if (tabId) {
    report('cleanup', true, `kept ${tabId} (--keep)`)
  }
  if (!args.keep) {
    await client.action('auth.revokeClient', [{ clientId: pairBody.clientId, self: true }]).then(() => report('unpair', true, `revoked this run's pairing ${pairBody.clientId}`)).catch((err) => report('unpair', false, String(err)))
  } else {
    report('unpair', true, `kept pairing ${pairBody.clientId} (--keep)`)
  }
  client.close()
  const failed = results.filter((r) => !r.ok).length
  process.stdout.write(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${results.length} steps)\n`)
  return failed === 0 ? 0 : 1
}

main().then((code) => { process.exitCode = code }).catch((err: unknown) => { process.stderr.write(`smoke: ${String(err)}\n`); process.exitCode = 2 })
