/**
 * Unix process-table reader for terminal activity detection: `ps -eo
 * pid=,ppid=,comm=` in the shape terminal-process-tree.ts's parseProcessTree
 * expects. Split out of terminal-manager.ts so no unix-only literal ('/bin/ps')
 * lives in the platform-dispatching file, matching the Windows sibling
 * (terminal-process-tree-windows.ts).
 */
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** Read one complete process table for every live terminal. */
export async function readUnixProcessTable(): Promise<string> {
  const { stdout } = await execFileAsync('/bin/ps', ['-eo', 'pid=,ppid=,comm='], {
    timeout: 1_000,
    maxBuffer: 512 * 1024,
  })
  return stdout
}
