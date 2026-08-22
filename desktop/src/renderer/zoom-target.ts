export type TextZoomTarget = 'data' | 'editor' | 'terminal'

export interface TextZoomContext {
  editorFocused: boolean
  editorOpen: boolean
  editorPreview: boolean
  terminalFocused: boolean
}

/** Resolve text zoom by semantic content class, not panel visibility. */
export function resolveTextZoomTarget(context: TextZoomContext): TextZoomTarget {
  if (context.terminalFocused) return 'terminal'
  if (context.editorFocused && context.editorOpen && !context.editorPreview) return 'editor'
  return 'data'
}
