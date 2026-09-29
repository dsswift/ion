/**
 * The request state behind the browser's Save-As / folder prompt.
 *
 * Split from the component deliberately. `BrowserStudioHost` needs to ASK for
 * a path, and the component needs React, the theme and the popover layer --
 * importing the component from the host made a cycle through those modules and
 * left `BrowserStudioHost` undefined at construction time. The question and
 * the widget that renders it are different concerns, and only the question
 * belongs in the host's import graph.
 */
import { rDebug } from '../rendererLogger'

/** Matches `fsSaveDialog`'s resolved shape so callers are host-agnostic. */
export interface SavePathResult {
  filePath: string | null
  error?: string
}

export type PromptKind = 'file' | 'directory'

export interface PendingRequest {
  kind: PromptKind
  defaultPath?: string
  defaultFileName?: string
  resolve: (result: SavePathResult) => void
}

let pending: PendingRequest | null = null
let notify: (() => void) | null = null

/** The mounted prompt component registers its re-render here. */
export function registerPromptHost(fn: (() => void) | null): void {
  notify = fn
}

export function currentRequest(): PendingRequest | null {
  return pending
}

/** Resolve the pending request and clear it. */
export function settleRequest(result: SavePathResult): void {
  const req = pending
  pending = null
  notify?.()
  req?.resolve(result)
}

/**
 * Ask the user for a path to save to. Resolves `{ filePath: null }` on cancel,
 * the same way a dismissed native dialog does.
 *
 * With no prompt host mounted the request resolves as cancelled rather than
 * hanging forever: a promise that never settles leaves the caller's `await`
 * suspended with no error and no log line.
 */
export function promptForSavePath(defaultPath?: string, defaultFileName?: string): Promise<SavePathResult> {
  return promptForPath('file', defaultPath, defaultFileName)
}

/**
 * The directory form. Same promise contract, so `pickDirectory` -- which a
 * browser used to answer with a bare `null`, indistinguishable from the user
 * pressing Cancel -- can now actually ask.
 */
export function promptForDirectory(defaultPath?: string): Promise<SavePathResult> {
  return promptForPath('directory', defaultPath, undefined)
}

function promptForPath(kind: PromptKind, defaultPath?: string, defaultFileName?: string): Promise<SavePathResult> {
  if (!notify) {
    rDebug('save-path-prompt', 'no prompt host mounted; treating as cancelled', { kind, default_file_name: defaultFileName ?? '' })
    return Promise.resolve({ filePath: null, error: 'path prompt is not available' })
  }
  return new Promise<SavePathResult>((resolve) => {
    pending = { kind, defaultPath, defaultFileName, resolve }
    notify?.()
  })
}
