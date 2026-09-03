/**
 * An untrusted `ion://` request awaiting the operator's decision.
 *
 * Lives in `shared/` because it crosses the process boundary: main builds it,
 * the preload bridge types it, and the renderer dialog renders it. Every field
 * the operator needs in order to decide is present — the dialog shows the real
 * command or the real prompt text, because a confirmation that describes the
 * request only vaguely trains people to approve without reading.
 */
export type DeepLinkConfirmOwner = 'overlay' | 'studio'

export interface DeepLinkConfirmResult {
  id: string
  owner: DeepLinkConfirmOwner
  approved: boolean
  /** Required only when an untrusted terminal link omitted its target. */
  tabId?: string
}

export interface DeepLinkConfirmRequest {
  /** Correlates the operator's answer with the pending request in main. */
  id: string
  /** Exactly one renderer presents and may answer this request. */
  owner: DeepLinkConfirmOwner
  action: 'terminal' | 'prompt'
  /** True when untrusted terminal request needs explicit target selection. */
  selectTab?: boolean
  /** Target conversation id (terminal requests). */
  tabId?: string
  /** Pane label (terminal requests). */
  title?: string
  /** The command that would run (terminal requests). */
  cmd?: string
  /** Working directory. */
  dir?: string
  /** The prompt that would be sent (prompt requests). */
  text?: string
  /** Whether the prompt would be submitted immediately (prompt requests). */
  submit?: boolean
}
