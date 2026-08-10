/**
 * remarkNavigableLinks — rewrite bare file paths and URLs into `link` nodes.
 *
 * Pure remark transformer, deliberately in its own module with NO React, theme,
 * or store imports. `useNavigableLinks.tsx` pulls in the session store and the
 * theme (transitively touching `document` at import time), so a plugin living
 * there could not be loaded by a node-environment test and would drag the store
 * into every markdown surface that only wanted link detection.
 *
 * Why a plugin rather than a `text` component: a `text` entry in
 * react-markdown's `components` map is NEVER invoked — only tag-named components
 * are mapped — so the earlier `text: NavigableText` wiring was dead and cmd-click
 * silently did nothing in rendered prose. Emitting a real `link` node routes
 * through the `a` override, which does fire.
 */
import { visit } from 'unist-util-visit'
import type { Root, Text as MdastText, Link as MdastLink, PhrasingContent } from 'mdast'
import { segmentText } from './link-segments'

/**
 * Marker placed on `link` nodes this plugin synthesizes, so an `a` component
 * override can tell a detected bare path/URL apart from a real markdown link
 * and route the click to the file opener instead of the browser.
 *
 * The value rides `link.data.hProperties`, which `mdast-util-to-hast` copies
 * onto the emitted element — that is what makes it readable from the `node`
 * prop react-markdown passes to the component.
 */
export const NAVIGABLE_DATA_ATTR = 'data-ion-navigable'

/** Reads the marker back off the hast node react-markdown hands a component. */
export function readNavigableKind(node: unknown): 'file' | 'url' | null {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties
  const raw = properties?.[NAVIGABLE_DATA_ATTR] ?? properties?.dataIonNavigable
  return raw === 'file' || raw === 'url' ? raw : null
}

/**
 * Nodes already inside a link are skipped so a markdown link's own label text
 * is never re-linkified, and `code`/`inlineCode` subtrees are untouched (inline
 * code keeps its own NavigableCode path).
 */
export function remarkNavigableLinks() {
  return (tree: Root) => {
    visit(tree, 'text', (node: MdastText, index, parent) => {
      if (!parent || index === undefined) return
      if (parent.type === 'link' || parent.type === 'linkReference') return

      const segments = segmentText(node.value)
      if (segments.length === 1 && segments[0].type === 'plain') return
      if (!segments.some((segment) => segment.type !== 'plain')) return

      const replacement: PhrasingContent[] = segments.map((segment) => {
        if (segment.type === 'plain') {
          return { type: 'text', value: segment.value } satisfies MdastText
        }
        const link: MdastLink = {
          type: 'link',
          // The href is informational for a file segment (the click handler
          // uses the label text), but a real URL still needs it so a plain
          // (non-cmd) click has somewhere sensible to go.
          url: segment.type === 'url' ? segment.value : '',
          children: [{ type: 'text', value: segment.value }],
          data: { hProperties: { [NAVIGABLE_DATA_ATTR]: segment.type } },
        }
        return link
      })

      parent.children.splice(index, 1, ...replacement)
      // Skip past the nodes just inserted so the visitor does not re-examine
      // the text children of the links it created.
      return index + replacement.length
    })
  }
}
