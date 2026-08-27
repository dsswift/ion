/**
 * open-file-intent — which surface a clicked FILE should open in.
 *
 * The gesture, not the file type, decides. Before this, an `.html` file went
 * to the source editor from a transcript, a terminal, or a markdown preview,
 * but rendered as a page from the file explorer — the same file, the same
 * modifier, two different results depending on where you clicked it.
 *
 * The three intents:
 *
 *   ⌘-click        view — render it. HTML becomes a page, an image becomes an
 *                  image, anything else opens in the editor because there is
 *                  nothing to render.
 *   ⇧⌘-click       source — always the editor, even for HTML. This is the only
 *                  way to read HTML markup once ⌘-click renders it, which is
 *                  why it needs a gesture of its own rather than being the
 *                  accidental default.
 *   ⌥⌘-click       native — hand it to the operating system. Matches what
 *                  ⌥⌘-click already means for a web link: "not in Ion, in my
 *                  own application."
 *
 * ⇧ and ⌥ are deliberately not combined; a chord that means two opposite
 * things is a coin flip, so `native` wins and is stated here rather than left
 * to whichever branch happens to run first.
 */

/** Modifier fields shared by React and DOM mouse events. */
export interface FileClickModifiers {
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export type FileOpenIntent = 'view' | 'source' | 'native'

/** True when a click is a navigation gesture at all rather than a plain click. */
export function isFileNavigationClick(event: FileClickModifiers | null | undefined): boolean {
  return event?.metaKey === true || event?.ctrlKey === true
}

/**
 * Resolve the intent of a file click.
 *
 * Callers gate on `isFileNavigationClick` first; this only classifies a click
 * already known to be one.
 */
export function fileOpenIntent(event: FileClickModifiers | null | undefined): FileOpenIntent {
  // Checked before shift: ⌥ means "leave Ion", which is the stronger claim.
  if (event?.altKey === true) return 'native'
  if (event?.shiftKey === true) return 'source'
  return 'view'
}

/** Extensions the browser surface can render as a page. */
const RENDERABLE_HTML = new Set(['.html', '.htm'])

export function isRenderableHtml(path: string): boolean {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot >= 0 && RENDERABLE_HTML.has(lower.slice(dot))
}
