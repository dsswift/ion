/**
 * The Fleet Hub: an always-on service servers report to, with the portal
 * that shows and manages them. `node dist/hub.js` runs it; it shares
 * nothing at runtime with a Studio Server but the code it is built from.
 * It reads `hub.json` from the data directory and never talks to an engine.
 */
import { createServer, type Server } from 'http'
import { pathToFileURL } from 'url'
import { realpathSync } from 'fs'
import { BrowserSessionStore } from '../auth/browser-session-store'
import { staticRoute } from '../http/static'
import { dataDir } from '../paths'
import { loadHubConfig, type HubConfig } from './config'
import { attachAgentSocket } from './agent-socket'
import { hubRequestHandler } from './http'
import { HubRegistry } from './registry'
import { log as _log, warn as _warn, error as _error } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('hub.main', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('hub.main', msg, fields)
}

export interface HubHandle {
  server: Server
  registry: HubRegistry
  close(): Promise<void>
}

export interface StartHubOptions {
  dir?: string
  config?: HubConfig
  /** Where the portal's files are. Test seam. */
  webDir?: string
}

export function startHub(options: StartHubOptions = {}): HubHandle {
  const dir = options.dir ?? dataDir()
  const config = options.config ?? loadHubConfig(dir)
  if (!config.oidc) {
    warn('this hub has no sign-in: anyone who can reach it can manage every server that reports to it', { port: config.listen.port })
  } else if (!config.oidc.clientId) {
    throw new Error('hub.json oidc.clientId is required: the hub signs people in through a browser')
  }
  if (config.enrollmentTokens.length === 0) log('this hub has no enrollment token in hub.json: a server joins with one made on its page')
  const registry = new HubRegistry({ dir, label: config.label, enrollmentTokens: config.enrollmentTokens })
  const handler = hubRequestHandler({
    config,
    registry,
    sessions: new BrowserSessionStore(dir),
    portal: staticRoute({ enabled: true, webDir: options.webDir ?? config.webDir, indexFile: 'hub.html' }),
  })
  const server = createServer(handler)
  const closeAgents = attachAgentSocket(server, registry)
  server.on('error', (err) => _error('hub.main', 'hub listener error', { port: config.listen.port, error: String(err) }))
  server.listen(config.listen.port, config.listen.host)
  server.once('listening', () => log('hub listening', { port: config.listen.port, bind_host: config.listen.host ?? '(all interfaces)', label: config.label, sign_in: config.oidc !== null }))
  return {
    server,
    registry,
    close: () => new Promise<void>((resolve) => {
      closeAgents()
      registry.close()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

function isEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    // silent-ok: an entry path that cannot be resolved is not this module
    return false
  }
}

if (isEntry()) {
  const hub = startHub()
  const stop = (signal: string): void => {
    log('hub stopping', { signal })
    void hub.close().then(() => process.exit(0))
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}
