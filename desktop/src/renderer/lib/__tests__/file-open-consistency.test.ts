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
/** Where a clicked file path is decided: transcripts, terminals, and markdown previews all call it. */
const FILE_LINK = 'src/renderer/lib/open-file-link.ts'

const DECIDERS = [
  FILE_LINK,
  // The file explorer tree.
  'src/renderer/components/FileExplorerRootSection.tsx',
]

/** Surfaces that open a clicked path; each must hand it to the shared handler rather than decide itself. */
const LINK_SURFACES = [
  // Transcripts, plans, resources, and anything using navigable links.
  'src/renderer/hooks/useNavigableLinks.tsx',
  // Terminal output paths.
  'src/renderer/components/TerminalInstance.tsx',
  // Links inside a previewed markdown file.
  'src/renderer/components/FileEditorPreview.tsx',
]

function read(relative: string): string {
  return readFileSync(join(process.cwd(), relative), 'utf8')
}

describe('file-open gesture consistency', () => {
  it.each(DECIDERS)('%s resolves intent through the shared helper', (surface) => {
    const source = read(surface)
    // A surface that hand-rolls `event.shiftKey` instead of calling this is
    // exactly how the four paths drifted apart before.
    expect(source).toContain('fileOpenIntent(')
  })

  it.each(DECIDERS)('%s honours the native-open intent', (surface) => {
    expect(read(surface)).toMatch(/intent === 'native'/)
  })

  it.each(LINK_SURFACES)('%s opens clicked paths through the shared file-link handler', (surface) => {
    const source = read(surface)
    expect(source).toContain('openFileLink(')
    expect(source).not.toContain('fsOpenNative(')
  })

  it('renders html where a browser surface can reach the file, and falls back to source otherwise', () => {
    const source = read(FILE_LINK)
    expect(source).toContain('isRenderableHtml(')
    expect(source).toContain('router.openHtml(')
    // The Overlay registers no content router. Silently doing nothing would
    // read as a broken click, so HTML degrades to the editor there.
    expect(source).toContain('The Overlay has no browser surface')
  })

  it('keeps every file click gated on the platform mod key', () => {
    // Without this an ordinary click in a transcript would start opening
    // files; ⇧ and ⌥ only choose WHERE, never whether. isModKey is Cmd on
    // macOS, Ctrl elsewhere (mod-key.ts) — the gate itself must be
    // platform-aware, not a bare metaKey check that never fires on Windows.
    const links = read('src/renderer/hooks/useNavigableLinks.tsx')
    expect(links).toContain('if (!isModKey(e)) return')
    expect(read('src/renderer/components/TerminalInstance.tsx')).toContain('if (!isModKey(event)) return')
  })
})
