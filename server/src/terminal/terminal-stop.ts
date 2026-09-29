/**
 * Stop everything a terminal is running, so its key can take a fresh shell.
 *
 * Killing the shell alone is not enough. A service started from it (`func
 * start`, `dotnet watch`, `npm run dev`) often outlives a hung-up shell, keeps
 * its port, and makes the next launch of the same service fail to bind. So the
 * whole process tree under the shell is read first, asked to stop, given a
 * grace period, and force-killed if it is still there.
 */
import type { IPty } from 'node-pty'
import { parseProcessTree, terminalProcessTree, type ProcessTreeSnapshot } from './terminal-process-tree'
import { readUnixProcessTable } from './terminal-process-tree-unix'
import { readWindowsProcessTable, parseCimProcessTree } from './terminal-process-tree-windows'

/** Read one complete process table for this platform. */
export async function readProcessSnapshot(): Promise<ProcessTreeSnapshot> {
  return process.platform === 'win32'
    ? parseCimProcessTree(await readWindowsProcessTable())
    : parseProcessTree(await readUnixProcessTable())
}

export interface TerminalStopDeps {
  readSnapshot: () => Promise<ProcessTreeSnapshot>
  /** Send a signal; false when the process is already gone. */
  signal: (pid: number, sig: NodeJS.Signals) => boolean
  isAlive: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
  /** Time the tree gets to exit on its own before it is force-killed. */
  graceMs: number
  /** Time force-killed processes get to disappear before the stop reports survivors. */
  forceWaitMs: number
}

export interface TerminalStopOutcome {
  /** Processes under the shell when the stop began. */
  descendants: number[]
  /** Processes still alive after the grace period, which were force-killed. */
  forced: number[]
  /** Processes still alive after the force kill. Non-empty means a leak. */
  survivors: number[]
  shellExited: boolean
  /** Set when the process table could not be read; only the shell was stopped. */
  treeError: string | null
}

function signalProcess(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig)
    return true
  } catch {
    // silent-ok: ESRCH means the process exited between the table read and
    // the signal, which is the outcome the stop wants.
    return false
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export const defaultTerminalStopDeps: TerminalStopDeps = {
  readSnapshot: readProcessSnapshot,
  signal: signalProcess,
  isAlive: processIsAlive,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  graceMs: 5_000,
  forceWaitMs: 1_000,
}

const POLL_MS = 100

/**
 * Stop `term` and every process under it.
 *
 * `shellExited` must resolve when the PTY reports its exit. The shell's own pid
 * cannot be polled: it stays a zombie of this process until node-pty reaps it,
 * and the exit event is what says the reap happened.
 */
export async function stopTerminalProcesses(
  term: Pick<IPty, 'pid' | 'kill'>,
  shellExited: Promise<void>,
  deps: TerminalStopDeps = defaultTerminalStopDeps,
): Promise<TerminalStopOutcome> {
  let exited = false
  void shellExited.then(() => { exited = true })

  let descendants: number[] = []
  let treeError: string | null = null
  try {
    descendants = terminalProcessTree(await deps.readSnapshot(), term.pid).processIds.filter((pid) => pid !== term.pid)
  } catch (err: unknown) {
    treeError = String(err)
  }

  for (const pid of descendants) deps.signal(pid, 'SIGTERM')
  try {
    term.kill()
  } catch {
    // silent-ok: the shell already exited; the exit promise records it.
  }

  const alive = (): number[] => descendants.filter((pid) => deps.isAlive(pid))
  const settled = (): boolean => exited && alive().length === 0

  for (let waited = 0; waited < deps.graceMs && !settled(); waited += POLL_MS) {
    await deps.sleep(POLL_MS)
  }

  const forced = alive()
  for (const pid of forced) deps.signal(pid, 'SIGKILL')
  if (!exited) {
    try {
      term.kill('SIGKILL')
    } catch {
      // silent-ok: the shell exited during the last poll, or the platform
      // takes no signal argument (Windows ConPTY), where the first kill()
      // already terminated it.
    }
  }
  for (let waited = 0; waited < deps.forceWaitMs && !settled(); waited += POLL_MS) {
    await deps.sleep(POLL_MS)
  }

  return { descendants, forced, survivors: alive(), shellExited: exited, treeError }
}
