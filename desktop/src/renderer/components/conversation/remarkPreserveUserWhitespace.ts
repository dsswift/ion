/**
 * remarkPreserveUserWhitespace — make a user message render exactly as typed.
 *
 * CommonMark discards whitespace that a user pasting console output, a stack
 * trace, or indented YAML very much meant to keep. Three distinct losses, all
 * confirmed against the real mdast:
 *
 *   1. A single newline inside a paragraph is a "soft break". The newline DOES
 *      survive in the text node's value, but `remark-rehype` emits the paragraph
 *      as one `<p>` and HTML collapses the newline to a space when rendered.
 *   2. Runs of spaces survive in the value and are likewise collapsed by HTML.
 *   3. Leading whitespace on a continuation line is stripped by the BLOCK parser
 *      before it ever reaches the text value: `"a\n  b"` parses to the value
 *      `"a\nb"`. No CSS rule can bring it back, so it must be restored from the
 *      raw source here.
 *
 * Plus two block-level losses:
 *
 *   4. Blank lines BETWEEN blocks have no mdast node at all. `"a\n\n\nb"`
 *      becomes two adjacent paragraphs at source lines 1 and 4; lines 2 and 3
 *      disappear from the tree unless reconstructed from block positions.
 *   5. A run indented four or more spaces parses as an indented `code` block,
 *      so one accidentally-indented line inside an otherwise-plain paste turns
 *      into a code card sitting beside prose.
 *
 * (1) and (2) are solved by rendering with `white-space: pre-wrap`, but ONLY on
 * the specific elements that own the preserved text. A `pre-wrap` rule on the
 * shared prose container is NOT safe: the hast tree carries structural newline
 * text nodes between block elements — between sibling `<p>`s, between `<li>`s,
 * throughout a `<table>`, and immediately after every `<br>` — and `pre-wrap`
 * turns each of those into a visible blank line. So this plugin marks the
 * paragraphs it touched via `data.hProperties`, and the renderer scopes the CSS
 * to marked elements.
 *
 * (3) and (4) are fixed here, from `file.value`, using node positions. The same
 * approach as t3code's `remarkNormalizeListItemIndentation`: read the real
 * source rather than guessing from the parsed value.
 *
 * ── Why the restored text is emitted as `data.hChildren` ────────────────────
 * Writing the indentation back into an mdast `text` node's `value` is NOT enough,
 * and this is the subtle part. `mdast-util-to-hast`'s text handler pipes every
 * value through `trimLines()` (see its handlers/text.js), which strips leading
 * spaces and tabs after each newline — precisely the characters restored here. An
 * AST-only fix therefore looks correct in a unit test that inspects mdast and
 * silently loses the indentation the moment it converts to hast and renders.
 *
 * So a touched paragraph carries `data.hChildren` holding the final hast nodes.
 * `hChildren` replaces the children wholesale during conversion, so the text
 * handler — and `trimLines` with it — never runs on this content.
 *
 * Fenced code blocks are deliberately untouched — they already render as code
 * cards, and `<pre>` already sets `white-space: pre-wrap`.
 *
 * This runs for USER content only. Assistant and harness messages emit genuine
 * markdown, where collapsing a soft break is correct.
 */
import { visit } from 'unist-util-visit'
import type { Root, Paragraph, Code, Text as MdastText, Parent, PhrasingContent } from 'mdast'

/** The inline mdast kinds `toHastChildren` accepts. */
type MdastContent = PhrasingContent

/** Minimal hast shape — enough for the nodes this plugin emits. */
type HastNode =
  | { type: 'text'; value: string }
  | { type: 'element'; tagName: string; properties: Record<string, unknown>; children: HastNode[] }

/**
 * Marker attribute set on every element whose text carries restored whitespace.
 * The renderer keys its `white-space: pre-wrap` rule on this, so the rule can
 * never reach a list, a table, or the structural newlines between blocks.
 */
export const VERBATIM_DATA_ATTR = 'data-ion-verbatim'
export const BLANK_LINES_DATA_ATTR = 'data-ion-blank-lines'

/** True when a hast node (as handed to a react-markdown component) is marked. */
export function isVerbatimNode(node: unknown): boolean {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties
  return properties?.[VERBATIM_DATA_ATTR] === 'true' || properties?.dataIonVerbatim === 'true'
}

/** Number of source blank lines represented by a synthetic gap paragraph. */
export function blankLineCount(node: unknown): number {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties
  const raw = properties?.[BLANK_LINES_DATA_ATTR] ?? properties?.dataIonBlankLines
  const count = typeof raw === 'number' ? raw : Number(raw)
  return Number.isInteger(count) && count > 0 ? count : 0
}

/** Attach the verbatim marker to an mdast node's hast properties. */
function mark(node: Paragraph | Code): void {
  node.data = node.data ?? {}
  const data = node.data as { hProperties?: Record<string, unknown> }
  data.hProperties = { ...(data.hProperties ?? {}), [VERBATIM_DATA_ATTR]: 'true' }
}

/**
 * Pin a paragraph's rendered children so `trimLines` cannot reach them.
 *
 * Converts the paragraph's inline mdast children to hast by hand. Only the node
 * kinds that can appear in user content after the earlier plugins have run are
 * handled: `text` (verbatim, the whole point), `link` (produced by
 * remarkNavigableLinks, and carrying its marker properties), `inlineCode`,
 * `break`, plus the emphasis wrappers. Anything else is left to the default
 * conversion by returning null, which forfeits verbatim indentation for that
 * paragraph rather than dropping content.
 */
function toHastChildren(children: readonly MdastContent[]): HastNode[] | null {
  const out: HastNode[] = []
  for (const child of children) {
    switch (child.type) {
      case 'text':
        out.push({ type: 'text', value: child.value })
        break
      case 'inlineCode':
        out.push({ type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: child.value }] })
        break
      case 'break':
        out.push({ type: 'element', tagName: 'br', properties: {}, children: [] })
        break
      case 'link': {
        const inner = toHastChildren(child.children)
        if (inner === null) return null
        const data = child.data as { hProperties?: Record<string, unknown> } | undefined
        out.push({
          type: 'element',
          tagName: 'a',
          properties: { href: child.url, ...(data?.hProperties ?? {}) },
          children: inner,
        })
        break
      }
      case 'strong':
      case 'emphasis':
      case 'delete': {
        const inner = toHastChildren(child.children)
        if (inner === null) return null
        const tagName = child.type === 'strong' ? 'strong' : child.type === 'emphasis' ? 'em' : 'del'
        out.push({ type: 'element', tagName, properties: {}, children: inner })
        break
      }
      default:
        // An inline kind this function does not model (an image, raw HTML, a
        // footnote reference). Fall back rather than render it wrong.
        return null
    }
  }
  return out
}

/** Freeze a paragraph's children as hast so trimLines never runs on them. */
function pinChildren(paragraph: Paragraph): void {
  const hChildren = toHastChildren(paragraph.children)
  if (hChildren === null) return
  paragraph.data = paragraph.data ?? {}
  ;(paragraph.data as { hChildren?: HastNode[] }).hChildren = hChildren
}

/**
 * Restore each continuation line's leading whitespace from the source.
 *
 * The text node's value has already lost it, so the line's own source text is
 * re-read and the whitespace between the block's content column and the first
 * non-space character is re-prepended.
 *
 * Anchoring on `contentColumn` (the containing block's start column) is what
 * keeps a blockquote's `> ` marker and a list item's `- ` marker out of the
 * restored text: only whitespace at or after the content column is eligible, and
 * a slice that is not purely whitespace is rejected rather than guessed at.
 */
function restoreIndentation(value: string, sourceLines: string[], startLine: number, contentColumn: number): string {
  const valueLines = value.split('\n')
  if (valueLines.length === 1) return value

  return valueLines
    .map((line, offset) => {
      // The first line begins at the node's own start column: its leading
      // whitespace is the block's indentation, not content, and re-adding it
      // would indent the whole paragraph.
      if (offset === 0) return line
      const sourceLine = sourceLines[startLine - 1 + offset]
      if (sourceLine === undefined) return line
      // Everything from the content column up to where the parsed text resumes.
      const trimmedStart = sourceLine.length - sourceLine.trimStart().length
      if (trimmedStart <= contentColumn) return line
      const candidate = sourceLine.slice(contentColumn, trimmedStart)
      // Only pure whitespace is restorable. Anything else means the column math
      // did not land where expected (an unusual container), so keep the parsed
      // value untouched rather than injecting source characters.
      return /^\s+$/.test(candidate) ? candidate + line : line
    })
    .join('\n')
}

/** The source text of an indented code block, with its indentation intact. */
function verbatimCodeSource(node: Code, sourceLines: string[]): string | null {
  const start = node.position?.start
  const end = node.position?.end
  if (!start?.line || !end?.line) return null
  const lines = sourceLines.slice(start.line - 1, end.line)
  if (lines.length === 0) return null
  // Trailing blank lines belong to the block separation, not the content.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.length > 0 ? lines.join('\n') : null
}

/**
 * True when a `code` node came from an explicit fence rather than indentation.
 * A fenced block is intentional and stays a code block; an indented one is
 * usually accidental alignment in a paste.
 */
function isFenced(node: Code, source: string): boolean {
  const offset = node.position?.start?.offset
  if (offset === undefined) return false
  const char = source[offset]
  return char === '`' || char === '~'
}

/**
 * Reconstruct blank source lines discarded between root block nodes.
 *
 * A block ending on line E and its successor starting on line S have
 * `S - E - 1` source lines between them. CommonMark keeps none of those lines
 * in mdast, so insert one synthetic paragraph carrying the exact count. The
 * renderer gives it one line-height per source line and zero margins.
 *
 * Root-only is intentional: whitespace inside list/quote containers has
 * container semantics and must not be hoisted into standalone visual space.
 */
function restoreRootBlockGaps(tree: Root): void {
  const original = [...tree.children]
  const restored: Root['children'] = []

  for (let index = 0; index < original.length; index += 1) {
    const current = original[index]
    restored.push(current)
    const next = original[index + 1]
    const endLine = current.position?.end.line
    const startLine = next?.position?.start.line
    if (endLine === undefined || startLine === undefined) continue

    const count = startLine - endLine - 1
    if (count <= 0) continue
    restored.push({
      type: 'paragraph',
      children: [{ type: 'text', value: '\u00a0' }],
      data: {
        hProperties: {
          [VERBATIM_DATA_ATTR]: 'true',
          [BLANK_LINES_DATA_ATTR]: count,
          'aria-hidden': 'true',
        },
      },
    })
  }

  tree.children = restored
}

export function remarkPreserveUserWhitespace() {
  return (tree: Root, file: { value?: unknown }) => {
    const source = typeof file.value === 'string' ? file.value : null
    if (source === null) return
    const sourceLines = source.split('\n')

    // Block gaps have already disappeared by this point. Reconstruct them from
    // positions before any node replacement can obscure those positions.
    restoreRootBlockGaps(tree)

    // Indented code blocks become verbatim paragraphs. Done first, and by
    // replacing the node outright, so the text pass below does not also try to
    // reindent content that is already exact.
    visit(tree, 'code', (node: Code, index, parent) => {
      if (!parent || index === undefined) return
      if (node.lang || isFenced(node, source)) return
      const verbatim = verbatimCodeSource(node, sourceLines)
      if (verbatim === null) return
      const paragraph: Paragraph = {
        type: 'paragraph',
        children: [{ type: 'text', value: verbatim }],
        position: node.position,
      }
      mark(paragraph)
      pinChildren(paragraph)
      ;(parent as Parent).children.splice(index, 1, paragraph)
    })

    // Restore continuation indentation on multi-line text, and mark the element
    // that will render it so the renderer can scope `pre-wrap` to exactly it.
    visit(tree, 'text', (node: MdastText, _index, parent) => {
      if (!parent) return
      if (!node.value.includes('\n')) return

      const startLine = node.position?.start?.line
      const blockColumn = (parent as Parent).position?.start?.column
      if (startLine !== undefined && blockColumn !== undefined) {
        node.value = restoreIndentation(node.value, sourceLines, startLine, blockColumn - 1)
      }

      // Marking the direct parent (rather than always the paragraph) keeps the
      // rule on the element that actually contains the newline — inside a
      // blockquote or list item that is the inner paragraph, never the list.
      if (parent.type === 'paragraph') {
        mark(parent as Paragraph)
        // Pin AFTER the value is restored: hChildren is a snapshot, so taking it
        // earlier would freeze the un-restored text.
        pinChildren(parent as Paragraph)
      }
    })
  }
}
