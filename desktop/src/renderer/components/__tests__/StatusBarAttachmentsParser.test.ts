import { describe, it, expect } from 'vitest'
import { hasPlanFileBeenWritten, isPlanImplementedInMessages, latestPlanPathFromMessages, parseAttachmentsFromMessages } from '../StatusBarAttachmentsParser'
import { formatImplementDivider } from '../../../shared/clear-divider'

/**
 * Pins the attachment-detection logic that powers the engine-tab
 * attachments popover. Regression target: conversations that contain
 * plans (e.g. `1780786340847-cb337ae4b3d0`) were showing an empty
 * attachments panel because the panel read from `tab.messages` and
 * `tab.planFilePath` — both of which are blank on engine tabs.
 *
 * The fix wired the parser to walk the engine's per-instance message
 * array AND to detect plans from `Write`/`Edit`/`NotebookEdit` tool
 * calls targeting `**\/plans/*.md`. This file pins those branches so
 * a future refactor can't silently regress engine plan detection.
 */
describe('parseAttachmentsFromMessages — engine plan detection', () => {
  it('surfaces plans written via the Write tool', () => {
    const messages = [
      {
        role: 'user',
        content: 'Make a plan for X',
      },
      {
        role: 'tool',
        content: 'Successfully wrote',
        toolName: 'Write',
        toolInput: JSON.stringify({
          file_path: '/Users/josh/.ion/plans/crisp-thinking-honey.md',
          content: '# A plan',
        }),
      },
    ]
    const out = parseAttachmentsFromMessages(messages, null)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'plan',
      name: 'crisp-thinking-honey.md',
      path: '/Users/josh/.ion/plans/crisp-thinking-honey.md',
    })
  })

  it('surfaces plans written via the Edit tool', () => {
    const messages = [
      {
        role: 'tool',
        content: '',
        toolName: 'Edit',
        toolInput: JSON.stringify({
          file_path: '/Users/josh/.ion/plans/my-plan.md',
          old_string: 'a',
          new_string: 'b',
        }),
      },
    ]
    const out = parseAttachmentsFromMessages(messages, null)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('plan')
  })

  it('falls back to a regex when toolInput is still streaming partial JSON', () => {
    // During streaming, `toolInput` may be incomplete JSON. The
    // parser falls back to a substring regex so plans become visible
    // before the stream finishes.
    const messages = [
      {
        role: 'tool',
        content: '',
        toolName: 'Write',
        toolInput: '{"file_path":"/Users/josh/.ion/plans/streaming.md","content":"# part',
      },
    ]
    const out = parseAttachmentsFromMessages(messages, null)
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe('/Users/josh/.ion/plans/streaming.md')
  })

  it('ignores Write tool calls to non-plan files', () => {
    const messages = [
      {
        role: 'tool',
        content: '',
        toolName: 'Write',
        toolInput: JSON.stringify({
          file_path: '/Users/josh/.ion/conversations/somefile.jsonl',
          content: 'unrelated',
        }),
      },
      {
        role: 'tool',
        content: '',
        toolName: 'Write',
        toolInput: JSON.stringify({
          file_path: '/Users/josh/src/repo/README.md',
          content: 'not a plan',
        }),
      },
    ]
    const out = parseAttachmentsFromMessages(messages, null)
    expect(out).toEqual([])
  })

  it('ignores non-plan-writing tools even if they target a plan path', () => {
    // `Read` on a plan file isn't an attachment — it's just an agent
    // looking at the file. Only writes/edits create plan attachments.
    const messages = [
      {
        role: 'tool',
        content: '',
        toolName: 'Read',
        toolInput: JSON.stringify({
          file_path: '/Users/josh/.ion/plans/already-existing.md',
        }),
      },
    ]
    const out = parseAttachmentsFromMessages(messages, null)
    expect(out).toEqual([])
  })

  it('surfaces plans from the engine plan-mode system divider', () => {
    const messages = [
      {
        role: 'system',
        content: '── Plan created',
        planFilePath: '/Users/josh/.ion/plans/divider-plan.md',
      },
    ]
    const out = parseAttachmentsFromMessages(messages, null)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'plan',
      name: 'divider-plan.md',
    })
  })

  it('surfaces structured attachments on engine user messages', () => {
    // Engine user messages carry structured `attachments` populated
    // by `submitEnginePrompt`. Our fix adds these to the persistence
    // projection so they survive reload — pin the read side here.
    const messages = [
      {
        role: 'user',
        content: 'check this',
        attachments: [
          { type: 'image', name: 'shot.png', path: '/tmp/shot.png' },
          { type: 'file', name: 'notes.txt', path: '/tmp/notes.txt' },
        ],
      },
    ]
    const out = parseAttachmentsFromMessages(messages, null)
    expect(out).toHaveLength(2)
    expect(out.map((a) => a.kind).sort()).toEqual(['file', 'image'])
  })

  it('deduplicates the same plan path across multiple tool calls', () => {
    // The agent may Edit a plan multiple times in one conversation.
    // The panel should show one entry per unique plan path, not one
    // per edit.
    const messages = [
      {
        role: 'tool',
        content: '',
        toolName: 'Write',
        toolInput: JSON.stringify({ file_path: '/Users/josh/.ion/plans/p.md', content: 'v1' }),
      },
      {
        role: 'tool',
        content: '',
        toolName: 'Edit',
        toolInput: JSON.stringify({ file_path: '/Users/josh/.ion/plans/p.md', old_string: 'a', new_string: 'b' }),
      },
      {
        role: 'tool',
        content: '',
        toolName: 'Edit',
        toolInput: JSON.stringify({ file_path: '/Users/josh/.ion/plans/p.md', old_string: 'b', new_string: 'c' }),
      },
    ]
    const out = parseAttachmentsFromMessages(messages, null)
    expect(out).toHaveLength(1)
  })

  it('matches workspace-local plans/ directories, not just ~/.ion/plans/', () => {
    // A repository may vendor its own plans directory. The PLAN_PATH_RE
    // is intentionally looser than "exactly ~/.ion/plans/" so we
    // surface those too.
    const messages = [
      {
        role: 'tool',
        content: '',
        toolName: 'Write',
        toolInput: JSON.stringify({
          file_path: '/Users/josh/src/repo/docs/plans/feature-x.md',
          content: '# plan',
        }),
      },
    ]
    const out = parseAttachmentsFromMessages(messages, null)
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('feature-x.md')
  })

  it('keeps the conversation `tab.planFilePath` flow working', () => {
    // Conversation tabs surface the current plan via `tab.planFilePath`
    // (populated by the `plan_proposal` event). Engine tabs don't use
    // this path, but the parser still honors the parameter for
    // explicit conversation flows.
    const out = parseAttachmentsFromMessages([], '/Users/josh/.ion/plans/current.md')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'plan',
      name: 'current.md',
    })
  })

  it('surfaces engine-generated image attachments on tool messages', () => {
    // Tool-returned images are attached to the producing `role: 'tool'`
    // message by event-slice-images.ts. The panel must surface them
    // alongside user uploads. Without the tool/assistant branch this is
    // dropped (the old parser only read user-message attachments).
    const messages = [
      {
        role: 'tool',
        content: 'rendered chart',
        toolName: 'render_chart',
        attachments: [
          { type: 'image', name: 'a1b2.png', path: '/Users/josh/.ion/conversations/c1/images/a1b2.png' },
        ],
      },
    ]
    const out = parseAttachmentsFromMessages(messages, null)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'image',
      name: 'a1b2.png',
      path: '/Users/josh/.ion/conversations/c1/images/a1b2.png',
    })
  })

  it('surfaces provider-generated image attachments on assistant messages', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'here is the image',
        attachments: [
          { type: 'image', name: 'gen.png', path: '/Users/josh/.ion/conversations/c1/images/gen.png' },
        ],
      },
    ]
    const out = parseAttachmentsFromMessages(messages, null)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('image')
  })

  it('ignores non-image attachments on tool/assistant messages', () => {
    // Only images are surfaced from tool/assistant turns; a stray
    // non-image attachment must not leak into the panel via this branch.
    const messages = [
      {
        role: 'tool',
        content: '',
        toolName: 'x',
        attachments: [{ type: 'file', name: 'data.bin', path: '/tmp/data.bin' }],
      },
    ]
    const out = parseAttachmentsFromMessages(messages, null)
    expect(out).toEqual([])
  })
})


describe('latestPlanPathFromMessages', () => {
  it('keeps live current plan authoritative over transcript history', () => {
    expect(latestPlanPathFromMessages([
      { role: 'system', content: '── Implementing plan', planFilePath: '/plans/previous.md' },
    ], '/plans/current.md')).toBe('/plans/current.md')
  })

  it('uses latest transcript plan after Implement clears current plan path', () => {
    expect(latestPlanPathFromMessages([
      { role: 'tool', content: '', toolName: 'Write', toolInput: JSON.stringify({ file_path: '/plans/first.md' }) },
      { role: 'system', content: '── Implementing plan', planFilePath: '/plans/first.md' },
    ], null)).toBe('/plans/first.md')
  })

  it('uses transcript order, not deduplicated attachment order, for later plans', () => {
    expect(latestPlanPathFromMessages([
      { role: 'tool', content: '', toolName: 'Write', toolInput: JSON.stringify({ file_path: '/plans/first.md' }) },
      { role: 'system', content: '── Implementing plan', planFilePath: '/plans/first.md' },
      { role: 'tool', content: '', toolName: 'Write', toolInput: JSON.stringify({ file_path: '/plans/second.md' }) },
    ], null)).toBe('/plans/second.md')
  })
})


describe('hasPlanFileBeenWritten', () => {
  it('distinguishes a reserved path from an engine-confirmed authored plan', () => {
    const path = '/plans/reserved.md'
    expect(hasPlanFileBeenWritten([], path)).toBe(false)
    expect(hasPlanFileBeenWritten([
      { role: 'system', content: '── Plan created at 1:00 PM · reserved ──', planFilePath: path },
    ], path)).toBe(true)
  })
})

/**
 * isPlanImplementedInMessages — the "Implemented" badge reads recorded
 * evidence, not an absence.
 *
 * REGRESSION: PlanSurface derived `implemented` as
 * `!!planFilePath && !instance.planFilePath` — i.e. "we know a plan path from
 * history but the instance field is empty." The implement flow does clear that
 * field as its last step, so the shape matched. But EVERY other path that nulls
 * the field produces the identical shape, so the badge asserted an
 * implementation that never happened. This was observed alongside the lost
 * Plan Ready card: the same conversation kept its plan path while its card was
 * cleared by an unrelated lifecycle event.
 *
 * The implementationPhase field is the durable engine record. A live implement
 * divider is also positive evidence. Absence of a field is not evidence.
 */
describe('isPlanImplementedInMessages', () => {
  const path = '/Users/x/.ion/plans/tidy-mixing-brook.md'
  const slug = 'tidy-mixing-brook'

  it('is true when an implement divider for that plan is in the transcript', () => {
    const messages = [
      { role: 'assistant', content: 'here is the plan' },
      { role: 'system', content: formatImplementDivider(new Date(), slug) },
    ]
    expect(isPlanImplementedInMessages(messages, path)).toBe(true)
  })

  it('is true when a durable implementation turn follows that plan', () => {
    const messages = [
      { role: 'system', content: '── Plan created at 1:00 PM · tidy-mixing-brook ──', planFilePath: path },
      { role: 'user', content: 'Implement the following plan:\n\n# Plan', implementationPhase: true },
    ]
    expect(isPlanImplementedInMessages(messages, path)).toBe(true)
  })

  it('does not use an older plan implementation for a newer plan', () => {
    const newerPath = '/Users/x/.ion/plans/newer-plan.md'
    const messages = [
      { role: 'system', content: '── Plan created at 1:00 PM · tidy-mixing-brook ──', planFilePath: path },
      { role: 'user', content: 'Implement the following plan:\n\n# Old', implementationPhase: true },
      { role: 'system', content: '── Plan created at 2:00 PM · newer-plan ──', planFilePath: newerPath },
    ]
    expect(isPlanImplementedInMessages(messages, newerPath)).toBe(false)
  })

  it('is FALSE when the plan path was cleared but no implementation evidence exists', () => {
    // The exact false positive: history knows the plan, the instance field is
    // gone, and nothing was ever implemented.
    const messages = [
      { role: 'system', content: '── Plan created at 1:00 PM · tidy-mixing-brook ──', planFilePath: path },
      { role: 'assistant', content: 'plan written' },
    ]
    expect(isPlanImplementedInMessages(messages, path)).toBe(false)
  })

  it('is false when the implement divider belongs to a DIFFERENT plan', () => {
    const messages = [
      { role: 'system', content: formatImplementDivider(new Date(), 'some-other-plan') },
    ]
    expect(isPlanImplementedInMessages(messages, path)).toBe(false)
  })

  it('is false for no plan path, and for an empty transcript', () => {
    expect(isPlanImplementedInMessages([{ role: 'system', content: formatImplementDivider(new Date(), slug) }], null)).toBe(false)
    expect(isPlanImplementedInMessages([], path)).toBe(false)
  })

  it('ignores a non-divider message that merely mentions the slug', () => {
    const messages = [{ role: 'assistant', content: `I will implement ${slug} later` }]
    expect(isPlanImplementedInMessages(messages, path)).toBe(false)
  })
})
