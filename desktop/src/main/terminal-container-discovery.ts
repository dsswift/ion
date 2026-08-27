import { execFile } from 'child_process'
import { promisify } from 'util'
import type { TerminalActivity, TerminalWebApplication } from '../shared/terminal-activity'

const execFileAsync = promisify(execFile)

interface DockerPort { hostPort: number }

/**
 * Resolve published ports for a live, attached Docker Compose command.
 *
 * Ownership is exact: the Terminal process tree must contain the docker client,
 * and Compose must report containers for that Terminal's cwd. Detached
 * containers are deliberately not attributed after the client exits.
 */
export async function discoverDockerApplications(activity: TerminalActivity): Promise<TerminalWebApplication[]> {
  if (!activity.active || !activity.cwd || activity.processLabel !== 'docker') return []
  try {
    const { stdout: ids } = await execFileAsync('docker', ['compose', '--project-directory', activity.cwd, 'ps', '-q'], { timeout: 2_000, maxBuffer: 128 * 1024 })
    const containerIds = ids.split(/\s+/).filter(Boolean)
    if (containerIds.length === 0) return []
    const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', ...containerIds], { timeout: 2_000, maxBuffer: 512 * 1024 })
    const ports = parseDockerPorts(stdout)
    return ports.map(({ hostPort }) => ({
      id: `container:${hostPort}`,
      kind: 'web',
      url: `http://localhost:${hostPort}`,
      port: hostPort,
      pid: null,
      processName: 'docker',
      source: 'container',
    }))
  } catch {
    // silent-ok: Docker is optional and an unavailable daemon or Compose project is not a discovery failure.
    return []
  }
}

export function parseDockerPorts(stdout: string): DockerPort[] {
  const ports = new Set<number>()
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const mappings = JSON.parse(line) as Record<string, Array<{ HostPort?: string }> | null>
      for (const bindings of Object.values(mappings)) {
        for (const binding of bindings ?? []) {
          const port = Number(binding.HostPort)
          if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port)
        }
      }
    } catch {
      // silent-ok: one malformed Docker inspect row must not discard valid container port mappings.
    }
  }
  return [...ports].sort((a, b) => a - b).map((hostPort) => ({ hostPort }))
}
