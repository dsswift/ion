/**
 * Composer chips — draws reference tokens in the prompt as single, atomic
 * chips while the document stays a plain string.
 *
 * The prompt the operator sends is exactly the editor's text. A chip is only a
 * way of drawing a token that is already in that text: `@desktop/src/foo.ts`
 * for a file mention, `@@terminal:1` / `@@diff:path` for attached context. So
 * drafts, voice input, slash detection, and send all keep working on a string,
 * and there is no second document format to convert to or from.
 *
 * Each chip is a `Decoration.replace` widget registered in
 * `EditorView.atomicRanges`, which is what makes the cursor step over it and
 * Backspace remove it whole.
 */
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder, type Extension } from '@codemirror/state'

export type ComposerChipKind = 'file' | 'terminal' | 'diff'

export interface ComposerChipToken {
  kind: ComposerChipKind
  /** Offset of the token's first character in the text. */
  from: number
  to: number
  /** The whole token as it appears in the text. */
  raw: string
  /** What the token refers to: a relative path, or a context id. */
  ref: string
}

// A file mention starts a word, and must look like a path (a separator or an
// extension dot) so an `@name` aimed at a person stays ordinary text.
// Context tokens carry a doubled `@@` so they can never collide with a path.
const TOKEN_PATTERN = /(^|[\s(])(@@(terminal|diff):[^\s]+|@(?![@\s])[\w\-./\\]*[/.\\][\w\-./\\]*[\w\-/\\])/g

/** Every chip token in `text`, in order. Pure: shared by the editor and send. */
export function findComposerChipTokens(text: string): ComposerChipToken[] {
  const tokens: ComposerChipToken[] = []
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const raw = match[2]
    const from = (match.index ?? 0) + match[1].length
    const contextKind = match[3] as 'terminal' | 'diff' | undefined
    tokens.push(contextKind
      ? { kind: contextKind, from, to: from + raw.length, raw, ref: raw.slice(`@@${contextKind}:`.length) }
      : { kind: 'file', from, to: from + raw.length, raw, ref: raw.slice(1) })
  }
  return tokens
}

/** The short label a chip shows; the whole token is its accessible name. */
export function composerChipLabel(token: Pick<ComposerChipToken, 'kind' | 'ref'>): string {
  if (token.kind === 'terminal') return `Terminal ${token.ref}`
  // A diff token encodes spaces so the token can end at whitespace.
  const segments = token.ref.replace(/%20/g, ' ').split(/[/\\]/).filter(Boolean)
  const base = segments[segments.length - 1] ?? token.ref
  return token.kind === 'diff' ? `Diff ${base}` : base
}

class ChipWidget extends WidgetType {
  constructor(private readonly token: ComposerChipToken) { super() }

  eq(other: ChipWidget): boolean {
    return other.token.raw === this.token.raw
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = `ion-composer-chip ion-composer-chip-${this.token.kind}`
    el.setAttribute('data-composer-chip', this.token.kind)
    el.setAttribute('data-composer-chip-ref', this.token.ref)
    el.setAttribute('aria-label', this.token.raw)
    el.textContent = composerChipLabel(this.token)
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const token of findComposerChipTokens(view.state.doc.toString())) {
    builder.add(token.from, token.to, Decoration.replace({ widget: new ChipWidget(token), inclusive: false }))
  }
  return builder.finish()
}

const chipPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = buildDecorations(view) }
    update(update: ViewUpdate): void {
      if (update.docChanged) this.decorations = buildDecorations(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** The chip extension: drawing plus atomic cursor/delete behavior. */
export function composerChips(): Extension {
  return [
    chipPlugin,
    EditorView.atomicRanges.of((view) => view.plugin(chipPlugin)?.decorations ?? Decoration.none),
  ]
}
