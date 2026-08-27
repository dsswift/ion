import { execFile } from 'child_process'
import { promisify } from 'util'
import type { TerminalActivity, TerminalWebApplication } from '../shared/terminal-activity'
import { discoverDockerApplications } from './terminal-container-discovery'

const execFileAsync = promisify(execFile)
const CACHE_TTL_MS = 15_000
const cache = new Map<string, { isWeb: boolean; expiresAt: number }>()
let inFlight: Promise<Map<string, TerminalWebApplication[]>> | null = null

interface Listener { pid: number; host: string; port: number; processName: string | null }

type ListenerLister = () => Promise<string>
type WebProbe = (url: string) => Promise<boolean>

const defaultListenerLister: ListenerLister = async () => {
  const { stdout } = await execFileAsync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pcn'], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  })
  return stdout
}

let listListeners: ListenerLister = defaultListenerLister
let probeWeb: WebProbe = probe

/** Test seam for bounded listener collection and Web Application confirmation. */
export function configureTerminalWebApplicationDiscoveryForTests(overrides: {
  listListeners?: ListenerLister
  probeWeb?: WebProbe
}): void {
  listListeners = overrides.listListeners ?? defaultListenerLister
  probeWeb = overrides.probeWeb ?? probe
  cache.clear()
  inFlight = null
}

export function discoverTerminalWebApplications(activities: readonly TerminalActivity[]): Promise<Map<string, TerminalWebApplication[]>> {
  if (inFlight) return inFlight
  inFlight = scan(activities).finally(() => { inFlight = null })
  return inFlight
}

async function scan(activities: readonly TerminalActivity[]): Promise<Map<string, TerminalWebApplication[]>> {
  const byPid = new Map<number, string>()
  for (const activity of activities) for (const pid of activity.processIds) byPid.set(pid, activity.key)
  if (byPid.size === 0) return new Map()
  const result = new Map<string, TerminalWebApplication[]>()
  for (const listener of parseListeners(await listListeners())) {
    const key = byPid.get(listener.pid)
    if (!key) continue
    const url = await classifyWeb(listener)
    if (!url) continue
    const applications = result.get(key) ?? []
    applications.push({ id: `native:${listener.pid}:${listener.port}`, kind: 'web', url, port: listener.port, pid: listener.pid, processName: listener.processName, source: 'native' })
    result.set(key, applications)
  }
  for (const activity of activities) {
    const applications = result.get(activity.key) ?? []
    for (const candidate of await discoverDockerApplications(activity)) {
      if (await classifyWeb({ pid: candidate.pid ?? 0, host: 'localhost', port: candidate.port, processName: candidate.processName })) {
        applications.push(candidate)
      }
    }
    if (applications.length) result.set(activity.key, applications)
  }
  return result
}

function parseListeners(stdout: string): Listener[] {
  const listeners: Listener[] = []
  let pid: number | null = null
  let processName: string | null = null
  for (const line of stdout.split(/\r?\n/)) {
    const tag = line.charAt(0)
    const value = line.slice(1).trim()
    if (tag === 'p') { const parsed = Number(value); pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null; processName = null }
    else if (tag === 'c') processName = value || null
    else if (tag === 'n' && pid !== null) {
      const trimmed = value.split(' ', 1)[0] ?? ''
      const separator = trimmed.lastIndexOf(':')
      if (separator < 0) continue
      const host = trimmed.slice(0, separator)
      const port = Number(trimmed.slice(separator + 1))
      if (!['*', '127.0.0.1', '[::1]', 'localhost', '::'].includes(host)) continue
      if (Number.isInteger(port) && port > 0 && port < 65536) listeners.push({ pid, host, port, processName })
    }
  }
  return listeners
}

async function classifyWeb(listener: Listener): Promise<string | null> {
  const candidates = listener.host === '[::1]' || listener.host === '::'
    ? [`http://[::1]:${listener.port}`, `https://[::1]:${listener.port}`]
    : [`http://localhost:${listener.port}`, `https://localhost:${listener.port}`]
  for (const url of candidates) {
    const cacheKey = `${url}\0${listener.pid}`
    const cached = cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.isWeb) return url
      continue
    }
    const isWeb = await probeWeb(url)
    cache.set(cacheKey, { isWeb, expiresAt: Date.now() + CACHE_TTL_MS })
    if (isWeb) return url
  }
  return null
}

async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1_000) })
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) return true
    if (!response.ok || response.status === 204 || response.status === 205) return false
    const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    return type === 'text/html' || type === 'application/xhtml+xml'
  } catch {
    // silent-ok: an unavailable local listener is a normal negative Web Application classification.
    return false
  }
}
