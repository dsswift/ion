// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The click event must survive every hop to the open-intent rules.
 *
 * The defect this pins: ⌘, ⇧⌘, and ⌥⌘ all behaved identically, because each
 * wrapper between the click and the rules declared `onOpenFile: (path: string)
 * => void`. TypeScript accepts a narrower callback where a wider one is
 * expected, so passing a second argument compiled fine and was silently
 * discarded at the first hop.
 *
 * The earlier consistency test missed it entirely: it proved each surface
 * CALLS `fileOpenIntent`, not that the event ever ARRIVES. Those are different
 * claims, and only the second one is the feature.
 *
 * Structural because the break is a type signature in a component nobody
 * thought to check — a behavioural test would need a case per wrapper, which
 * is the same blind spot that let it through.
 */
/** Files that DECLARE the callback type; a narrow one here truncates the chain. */
const DECLARERS = [
  // The markdown component factory used by assistant messages.
  'src/renderer/components/conversation/markdownRenderers.tsx',
  // Code fences, which nest three components deep.
  'src/renderer/components/conversation/CodeBlock.tsx',
  // The link primitives themselves.
  'src/renderer/hooks/useNavigableLinks.tsx',
]

/** Files that WRAP the async opener for React; these must forward the event. */
const WRAPPERS = [
  'src/renderer/components/conversation/AssistantMessage.tsx',
  'src/renderer/components/conversation/UserMarkdown.tsx',
  'src/renderer/components/PlanContent.tsx',
  'src/renderer/components/ResourceContent.tsx',
]

const CARRIERS = [...DECLARERS, ...WRAPPERS]

function read(relative: string): string {
  return readFileSync(join(process.cwd(), relative), 'utf8')
}

describe('click event reaches the open-intent rules', () => {
  it.each(CARRIERS)('%s never declares a path-only opener', (file) => {
    const source = read(file)
    // The exact signature that swallowed the modifiers. A wrapper that
    // re-narrows to one argument breaks the chain again, silently.
    expect(source).not.toMatch(/onOpenFile\??: \(path: string\) => void/)
  })

  it.each(DECLARERS)('%s types the opener with the event', (file) => {
    const source = read(file)
    expect(source).toMatch(/onOpenFile\??: \(path: string, event\?: FileClickModifiers\) => void/)
  })

  it.each(WRAPPERS)('%s accepts the event in its wrapper', (file) => {
    // These do not declare the prop; they build the handler that receives it.
    // A wrapper taking only `path` is where the modifiers died.
    expect(read(file)).toMatch(/\(path: string, event\?: FileClickModifiers\)/)
  })

  it('forwards the event from every void wrapper', () => {
    // These adapt the async opener for React handlers. Dropping the argument
    // here is what made ⇧⌘ and ⌥⌘ behave exactly like ⌘.
    for (const file of WRAPPERS) {
      expect(read(file)).toContain('onOpenFile(path, event)')
    }
  })

  it('forwards the event from the git file row', () => {
    // It already had the event for its own ⌘ check and discarded it.
    expect(read('src/renderer/components/GitFileRow.tsx')).toContain("file.path, e)")
  })
})
