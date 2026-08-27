// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every surface that opens a clicked file must use the same gesture rules.
 *
 * The defect this pins: an `.html` file rendered as a page from the file
 * explorer but opened as source everywhere else — same file, same modifier,
 * different result depending on which surface you clicked it in. Each surface
 * had its own hand-rolled branch, so nothing kept them in agreement.
 *
 * Structural rather than behavioural because the failure is a surface being
 * FORGOTTEN. A behavioural test only covers the surfaces someone remembered to
 * write a case for, which is the same blind spot that produced the bug.
 */
const SURFACES = [
  // Transcripts, markdown previews, and anything using navigable links.
  'src/renderer/hooks/useNavigableLinks.tsx',
  // Terminal output paths.
  'src/renderer/components/TerminalInstance.tsx',
  // The file explorer tree.
  'src/renderer/components/FileExplorerRootSection.tsx',
]

function read(relative: string): string {
  return readFileSync(join(process.cwd(), relative), 'utf8')
}

describe('file-open gesture consistency', () => {
  it.each(SURFACES)('%s resolves intent through the shared helper', (surface) => {
    const source = read(surface)
    // A surface that hand-rolls `event.shiftKey` instead of calling this is
    // exactly how the four paths drifted apart before.
    expect(source).toContain('fileOpenIntent(')
  })

  it.each(SURFACES)('%s honours the native-open intent', (surface) => {
    const source = read(surface)
    expect(source).toMatch(/intent === 'native'/)
  })

  it('renders html from the surfaces that can reach a browser', () => {
    // The explorer already rendered HTML; these two are the ones that did not,
    // which is the inconsistency being fixed.
    for (const surface of ['src/renderer/hooks/useNavigableLinks.tsx', 'src/renderer/components/TerminalInstance.tsx']) {
      const source = read(surface)
      expect(source).toContain('isRenderableHtml(')
      expect(source).toContain('router.openHtml(')
    }
  })

  it('falls back to source when no browser surface exists', () => {
    // The Overlay registers no content router. Silently doing nothing would
    // read as a broken click, so HTML degrades to the editor there.
    for (const surface of ['src/renderer/hooks/useNavigableLinks.tsx', 'src/renderer/components/TerminalInstance.tsx']) {
      expect(read(surface)).toContain('no surface router')
    }
  })

  it('keeps every file click gated on cmd', () => {
    // Without this an ordinary click in a transcript would start opening
    // files; ⇧ and ⌥ only choose WHERE, never whether.
    const links = read('src/renderer/hooks/useNavigableLinks.tsx')
    expect(links).toContain('if (!e.metaKey) return')
    expect(read('src/renderer/components/TerminalInstance.tsx')).toContain('if (!event.metaKey) return')
  })
})
