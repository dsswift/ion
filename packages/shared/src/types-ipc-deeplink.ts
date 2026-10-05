/**
 * An untrusted `ion://` request awaiting the operator's decision.
 *
 * Lives in `shared/` because it crosses the process boundary: main builds it,
 * the preload bridge types it, and the renderer dialog renders it. Every field
 * the operator needs in order to decide is present — the dialog shows the real
 * command or the real prompt text, because a confirmation that describes the
 * request only vaguely trains people to approve without reading.
 */
/**
 * Who presents and answers a confirmation. `overlay` / `studio` are the local
 * desktop's windows, reached by broadcast. `remote` is the client that sent
 * `deeplink.open` (a phone or a browser): the request goes back to it alone in
 * the action's result, and only that connection may answer it.
 */
export type DeepLinkConfirmOwner = 'overlay' | 'studio' | 'remote'

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
  action: 'terminal' | 'prompt' | 'ext'
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
  /**
   * Launch identity (terminal requests). When a pane in the target
   * conversation carries it, approving stops that pane's processes and reuses it.
   */
  key?: string
  /** The prompt that would be sent (prompt requests). */
  text?: string
  /** Whether the prompt would be submitted immediately (prompt requests). */
  submit?: boolean
  /** The extension route id (ext requests). */
  routeId?: string
  /** The route's label as its extension registered it (ext requests). */
  label?: string
  /** The slash command that would run, arguments included (ext requests). */
  command?: string
  /** The conversation the command runs in; absent opens a new one in `dir` (ext requests). */
  conversationId?: string
}

/**
 * Where a navigation link leads, resolved and validated by the server. The
 * client that opened the link moves its own view; nothing runs.
 */
export type DeepLinkNavigateTarget =
  /** A conversation, open in `tabId` (the server opened it if it was not). */
  | { route: 'conversation'; conversationId: string; tabId: string }
  /**
   * A settings page or section. `pageId` is the page holding `panel`.
   * `projectable` says whether the page has settings a phone can show.
   */
  | { route: 'settings'; panel: string; pageId: string; projectable: boolean }
  /** A file inside `dir`; `path` is absolute. */
  | { route: 'file'; dir: string; path: string }

/** The result of `deeplink.open`. */
export type DeepLinkOpenResult =
  | { kind: 'navigate'; target: DeepLinkNavigateTarget }
  /** An action link: show `request`, then answer with `deeplink.confirmResult` and `owner: 'remote'`. */
  | { kind: 'confirm'; id: string; request: DeepLinkConfirmRequest }
  | { kind: 'error'; reason: string }

/** What running an approved deep-link action produced. */
export interface DeepLinkActionOutcome {
  ok: boolean
  error?: string
  /** The conversation the action ran in, when it ran in one. */
  tabId?: string
}
