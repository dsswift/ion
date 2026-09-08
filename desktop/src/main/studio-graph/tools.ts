/**
 * The built-in Studio graph tool set.
 *
 * These let an agent drive the Graph View the operator is looking at: open
 * it, find nodes, point at them, move the camera, change filters and scope,
 * and load a saved view — so it can walk the operator through their corpus
 * rather than describe it in prose.
 *
 * Every tool is one correlated command to the Studio renderer, which owns
 * the graph store and answers once the picture has changed. Main never sees
 * the graph itself; it sees the summary the renderer answers with, and that
 * summary is what the model reads.
 *
 * Ownership is NOT model input. No schema takes a conversation, project, or
 * tab: the tool-gate responder supplies the session key and working
 * directory, so a call can never be retargeted at another conversation's
 * project. The agent thinks in node ids, never in pixels: there is no raw
 * pan or zoom, only "look at these nodes" and "show everything".
 */
import { log as _log, warn as _warn } from '../logger'
import { tabIdFromKey } from '../../shared/session-key'
import type { BrowserToolContext, BrowserToolResult, StudioBrowserTool } from '../studio-playwright/tool-contracts'
import { ENUM, INT, STRING, fail, intArg, ok, schema, stringArg } from '../studio-playwright/tool-contracts'
import { graphCommandSender } from './renderer-bridge'
import {
  parseGraphCommand,
  parseGraphFilterRules,
  type StudioGraphCommand,
  type StudioGraphCommandResult,
} from '../../shared/studio-graph-types'

const TAG = 'studio-graph'
/**
 * Above the renderer's own settle wait (20s) so a slow layout answers with a
 * note rather than a timeout, and under the engine's client-tool bound.
 */
const COMMAND_TIMEOUT_MS = 28_000

export const STUDIO_REQUIRED_ERROR =
  'The graph tools require the Ion Studio window. Switch the active interface to Studio and try again.'

/** A graph tool: the browser tool contract, executed against the graph command seam. */
export type StudioGraphTool = StudioBrowserTool

/** `Omit` over a union keeps only the shared keys; distributing it keeps each verb's own arguments. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type CommandBody = DistributiveOmit<StudioGraphCommand, 'conversationId' | 'cwd'>

/**
 * Send one command for the calling conversation and format the answer.
 *
 * The command is re-validated through the shared parser before it leaves
 * main, so a tool that builds a malformed command fails here with a clear
 * error rather than being silently dropped by the renderer's parser.
 */
async function run(ctx: BrowserToolContext, body: CommandBody): Promise<BrowserToolResult> {
  const conversationId = tabIdFromKey(ctx.sessionKey)
  if (!conversationId) return fail('this conversation has no desktop tab, so it cannot drive the Graph View')
  if (!ctx.cwd) return fail('this conversation has no working directory, so there is no corpus to graph')
  const command = parseGraphCommand({ ...body, conversationId, cwd: ctx.cwd })
  if (!command) {
    _warn(TAG, 'graph tool built an invalid command', { kind: body.kind, conversation_id: conversationId })
    return fail(`graph command ${body.kind} was rejected as malformed`)
  }
  const sender = graphCommandSender()
  if (!sender) return fail(STUDIO_REQUIRED_ERROR)

  const started = Date.now()
  const reply = await sender(command, COMMAND_TIMEOUT_MS).catch((err: unknown): StudioGraphCommandResult => {
    _warn(TAG, 'graph command failed', { kind: command.kind, conversation_id: conversationId, error: String(err) })
    return { callId: 'none', ok: false, error: STUDIO_REQUIRED_ERROR }
  })
  _log(TAG, 'graph tool answered', {
    kind: command.kind,
    conversation_id: conversationId,
    ok: reply.ok,
    latency_ms: Date.now() - started,
    ...(reply.error ? { error: reply.error } : {}),
  })
  if (!reply.ok) return fail(reply.error ?? `Studio refused the ${command.kind} graph command.`)
  return ok(formatReply(reply))
}

/** The answer as the model reads it: the payload minus the correlator, as JSON. */
export function formatReply(reply: StudioGraphCommandResult): string {
  const { callId: _callId, ok: _ok, ...payload } = reply
  return JSON.stringify(payload, null, 2)
}

function stringList(input: Record<string, unknown>, name: string): string[] | null {
  const raw = input[name]
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string' && x.length > 0)) return null
  return raw as string[]
}

const NODE_ID = STRING('A node id exactly as graph_search or graph_node returned it', 4096)

export const STUDIO_GRAPH_TOOLS: StudioGraphTool[] = [
  {
    name: 'graph_open',
    description: 'Open or reveal the Graph View for this conversation\'s project and return its state. Call this before any other graph tool. Only works while this conversation is on screen.',
    inputSchema: schema({}),
    planModeSafe: true,
    execute: (_input, ctx) => run(ctx, { kind: 'open' }),
  },
  {
    name: 'graph_state',
    description: 'Read the Graph View: node and edge counts, what is visible, the selection, the agent highlight, scope, filters, channel bindings, saved view names, and the front-matter fields available for filtering.',
    inputSchema: schema({}),
    planModeSafe: true,
    execute: (_input, ctx) => run(ctx, { kind: 'state' }),
  },
  {
    name: 'graph_search',
    description: 'Find nodes by label, id, or path. Returns matching nodes with their ids; use an id with graph_node, graph_highlight, or graph_scope.',
    inputSchema: schema({
      query: STRING('Text to match against node labels, ids, and paths', 512),
      limit: INT('Maximum matches to return (default 20)', 1, 100),
    }, ['query']),
    planModeSafe: true,
    execute: (input, ctx) => {
      const query = stringArg(input, 'query', 512)
      if (!query) return Promise.resolve(fail('query is required'))
      const limit = intArg(input, 'limit') ?? 20
      return run(ctx, { kind: 'search', query, limit })
    },
  },
  {
    name: 'graph_node',
    description: 'Describe one node: its label, path, degree, community, centrality, whether it is visible, and every edge touching it with the neighbour on the other end.',
    inputSchema: schema({ nodeId: NODE_ID }, ['nodeId']),
    planModeSafe: true,
    execute: (input, ctx) => {
      const nodeId = stringArg(input, 'nodeId')
      return nodeId ? run(ctx, { kind: 'node', nodeId }) : Promise.resolve(fail('nodeId is required'))
    },
  },
  {
    name: 'graph_highlight',
    description: 'Point the operator at nodes: draws them as highlighted, keeps their neighbours at full strength, dims the rest, and moves the camera to them. The operator\'s own selection is untouched; their next click on the stage clears the highlight.',
    inputSchema: schema({
      nodeIds: { type: 'array', description: 'Node ids to highlight', items: { type: 'string', maxLength: 4096 }, minItems: 1, maxItems: 500 },
      camera: ENUM('Where the camera goes: focus zooms in on one node (fits several), fit frames all of them (default), none leaves the view alone', ['focus', 'fit', 'none']),
    }, ['nodeIds']),
    planModeSafe: true,
    execute: (input, ctx) => {
      const nodeIds = stringList(input, 'nodeIds')
      if (!nodeIds || nodeIds.length === 0) return Promise.resolve(fail('nodeIds must be a non-empty list of node ids'))
      const raw = input.camera
      const camera = raw === 'focus' || raw === 'none' ? raw : 'fit'
      return run(ctx, { kind: 'highlight', nodeIds, camera })
    },
  },
  {
    name: 'graph_clear_highlight',
    description: 'Remove the agent highlight, leaving the operator\'s selection and the camera where they are.',
    inputSchema: schema({}),
    planModeSafe: true,
    execute: (_input, ctx) => run(ctx, { kind: 'clear-highlight' }),
  },
  {
    name: 'graph_fit',
    description: 'Frame everything currently visible.',
    inputSchema: schema({}),
    planModeSafe: true,
    execute: (_input, ctx) => run(ctx, { kind: 'fit' }),
  },
  {
    name: 'graph_filter',
    description: 'Replace the filter rules. Each rule names a dimension ({source:"frontMatter",field} | {source:"structural",metric:degree|community|centrality|orphan} | {source:"mechanical",property:path|root|sizeBytes|modifiedMs} | {source:"edge",metric:multiplicity|recency|rarity|overlap|crossRoot|origin|field}), a mode (include|exclude), an optional match (exact, the default, or prefix for "everything under this path"), and either categorical values or numeric min/max. Pass an empty list to clear every filter. graph_state lists the discovered front-matter fields.',
    inputSchema: schema({
      filters: {
        type: 'array',
        description: 'The complete rule list; replaces what is set',
        maxItems: 32,
        items: {
          type: 'object',
          properties: {
            dimension: { type: 'object', description: 'The dimension the rule reads' },
            mode: { type: 'string', enum: ['include', 'exclude'] },
            values: { type: 'array', items: { type: 'string' }, description: 'Categorical match set' },
            match: { type: 'string', enum: ['exact', 'prefix'], description: 'How values compare: whole-value equality (default) or leading-string match' },
            min: { type: 'number', description: 'Inclusive lower bound for numeric or temporal dimensions' },
            max: { type: 'number', description: 'Inclusive upper bound' },
          },
          required: ['dimension', 'mode'],
        },
      },
    }, ['filters']),
    planModeSafe: true,
    execute: (input, ctx) => {
      const filters = parseGraphFilterRules(input.filters)
      if (!filters) return Promise.resolve(fail('filters must be a list of rules, each with a valid dimension and a mode of include or exclude'))
      return run(ctx, { kind: 'filters', filters })
    },
  },
  {
    name: 'graph_scope',
    description: 'Set the scope: corpus shows the whole graph; neighborhood shows one node and everything within depth hops of it, following links out, in, or both ways. Both re-frame the camera on what is visible.',
    inputSchema: schema({
      mode: ENUM('corpus or neighborhood', ['corpus', 'neighborhood']),
      anchorId: STRING('The node at the centre of a neighborhood scope', 4096),
      depth: INT('Hops from the anchor (default keeps the current depth)', 1, 6),
      direction: ENUM('Which way hops travel: out follows what a document links to, in follows what links to it, both (default) either', ['out', 'in', 'both']),
    }, ['mode']),
    planModeSafe: true,
    execute: (input, ctx) => {
      if (input.mode === 'corpus') return run(ctx, { kind: 'scope', mode: 'corpus' })
      if (input.mode !== 'neighborhood') return Promise.resolve(fail('mode must be corpus or neighborhood'))
      const anchorId = stringArg(input, 'anchorId')
      if (!anchorId) return Promise.resolve(fail('anchorId is required for a neighborhood scope'))
      const depth = intArg(input, 'depth')
      const direction = input.direction === 'out' || input.direction === 'in' || input.direction === 'both' ? input.direction : undefined
      return run(ctx, { kind: 'scope', mode: 'neighborhood', anchorId, ...(depth === null ? {} : { depth }), ...(direction === undefined ? {} : { direction }) })
    },
  },
  {
    name: 'graph_load_view',
    description: 'Load a saved view by name: its channel bindings, filters, layout positions, and pins. graph_state lists the names.',
    inputSchema: schema({ name: STRING('The saved view name', 128) }, ['name']),
    planModeSafe: true,
    execute: (input, ctx) => {
      const name = stringArg(input, 'name', 128)
      return name ? run(ctx, { kind: 'load-view', name }) : Promise.resolve(fail('name is required'))
    },
  },
  {
    name: 'graph_peek',
    description: 'Open the Quick Peek card on one node so the operator sees its details beside it. Omit nodeId to close the card.',
    inputSchema: schema({ nodeId: NODE_ID }),
    planModeSafe: true,
    execute: (input, ctx) => {
      const nodeId = input.nodeId === undefined || input.nodeId === null ? null : stringArg(input, 'nodeId')
      if (input.nodeId !== undefined && input.nodeId !== null && !nodeId) return Promise.resolve(fail('nodeId must be a node id, or omitted to close the card'))
      return run(ctx, { kind: 'peek', nodeId })
    },
  },
]

/** Tool lookup by name, used by the responder to execute exactly what it advertised. */
export function studioGraphTool(name: string): StudioGraphTool | undefined {
  return STUDIO_GRAPH_TOOLS.find((tool) => tool.name === name)
}
