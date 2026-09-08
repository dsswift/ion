/**
 * Windows process-table reader and CIM-JSON parser for terminal activity
 * detection. Windows has no `ps` equivalent as a plain-text CLI, so this
 * uses Get-CimInstance Win32_Process instead — the supported replacement
 * for the deprecated `wmic process` — and parses its JSON output into the
 * same ProcessTreeSnapshot shape terminalProcessTree already consumes.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ProcessTreeSnapshot } from './terminal-process-tree'

const execFileAsync = promisify(execFile)

/** Read one complete process table via PowerShell CIM, as compact JSON. */
export async function readWindowsProcessTable(): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress',
    ],
    { timeout: 3_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  )
  return stdout
}

interface CimProcessEntry {
  ProcessId: number
  ParentProcessId: number
  Name: string
}

/**
 * Parses Get-CimInstance's ConvertTo-Json output into the same
 * ProcessTreeSnapshot shape parseProcessTree produces from `ps` text.
 * ConvertTo-Json emits a bare object (not an array) when exactly one
 * process matches the selection — both shapes are handled.
 */
export function parseCimProcessTree(json: string): ProcessTreeSnapshot {
  const childrenByParent = new Map<number, number[]>()
  const commandByPid = new Map<number, string>()

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { childrenByParent, commandByPid }
  }
  const entries: CimProcessEntry[] = Array.isArray(parsed) ? parsed : parsed ? [parsed as CimProcessEntry] : []

  for (const entry of entries) {
    const pid = Number(entry.ProcessId)
    const parentPid = Number(entry.ParentProcessId)
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0) continue
    commandByPid.set(pid, entry.Name ?? '')
    const children = childrenByParent.get(parentPid) ?? []
    children.push(pid)
    childrenByParent.set(parentPid, children)
  }
  return { childrenByParent, commandByPid }
}
