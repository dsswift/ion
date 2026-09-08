/**
 * Studio-side handler for main's graph tool commands.
 *
 * Main owns the tool declarations; this renderer owns the graph store. So
 * every graph tool call arrives here as one correlated command, is applied
 * to the store, and is acknowledged exactly once — after the picture has
 * actually changed. Two waits make that true:
 *
 *   - a camera move is acknowledged only once `cameraAppliedSeq` reaches the
 *     seq the command requested, which the render layer reports after the
 *     animation lands (or after a layout still running has settled and the
 *     deferred request was applied);
 *   - a peek is acknowledged once the store shows that node's Quick Peek.
 *
 * Both waits are bounded. Running out of time is reported as a `note` on a
 * success rather than a failure, because the store change did happen; only
 * the render layer's confirmation is missing.
 *
 * Which project a command addresses is fixed by the calling conversation's
 * working directory, never by the model. The graph store follows the visible
 * conversation's directory (see `GraphSurface`), so a command for another
 * directory is refused with a message that says which one is on stage.
 */
import { useEffect } from 'react'
import { useGraphStore } from './graph-store'
import { useSurfaceStore } from '../surface/surface-store'
import { useSessionStore } from '../../stores/sessionStore'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'
import { buildGraphToolState, describeNode, neighborsOf } from './studio-graph-describe'
import type { CameraCommand } from './graph-camera'
import type {
  StudioGraphCommand,
  StudioGraphCommandEnvelope,
  StudioGraphCommandResult,
} from '../../../shared/studio-graph-types'

const TAG = 'studio.graph'
/**
 * How long a command waits for the render layer. Under main's own command
 * timeout and the engine's client-tool bound, so a slow layout produces a
 * success with a note rather than a timeout the model cannot explain.
 */
const SETTLE_TIMEOUT_MS = 20_000
const OPEN_TIMEOUT_MS = 20_000

/** Everything but the correlator, which the envelope loop adds. */
export type GraphCommandOutcome = Omit<StudioGraphCommandResult, 'callId'>

/** Register the graph command handler for the lifetime of the window. */
export function useStudioGraphCommands(): void {
  useEffect(() => registerStudioGraphCommands(), [])
}

/** Install the handler. Returns an unsubscribe for window teardown. */
export function registerStudioGraphCommands(): () => void {
  return window.ion.onStudioGraphCommand((envelope: StudioGraphCommandEnvelope) => {
    const started = Date.now()
    void applyGraphCommand(envelope.command)
      .then((outcome) => {
        window.ion.studioGraphCommandResult({ callId: envelope.callId, ...outcome })
        rInfo(TAG, 'graph command answered', {
          call_id: envelope.callId,
          kind: envelope.command.kind,
          ok: outcome.ok,
          latency_ms: Date.now() - started,
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.note ? { note: outcome.note } : {}),
        })
      })
      .catch((err: unknown) => {
        // Never leave main waiting: a thrown handler still owes an answer, and
        // a refusal the model can read beats a timeout it cannot explain.
        rWarn(TAG, 'graph command failed', { call_id: envelope.callId, kind: envelope.command.kind, error: String(err) })
        window.ion.studioGraphCommandResult({ callId: envelope.callId, ok: false, error: String(err) })
      })
  })
}

/** Wait until the graph store satisfies `predicate`, or the timeout elapses. Resolves to whether it was satisfied. */
function waitForStore(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  if (predicate()) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (satisfied: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(satisfied)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const unsubscribe = useGraphStore.subscribe(() => {
      if (predicate()) finish(true)
    })
  })
}

function layoutResting(): boolean {
  const state = useGraphStore.getState().layoutState
  return state !== 'requested' && state !== 'running'
}

/**
 * Wait for a camera request to land. `seq` is what `requestCamera` returned;
 * null means the command moved nothing and there is nothing to wait for.
 */
async function settleCamera(seq: number | null): Promise<string | undefined> {
  if (seq === null) return undefined
  const landed = await waitForStore(() => layoutResting() && useGraphStore.getState().cameraAppliedSeq >= seq, SETTLE_TIMEOUT_MS)
  if (landed) return undefined
  const { layoutState, cameraAppliedSeq } = useGraphStore.getState()
  rWarn(TAG, 'camera settle wait ran out', { seq, layoutState, cameraAppliedSeq, timeout_ms: SETTLE_TIMEOUT_MS })
  return layoutResting()
    ? 'The camera move was requested but the render layer had not confirmed it in time.'
    : 'The layout is still running; the camera will move once it settles.'
}

/** The conversation whose surfaces are on the operator's screen. */
function onScreenConversationId(): string | null {
  return useSurfaceStore.getState().currentConversationId ?? useSessionStore.getState().activeTabId
}

/** The directory the graph store follows: the visible session tab's working directory. */
function visibleWorkingDirectory(): string | null {
  const session = useSessionStore.getState()
  return session.tabs.find((tab) => tab.id === session.activeTabId)?.workingDirectory ?? null
}

/** A graph is "open" for a directory when the store holds that directory's model. */
function graphOpenFor(cwd: string): boolean {
  const state = useGraphStore.getState()
  return state.projectPath === cwd && state.model !== null
}

function notOpenError(cwd: string): string {
  const current = useGraphStore.getState().projectPath
  return current && current !== cwd
    ? `The Graph View is showing ${current}, not ${cwd}. Bring this conversation to the front and call graph_open.`
    : `The Graph View is not open for ${cwd}. Call graph_open first.`
}

/**
 * Open (or reveal) the Graph View for the calling conversation's directory.
 *
 * Reveal only touches the operator's view when the calling conversation is
 * the one on screen — a background agent must not steal the stage. A
 * background call for a directory whose graph is already open succeeds
 * without revealing anything; one for a directory that is not open is
 * refused, because the store follows the visible conversation and cannot
 * build a second project's graph behind it.
 */
async function open(command: Extract<StudioGraphCommand, { kind: 'open' }>): Promise<GraphCommandOutcome> {
  const onScreen = onScreenConversationId() === command.conversationId
  if (!onScreen) {
    if (graphOpenFor(command.cwd)) return succeed()
    rInfo(TAG, 'graph open refused, conversation not on screen', { conversation_id: command.conversationId, cwd: command.cwd })
    return { ok: false, error: 'This conversation is not on screen, so the Graph View cannot be opened for it. Ask the operator to bring it to the front, then call graph_open again.' }
  }
  const visibleCwd = visibleWorkingDirectory()
  if (visibleCwd !== command.cwd) {
    rWarn(TAG, 'graph open refused, visible directory differs', { cwd: command.cwd, visible_cwd: visibleCwd ?? 'none' })
    return { ok: false, error: `The visible conversation is working in ${visibleCwd ?? 'no project'}, not ${command.cwd}, so the Graph View cannot show this project.` }
  }
  const surface = useSurfaceStore.getState()
  surface.openSingleton('graph')
  surface.setVisible(true)
  rInfo(TAG, 'graph surface opened for agent', { conversation_id: command.conversationId, cwd: command.cwd })

  const ready = await waitForStore(() => {
    const state = useGraphStore.getState()
    return state.projectPath === command.cwd && (state.model !== null || state.error !== null || (state.config !== null && !state.available))
  }, OPEN_TIMEOUT_MS)
  const state = useGraphStore.getState()
  if (!ready) {
    rWarn(TAG, 'graph open wait ran out', { cwd: command.cwd, project_path: state.projectPath ?? 'none', timeout_ms: OPEN_TIMEOUT_MS })
    return { ok: false, error: 'The Graph View did not finish building in time. Try graph_state again in a moment.' }
  }
  if (state.error) return { ok: false, error: `The Graph View could not build: ${state.error}` }
  if (!state.available) return { ok: false, error: `Graph View has no corpus root for ${command.cwd}.` }
  // The first build starts a layout; report the graph once it has come to rest.
  const note = await settleCamera(state.cameraRequest?.seq ?? null)
  return succeed(note)
}

function succeed(note?: string, extra: Partial<GraphCommandOutcome> = {}): GraphCommandOutcome {
  return { ok: true, ...(note ? { note } : {}), state: buildGraphToolState(useGraphStore.getState()), ...extra }
}

/** Apply one command. Every branch returns; nothing throws for an expected refusal. */
export async function applyGraphCommand(command: StudioGraphCommand): Promise<GraphCommandOutcome> {
  rDebug(TAG, 'graph command received', { kind: command.kind, conversation_id: command.conversationId, cwd: command.cwd })
  if (command.kind === 'open') return open(command)
  if (!graphOpenFor(command.cwd)) return { ok: false, error: notOpenError(command.cwd) }

  const store = useGraphStore.getState()
  switch (command.kind) {
    case 'state':
      return succeed()

    case 'search': {
      const hits = store.search(command.query).slice(0, command.limit)
      const nodes = hits.flatMap((hit) => {
        const described = describeNode(store, hit.id)
        return described ? [described] : []
      })
      rDebug(TAG, 'graph search answered', { query_len: command.query.length, hits: nodes.length })
      return succeed(undefined, { nodes })
    }

    case 'node': {
      const node = describeNode(store, command.nodeId)
      if (!node) return { ok: false, error: `No node with id ${command.nodeId}. Use graph_search to find the id.` }
      return succeed(undefined, { node, neighbors: neighborsOf(store, command.nodeId) })
    }

    case 'highlight': {
      const graph = store.graph
      const present = command.nodeIds.filter((id) => graph?.hasNode(id))
      const missing = command.nodeIds.filter((id) => !graph?.hasNode(id))
      if (present.length === 0) {
        return { ok: false, error: `None of the requested nodes exist: ${missing.join(', ')}. Use graph_search to find ids.` }
      }
      store.setAgentHighlight(present)
      let camera: CameraCommand | null = null
      if (command.camera === 'focus') camera = present.length === 1 ? { kind: 'focus', nodeId: present[0]! } : { kind: 'fit-nodes', nodeIds: present }
      else if (command.camera === 'fit') camera = { kind: 'fit-nodes', nodeIds: present }
      const seq = camera ? store.requestCamera(camera) : null
      const note = await settleCamera(seq)
      const dropped = missing.length > 0 ? `Ignored ${missing.length} unknown id(s): ${missing.join(', ')}.` : undefined
      return succeed([note, dropped].filter(Boolean).join(' ') || undefined)
    }

    case 'clear-highlight':
      store.clearAgentHighlight()
      return succeed()

    case 'fit':
      return succeed(await settleCamera(store.requestCamera({ kind: 'fit-all' })))

    case 'filters':
      store.setFilters(command.filters)
      return succeed()

    case 'scope': {
      if (command.mode === 'corpus') {
        store.setScopeToCorpus()
      } else {
        if (!store.graph?.hasNode(command.anchorId!)) {
          return { ok: false, error: `No node with id ${command.anchorId}. Use graph_search to find the id.` }
        }
        if (command.direction) store.setScopeDirection(command.direction)
        store.setScopeToNeighborhood(command.anchorId!, command.depth)
      }
      // Both scope actions request their own camera move; wait for that one.
      return succeed(await settleCamera(useGraphStore.getState().cameraRequest?.seq ?? null))
    }

    case 'load-view': {
      // Project views come first in `savedViews`, so a name present in both
      // scopes resolves to the project's — the same rule the default view uses.
      const view = (store.config?.savedViews ?? []).find((v) => v.name === command.name)
      if (!view) {
        const names = (store.config?.savedViews ?? []).map((v) => v.name)
        return { ok: false, error: names.length > 0 ? `No saved view named ${command.name}. Available: ${names.join(', ')}.` : 'This project has no saved views.' }
      }
      const before = store.cameraRequest?.seq ?? 0
      store.loadView(view)
      const after = useGraphStore.getState().cameraRequest?.seq ?? 0
      return succeed(await settleCamera(after > before ? after : null))
    }

    case 'peek': {
      if (command.nodeId === null) {
        store.setQuickPeek(null)
        return succeed()
      }
      if (!store.graph?.hasNode(command.nodeId)) return { ok: false, error: `No node with id ${command.nodeId}. Use graph_search to find the id.` }
      const nodeId = command.nodeId
      store.requestPeek(nodeId)
      const shown = await waitForStore(() => useGraphStore.getState().quickPeekNodeId === nodeId, SETTLE_TIMEOUT_MS)
      if (!shown) rWarn(TAG, 'peek wait ran out', { nodeId, layoutState: useGraphStore.getState().layoutState })
      return succeed(shown ? undefined : 'The peek was requested but the stage had not shown it in time.')
    }
  }
}
