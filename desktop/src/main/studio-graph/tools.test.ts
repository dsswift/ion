/**
 * The graph tools are exercised through their one seam: the renderer command
 * sender. What is worth pinning is behavioural — ownership comes from the
 * session, not the arguments; a malformed argument fails before anything is
 * sent; the reply is what the model reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { STUDIO_GRAPH_TOOLS, STUDIO_REQUIRED_ERROR, formatReply, studioGraphTool } from './tools'
import { setGraphCommandSender } from './renderer-bridge'
import type { StudioGraphCommand, StudioGraphCommandResult } from '../../shared/studio-graph-types'

const ctx = { sessionKey: 'tab-1', cwd: '/proj', origin: 'model' as const }
const sent: StudioGraphCommand[] = []
let reply: StudioGraphCommandResult = { callId: 'x', ok: true, state: undefined }

beforeEach(() => {
  sent.length = 0
  reply = { callId: 'x', ok: true }
  setGraphCommandSender(async (command) => {
    sent.push(command)
    return reply
  })
})

function tool(name: string) {
  const found = studioGraphTool(name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

describe('graph tool declarations', () => {
  it('declares every tool with a schema, plan-mode safe, and takes no ownership arguments', () => {
    expect(STUDIO_GRAPH_TOOLS.length).toBeGreaterThan(0)
    for (const t of STUDIO_GRAPH_TOOLS) {
      expect(t.name.startsWith('graph_')).toBe(true)
      expect(t.planModeSafe).toBe(true)
      const props = Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties)
      expect(props).not.toContain('conversationId')
      expect(props).not.toContain('cwd')
    }
  })
})

describe('ownership and refusal', () => {
  it('stamps the session\'s conversation and directory onto the command', async () => {
    await tool('graph_state').execute({}, ctx)
    expect(sent).toEqual([{ kind: 'state', conversationId: 'tab-1', cwd: '/proj' }])
  })

  it('refuses when Studio has no sender, without sending anything', async () => {
    setGraphCommandSender(null)
    const result = await tool('graph_open').execute({}, ctx)
    expect(result).toEqual({ content: STUDIO_REQUIRED_ERROR, isError: true })
    expect(sent).toEqual([])
  })

  it('refuses a session with no working directory', async () => {
    const result = await tool('graph_state').execute({}, { ...ctx, cwd: '' })
    expect(result.isError).toBe(true)
    expect(sent).toEqual([])
  })

  it('surfaces the renderer\'s refusal as the tool error', async () => {
    reply = { callId: 'x', ok: false, error: 'The Graph View is not open for /proj. Call graph_open first.' }
    const result = await tool('graph_fit').execute({}, ctx)
    expect(result).toEqual({ content: 'The Graph View is not open for /proj. Call graph_open first.', isError: true })
  })
})

describe('argument shaping', () => {
  it('graph_search carries the query and a bounded limit', async () => {
    await tool('graph_search').execute({ query: 'plan', limit: 5 }, ctx)
    expect(sent[0]).toMatchObject({ kind: 'search', query: 'plan', limit: 5 })
    expect((await tool('graph_search').execute({}, ctx)).isError).toBe(true)
  })

  it('graph_highlight defaults the camera to fit and rejects an empty list', async () => {
    await tool('graph_highlight').execute({ nodeIds: ['a', 'b'] }, ctx)
    expect(sent[0]).toMatchObject({ kind: 'highlight', nodeIds: ['a', 'b'], camera: 'fit' })
    await tool('graph_highlight').execute({ nodeIds: ['a'], camera: 'focus' }, ctx)
    expect(sent[1]).toMatchObject({ camera: 'focus' })
    expect((await tool('graph_highlight').execute({ nodeIds: [] }, ctx)).isError).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('graph_filter validates rules before sending', async () => {
    const rules = [{ dimension: { source: 'frontMatter', field: 'status' }, mode: 'include', values: ['draft'] }]
    await tool('graph_filter').execute({ filters: rules }, ctx)
    expect(sent[0]).toMatchObject({ kind: 'filters', filters: rules })
    const bad = await tool('graph_filter').execute({ filters: [{ dimension: { source: 'nope' }, mode: 'include' }] }, ctx)
    expect(bad.isError).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('graph_scope needs an anchor for a neighborhood and none for the corpus', async () => {
    await tool('graph_scope').execute({ mode: 'corpus' }, ctx)
    expect(sent[0]).toMatchObject({ kind: 'scope', mode: 'corpus' })
    expect((await tool('graph_scope').execute({ mode: 'neighborhood' }, ctx)).isError).toBe(true)
    await tool('graph_scope').execute({ mode: 'neighborhood', anchorId: 'a', depth: 2 }, ctx)
    expect(sent[1]).toMatchObject({ mode: 'neighborhood', anchorId: 'a', depth: 2 })
  })

  it('graph_peek closes the card when the id is omitted', async () => {
    await tool('graph_peek').execute({}, ctx)
    expect(sent[0]).toMatchObject({ kind: 'peek', nodeId: null })
    await tool('graph_peek').execute({ nodeId: 'a' }, ctx)
    expect(sent[1]).toMatchObject({ kind: 'peek', nodeId: 'a' })
  })
})

describe('formatReply', () => {
  it('drops the correlator and verdict and keeps the payload', () => {
    const text = formatReply({ callId: 'c9', ok: true, note: 'n', nodes: [] })
    expect(JSON.parse(text)).toEqual({ note: 'n', nodes: [] })
  })
})
