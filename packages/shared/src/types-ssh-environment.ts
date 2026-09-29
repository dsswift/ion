/**
 * The SSH door's progress stream (Settings -> Environments -> Add
 * Environment -> SSH). Main emits one event per stage transition and one
 * per installer output line; the dialog renders them as they arrive so a
 * two-minute first install is never a blank spinner.
 */

export type SshAddEnvironmentStage =
  /** Reaching the host and reading its platform (proves key auth works). */
  | 'connecting'
  /** Piping the installer; the bundle is downloading or extracting on the host. */
  | 'installing'
  /** Opening the loopback forward and waiting for the server behind it. */
  | 'starting'
  /** Minting a pairing link on the host and completing the key exchange. */
  | 'pairing'
  | 'done'
  | 'failed'

export interface SshAddEnvironmentProgress {
  /** The destination as typed, so a dialog can match events to its own request. */
  destination: string
  stage: SshAddEnvironmentStage
  /** One human-readable line: the stage's summary, an installer output line, or the failure. */
  message: string
}

/** What the SSH door returns: the catalog target to persist, or why it stopped. */
export type SshAddEnvironmentResult =
  | { ok: true; target: import('./types-environments').PairedEnvironmentTarget }
  | { ok: false; error: string }
