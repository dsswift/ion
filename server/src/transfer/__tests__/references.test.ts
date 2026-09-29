/**
 * The reference collector finds every form in which a history names a file
 * outside the family's own folders, and nothing inside them.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { collectReferences } from '../references'
import { makeTestPaths } from './fixtures'

describe('collectReferences', () => {
  it('finds plans, attachments, and spilled output by every form, and skips owned folders', () => {
    const paths = makeTestPaths('references')
    const conv = paths.conversationsDir
    const file = (p: string): string => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x'); return p }
    const legacyPlan = file(join(paths.dataDir, 'plans', 'old.md'))
    const toolPlan = file(join(paths.dataDir, 'plans', 'written.md'))
    const attached = file(join(paths.dataDir, 'user-attachments', 'abc.pdf'))
    const image = file(join(paths.dataDir, 'user-images', 'def.png'))
    const foreignSpill = file(join(conv, 'tool-results', 'parent', 'result-1.txt'))
    const ownPlan = file(join(conv, 'c1', 'plans', 'own.md'))
    const ownSpill = file(join(conv, 'tool-results', 'c1', 'result-2.txt'))
    const lines = [
      { meta: true, id: 'c1' },
      { type: 'plan_marker', data: { planFilePath: legacyPlan } },
      { type: 'plan_marker', data: { planFilePath: ownPlan } },
      { type: 'message', data: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: toolPlan } }] } },
      { type: 'message', data: { content: `[Attached file: ${attached}]\n\nread it` } },
      { type: 'message', data: { content: `Full output saved to: ${foreignSpill} — use the Read tool` } },
      { type: 'message', data: { content: `Full output saved to: ${ownSpill} — use the Read tool` } },
      { type: 'message', data: { content: `[Attached plan: ${join(paths.dataDir, 'plans', 'gone.md')}]` } },
    ]
    writeFileSync(join(conv, 'c1.tree.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const tabContent = { instances: [{ messages: [{ attachments: [{ type: 'image', path: image, name: 'def.png' }] }] }] }

    const { references, missing } = collectReferences({
      conversationsDir: conv,
      members: [{ id: 'c1', paths: [join(conv, 'c1.tree.jsonl')] }],
      rootConversationId: 'c1',
      tabData: [tabContent],
    })

    const byPath = new Map(references.map((r) => [r.path, r.kind]))
    expect(byPath.get(legacyPlan)).toBe('plan')
    expect(byPath.get(toolPlan)).toBe('plan')
    expect(byPath.get(attached)).toBe('file')
    expect(byPath.get(image)).toBe('image')
    expect(byPath.get(foreignSpill)).toBe('tool-result')
    expect(byPath.has(ownPlan)).toBe(false)
    expect(byPath.has(ownSpill)).toBe(false)
    expect(missing).toEqual([join(paths.dataDir, 'plans', 'gone.md')])
  })
})
