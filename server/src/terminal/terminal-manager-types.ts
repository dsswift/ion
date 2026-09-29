/**
 * Shapes the terminal manager exposes: the spawner seam and the attach
 * model's lifecycle records.
 */
import type { IPty } from 'node-pty'

/**
 * The `pty.spawn` surface this manager uses.
 *
 * Declared so a test can supply a spawner and observe the environment a PTY
 * would be created with. node-pty is a real native module that loads fine under
 * vitest, so without this seam a test would spawn actual shells and could not
 * inspect the spawn arguments at all.
 */
export type PtySpawner = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => IPty

/** Lifecycle record for a terminal key (D2 attach model). */
export interface TerminalLifecycle {
  running: boolean
  /** Exit code of the last run; null while running or never exited. */
  exitCode: number | null
  /** The cwd the pty was created with (respawn target). */
  cwd: string
  /** True when the requested cwd was dead and the spawn fell back to ~. */
  cwdFellBack: boolean
  /**
   * Why the last spawn attempt produced no PTY, or null. Distinct from
   * `exitCode`: an exit is a shell that ran and finished; this is a shell
   * that never started (node-pty's spawn-helper without its execute bit, a
   * shell binary that is not there). A client that only knew "not running,
   * no exit code" rendered a blinking cursor and nothing else.
   */
  startError: string | null
}

/** Snapshot returned to an attaching client. */
export interface TerminalAttachInfo {
  history: string
  running: boolean
  exitCode: number | null
  cwd: string
  cwdFellBack: boolean
  /** See TerminalLifecycle.startError. */
  startError: string | null
}
