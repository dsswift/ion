// @vitest-environment jsdom
/**
 * The union store (ADR-033): every connected Environment's tabs live in the
 * one mirror at once, each tagged with its Environment, and every forwarded
 * action is sent to the server that owns the tab it names. Nothing switches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioFrame, StudioSnapshot } from '@ion/shared/studio-wire/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

const wire = vi.hoisted(() => ({
  sent: [] as Array<{ environmentId: string; frame: StudioFrame }>,
  actions: [] as Array<{ environmentId: string; name: string; args: unknown[] }>,
  listeners: new Set<(environmentId: string, frame: StudioFrame) => void>(),
}))
vi.mock('../../../host/host-instance', () => ({
  host: {
    send: (environmentId: string, frame: StudioFrame) => { wire.sent.push({ environmentId, frame }) },
    onFrame: (cb: (environmentId: string, frame: StudioFrame) => void) => { wire.listeners.add(cb); return () => wire.listeners.delete(cb) },
    capabilities: () => ['windowMirrorSync'],
    shell: { onStudioTabsSync: () => () => {}, onStudioConversationTerminals: () => () => {}, onStudioWorktreeSync: () => () => {}, studioGetTabsSync: async () => null },
  },
  action: async (environmentId: string, name: string, args: unknown[]) => { wire.actions.push({ environmentId, name, args }); return undefined },
}))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))
vi.mock('../../../components/TerminalInstance', () => ({ destroyTerminalInstance: vi.fn() }))
const availability = vi.hoisted(() => ({ of: new Map<string, string>() }))
vi.mock('../../connection/environment-availability', () => ({
  environmentAvailability: { availabilityOf: (id: string) => availability.of.get(id) ?? 'connected' },
}))

import { useSessionStore } from '@ion/server/store/sessionStore'
import { applyMirrorOverrides, initTabsSyncFromWire } from '../secondary-store'
import { initConversationTerminalSyncFromWire } from '../secondary-store-wire-sync'
import { initBodySyncFromWire } from '../body-sync'
import { withTargetEnvironment, environmentOfTab, activeTabEnvironmentId, resolveShellEnvironment } from '../../connection/tab-environment'
import { SHELL_INVOKE } from '../../../host/browser-shell-bridge'

// Revision cursors are per Environment and live for the module's lifetime,
// exactly as in the window; each test publishes fresher revisions.
let revision = 0
function snapshot(tabIds: string[], terminals: string[] = []): StudioSnapshot {
  revision += 1
  return {
    tabs: tabIds.map((id) => ({ id, conversationId: `conv-${id}`, title: id, customTitle: null, workingDirectory: `/srv/${id}`, hasChosenDirectory: true, additionalDirs: [] })) as never,
    settings: {} as never,
    worktrees: { revision, ready: true, inventory: {}, workspaces: {}, benchSourceTips: [], benchRetired: [], gitConflictAlerts: [], worktreePipeline: null, workspaceOperationLedger: [] } as never,
    terminals: { revision, panes: terminals.map((tabId) => ({ tabId, activeInstanceId: 'i1', instances: [{ id: 'i1', label: 'sh', kind: 'shell', cwd: '/', readOnly: false }] })), openTabIds: terminals } as never,
    automations: [], engine: {} as never, presence: { entries: [], driving: {} } as never,
  }
}
function deliver(environmentId: string, frame: StudioFrame): void {
  for (const l of [...wire.listeners]) l(environmentId, frame)
}
const store = (): Record<string, (...a: unknown[]) => Promise<unknown>> => useSessionStore.getState() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>

let stopBodySync: (() => void) | null = null

beforeEach(() => {
  wire.sent.length = 0
  wire.actions.length = 0
  useSessionStore.setState({ tabs: [], settledHistory: [], activeTabId: null, conversationPanes: new Map(), terminalPanes: new Map(), terminalOpenTabIds: new Set(), tabsReady: false } as never)
  initTabsSyncFromWire()
  initConversationTerminalSyncFromWire()
  stopBodySync = initBodySyncFromWire()
  applyMirrorOverrides()
  deliver(LOCAL_ENVIRONMENT_ID, { type: 'studio_snapshot', snapshot: snapshot(['local-a'], ['local-a']) })
  deliver('devbox', { type: 'studio_snapshot', snapshot: snapshot(['g-1', 'g-2'], ['g-1']) })
  availability.of.clear()
})
afterEach(() => {
  stopBodySync?.()
  stopBodySync = null
  wire.listeners.clear()
})

describe('union store', () => {
  it('holds both environments\' tabs at once, each tagged, and keeps the local selection', () => {
    const s = useSessionStore.getState()
    expect(s.tabs.map((t) => [t.id, t.environmentId])).toEqual([['local-a', LOCAL_ENVIRONMENT_ID], ['g-1', 'devbox'], ['g-2', 'devbox']])
    expect(s.activeTabId).toBe('local-a')
    expect(environmentOfTab('g-2')).toBe('devbox')
    expect(activeTabEnvironmentId()).toBe(LOCAL_ENVIRONMENT_ID)
  })

  it('merges each environment\'s terminal panes and open set, per environment', () => {
    const s = useSessionStore.getState()
    expect([...s.terminalPanes.keys()].sort()).toEqual(['g-1', 'local-a'])
    expect([...s.terminalOpenTabIds].sort()).toEqual(['g-1', 'local-a'])
    deliver('devbox', { type: 'studio_event', channel: 'studio:conversation-terminals', payload: { revision: revision + 1, panes: [], openTabIds: [] } })
    expect([...useSessionStore.getState().terminalPanes.keys()]).toEqual(['local-a'])
  })

  it('routes a forwarded action to the server that owns the tab it names', async () => {
    await store().renameTab('g-1', 'x')
    await store().renameTab('local-a', 'y')
    expect(wire.actions.map((a) => [a.environmentId, a.name])).toEqual([['devbox', 'renameTab'], [LOCAL_ENVIRONMENT_ID, 'renameTab']])
  })

  /**
   * The broker WOULD queue this frame and send it on reconnect. That is
   * right for the local server -- a restart is a blip on this machine's own
   * state -- and wrong for another machine: the action was decided against
   * rows that stopped being current when the wire dropped, so replaying it
   * later applies an old intent to a conversation that has moved on.
   */
  it('refuses a forwarded action to an environment it cannot reach, and still serves the local one', async () => {
    availability.of.set('devbox', 'reconnecting')
    expect(await store().renameTab('g-1', 'x')).toBeUndefined()
    expect(wire.actions).toEqual([])

    await store().renameTab('local-a', 'y')
    expect(wire.actions.map((a) => a.environmentId)).toEqual([LOCAL_ENVIRONMENT_ID])
  })

  it('routes a creation to the explicitly chosen environment, and everything else stays put', async () => {
    await withTargetEnvironment('devbox', () => store().createConversationTab('/srv/new', {}))
    expect(wire.actions).toEqual([{ environmentId: 'devbox', name: 'createConversationTab', args: ['/srv/new', {}] }])
    // No switch happened: the local selection and every tab are still here.
    expect(useSessionStore.getState().activeTabId).toBe('local-a')
    expect(useSessionStore.getState().tabs).toHaveLength(3)
  })

  it('asks the owning server for a conversation body when a remote tab becomes active', () => {
    // Boot already asked the local server for the tab it selected.
    wire.sent.length = 0
    useSessionStore.setState({ activeTabId: 'g-2' } as never)
    // Bounded: an unpaged request answers with the whole transcript in one
    // frame, which a long conversation cannot fit inside the send cap.
    expect(wire.sent.filter((s) => s.frame.type === 'studio_body_request')).toEqual([{ environmentId: 'devbox', frame: { type: 'studio_body_request', tabId: 'g-2', limit: expect.any(Number), instanceId: expect.any(String) } }])
  })

  it('routes shell calls by what they name: terminal key and tab id to the owner, a path to the active tab\'s server', () => {
    expect(resolveShellEnvironment([{ key: 'g-1:i1', data: 'x' }])).toBe('devbox')
    expect(resolveShellEnvironment([{ tabId: 'g-2' }])).toBe('devbox')
    expect(resolveShellEnvironment(['g-1'])).toBe('devbox')
    expect(resolveShellEnvironment([{ directory: '/srv/x' }])).toBe(LOCAL_ENVIRONMENT_ID)
    useSessionStore.setState({ activeTabId: 'g-1' } as never)
    expect(resolveShellEnvironment([{ directory: '/srv/x' }])).toBe('devbox')
    expect(resolveShellEnvironment(['/srv/x'])).toBe('devbox')
    expect(resolveShellEnvironment([{ provider: 'anthropic' }])).toBe(LOCAL_ENVIRONMENT_ID)
    expect(resolveShellEnvironment([])).toBe(LOCAL_ENVIRONMENT_ID)
  })

  it('stores and reads attachments on the server that owns the conversation, not the local one', () => {
    // The local tab stays active: a paste into a remote conversation must
    // still reach that conversation's server, or its agent cannot read it.
    const packed = (verb: string, args: unknown[]): unknown[] => SHELL_INVOKE[verb].pack!(args)
    expect(resolveShellEnvironment(packed('saveAttachmentData', ['g-1', 'pasted-text-1.txt', 'aGk=']))).toBe('devbox')
    expect(resolveShellEnvironment(packed('attachFileByPath', ['g-1', '/srv/a.txt']))).toBe('devbox')
    expect(resolveShellEnvironment(packed('readFileData', ['g-2', '/srv/a.docx']))).toBe('devbox')
    expect(resolveShellEnvironment(packed('saveAttachmentData', ['local-a', 'pasted-text-1.txt', 'aGk=']))).toBe(LOCAL_ENVIRONMENT_ID)
  })
})
