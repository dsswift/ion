/**
 * The forwarded-store path is THE path for tab lifecycle and prompts, so it
 * must carry everything the desktop's IPC handlers used to: the client
 * pushes, the per-tab cleanup, the automation facts, the prompt delivery
 * acknowledgement, and the plan-path sanitising.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  sessionPlane: {
    createTab: vi.fn(() => 'tab-new'),
    adoptTab: vi.fn((id: string) => id),
    closeTab: vi.fn(),
    hasTab: vi.fn(() => true),
    ensureTab: vi.fn(),
    getTabStatus: vi.fn(() => ({ permissionMode: 'plan' })),
    forkSession: vi.fn(async () => ({ ok: true, conversationId: 'fork-conversation' })),
    setPermissionMode: vi.fn(),
  },
  engineBridge: {
    stopSession: vi.fn(async () => undefined),
    stopByPrefix: vi.fn(),
    sendSteer: vi.fn(),
    sendSetPlanMode: vi.fn(),
    sendAbortDispatch: vi.fn(),
    stopBackgroundTask: vi.fn(async () => ({ ok: true, status: 'stopped' })),
    branchSessionBefore: vi.fn(async () => undefined),
    remapSession: vi.fn(),
  },
  state: {},
  sendRemoteEvent: vi.fn(),
  clientsPresent: vi.fn(() => true),
  activeAssistantMessages: new Map<string, unknown>(),
  lastMessagePreview: new Map<string, string>(),
  lastForwardedTabStatus: new Map<string, string>(),
  lastForwardedTabMeta: new Map<string, number>(),
  extensionCommandRegistry: new Map<string, Set<string>>(),
  getRemoteTabStates: vi.fn(async () => ({ tabs: [{ id: 'tab-new', title: 'New' }] })),
  evictStudioTab: vi.fn(),
  destroyByPrefix: vi.fn(),
  processIncomingPrompt: vi.fn(async () => undefined),
  trigger: vi.fn(async (_event: { type: string; payload?: unknown }, _causation?: unknown) => undefined),
  takeRemotePromptDelivery: vi.fn((): { tabId: string; resolve: (o: unknown) => void } | undefined => undefined),
  isValidProjectPath: vi.fn((p: string) => p.startsWith('/') && !/[\n\0]/.test(p)),
  echoUserTurn: vi.fn(),
}))
vi.mock('../../state', () => ({
  sessionPlane: deps.sessionPlane,
  engineBridge: deps.engineBridge,
  state: deps.state,
  activeAssistantMessages: deps.activeAssistantMessages,
  lastMessagePreview: deps.lastMessagePreview,
  lastForwardedTabStatus: deps.lastForwardedTabStatus,
  lastForwardedTabMeta: deps.lastForwardedTabMeta,
  extensionCommandRegistry: deps.extensionCommandRegistry,
}))
vi.mock('../../ipc-validation', () => ({ isValidProjectPath: deps.isValidProjectPath }))
vi.mock('../../remote/snapshot', () => ({ getRemoteTabStates: deps.getRemoteTabStates }))
vi.mock('../../engine/studio-state-cache', () => ({ evictStudioTab: deps.evictStudioTab }))
vi.mock('../../terminal/terminal-manager-instance', () => ({ terminalManager: { destroyByPrefix: deps.destroyByPrefix } }))
vi.mock('../../engine/prompt-pipeline', () => ({ processIncomingPrompt: deps.processIncomingPrompt }))
vi.mock('../../automation/runtime', () => ({ getAutomationRuntime: () => ({ trigger: deps.trigger }) }))
// Only the lookup is stubbed: the outcome is routed by the real module, so these cases pin what reaches the submitter.
vi.mock('../../remote/prompt-delivery', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../remote/prompt-delivery')>()), takeRemotePromptDelivery: deps.takeRemotePromptDelivery }))
vi.mock('../../user-turn-echo', () => ({ echoUserTurn: deps.echoUserTurn }))
vi.mock('../../slash-parse', () => ({ parseSlash: (t: string) => (t.startsWith('/') ? { command: t.slice(1).split(' ')[0], args: '' } : null) }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../thin-view/remote-out', () => ({ sendRemoteEvent: deps.sendRemoteEvent, remoteClientsPresent: deps.clientsPresent }))

import { adoptTab, closeTab, createTab, engineFork, engineSetPlanMode, engineStopBackgroundTask, prompt, setPermissionMode, steer } from '../host-api-engine'
import type { RunOptions } from '@ion/shared/types'

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.clearAllMocks()
  deps.clientsPresent.mockReturnValue(true)
  deps.takeRemotePromptDelivery.mockReturnValue(undefined)
  for (const m of [deps.activeAssistantMessages, deps.lastMessagePreview, deps.lastForwardedTabStatus, deps.lastForwardedTabMeta, deps.extensionCommandRegistry]) m.clear()
})

describe('tab lifecycle', () => {
  it('createTab / adoptTab push desktop_tab_created to every client with the projected tab', async () => {
    expect(createTab()).toEqual({ tabId: 'tab-new' })
    await flush()
    expect(deps.sendRemoteEvent).toHaveBeenCalledWith({ type: 'desktop_tab_created', tab: { id: 'tab-new', title: 'New' } })

    deps.sendRemoteEvent.mockClear()
    expect(adoptTab('tab-new')).toEqual({ tabId: 'tab-new' })
    await flush()
    expect(deps.sendRemoteEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'desktop_tab_created' }))
  })

  it('createTab with no client connected does not read the projection at all', async () => {
    deps.clientsPresent.mockReturnValue(false)
    createTab()
    await flush()
    expect(deps.getRemoteTabStates).not.toHaveBeenCalled()
  })

  it('closeTab stops the session, pushes desktop_tab_closed, and clears every per-tab record', async () => {
    deps.activeAssistantMessages.set('t1', {})
    deps.lastMessagePreview.set('t1', 'x')
    deps.lastForwardedTabStatus.set('t1', 'idle')
    deps.lastForwardedTabMeta.set('t1', 1)
    deps.extensionCommandRegistry.set('t1', new Set())
    deps.extensionCommandRegistry.set('t1:sub', new Set())
    deps.extensionCommandRegistry.set('t10', new Set())

    await closeTab('t1')

    expect(deps.sessionPlane.closeTab).toHaveBeenCalledWith('t1')
    expect(deps.destroyByPrefix).toHaveBeenCalledWith('t1:')
    expect(deps.engineBridge.stopSession).toHaveBeenCalledWith('t1')
    expect(deps.engineBridge.stopByPrefix).toHaveBeenCalledWith('t1:')
    expect(deps.sendRemoteEvent).toHaveBeenCalledWith({ type: 'desktop_tab_closed', tabId: 't1' })
    expect(deps.evictStudioTab).toHaveBeenCalledWith('t1')
    expect(deps.activeAssistantMessages.has('t1')).toBe(false)
    expect(deps.lastMessagePreview.has('t1')).toBe(false)
    expect(deps.lastForwardedTabStatus.has('t1')).toBe(false)
    expect(deps.lastForwardedTabMeta.has('t1')).toBe(false)
    expect([...deps.extensionCommandRegistry.keys()]).toEqual(['t10'])
  })
})

describe('prompt', () => {
  const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({ prompt: 'hello', projectPath: '/p', ...overrides } as RunOptions)

  it('runs the pipeline, then emits prompt:submitted and the authorship-classified message fact', async () => {
    await prompt('t1', 'req-1', options({ deliveryId: 'd-1' }))
    expect(deps.processIncomingPrompt).toHaveBeenCalledWith(expect.objectContaining({ tabId: 't1', reqId: 'req-1', source: 'desktop', text: 'hello' }))
    const types = deps.trigger.mock.calls.map(([e]) => (e as { type: string }).type)
    expect(types).toEqual(['prompt:submitted', 'conversation:message-submitted'])
    expect(deps.trigger.mock.calls[0][0]).toMatchObject({ payload: { tabId: 't1', requestId: 'req-1', deliveryId: 'd-1', permissionMode: 'plan', isSlash: false } })
    expect(deps.trigger.mock.calls[1][0]).toMatchObject({ payload: { clientMessageId: 'd-1', isSteer: false } })
  })

  it('a slash prompt also emits conversation:slash', async () => {
    await prompt('t1', 'req-2', options({ prompt: '/plan go' }))
    const types = deps.trigger.mock.calls.map(([e]) => (e as { type: string }).type)
    expect(types).toEqual(['prompt:submitted', 'conversation:message-submitted', 'conversation:slash'])
  })

  it('acknowledges the awaiting submitter as accepted, or rejected with the reason', async () => {
    const accepted = vi.fn()
    deps.takeRemotePromptDelivery.mockReturnValue({ tabId: 't1', resolve: accepted })
    await prompt('t1', 'req-3', options())
    expect(accepted).toHaveBeenCalledWith({ accepted: true })

    const rejected = vi.fn()
    deps.takeRemotePromptDelivery.mockReturnValue({ tabId: 't1', resolve: rejected })
    deps.processIncomingPrompt.mockRejectedValueOnce(new Error('engine down'))
    await expect(prompt('t1', 'req-4', options())).rejects.toThrow('engine down')
    expect(rejected).toHaveBeenCalledWith({ accepted: false, reason: 'engine down' })
  })

  it('passes source=desktop to the pipeline even for a remote-source prompt (this is the sink of the remote roundtrip)', async () => {
    await prompt('tab-1', 'req-1', options({ prompt: 'hello from ios', source: 'remote' }))
    expect(deps.processIncomingPrompt).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-1', reqId: 'req-1', source: 'desktop', hasExtensions: false }))
  })

  // The user turn reaches every thin client as a row on its transcript
  // stream, published from the store. prompt() itself sends nothing.
  it('publishes no user turn itself, for any source', async () => {
    const rawAttachments = [{ type: 'image' as const, name: 'shot.png', path: '/u/.ion/user-images/abc.png' }]
    await prompt('tab-4', 'req-4', options({ prompt: 'typed in desktop', rawAttachments }))
    await prompt('tab-3', 'req-3', options({ prompt: 'from ios', source: 'remote' }))
    await prompt('tab-q', 'req-q', options({ prompt: 'provider prompt', displayText: '**Question?**\n- Answer', source: 'remote', publishUserTurn: true, injectionKind: 'structured_answer' } as Partial<RunOptions>))
    expect(deps.echoUserTurn).not.toHaveBeenCalled()
    expect(deps.sendRemoteEvent).not.toHaveBeenCalled()
    expect(deps.processIncomingPrompt).toHaveBeenLastCalledWith(expect.objectContaining({ displayText: '**Question?**\n- Answer', publishUserTurn: true }))
  })

  it('refuses a prompt with no tab or no request id before touching the pipeline', async () => {
    await expect(prompt('', 'r', options())).rejects.toThrow(/tabId/)
    await expect(prompt('t1', '', options())).rejects.toThrow(/requestId/)
    expect(deps.processIncomingPrompt).not.toHaveBeenCalled()
  })
})

describe('steer', () => {
  it('dispatches to the engine and emits the message fact with isSteer', async () => {
    steer('t1', 'more', 'cm-1', { projectPath: '/p', worktreePath: '/p', source: 'desktop' })
    expect(deps.engineBridge.sendSteer).toHaveBeenCalledWith('t1', 'more', 'cm-1')
    await flush()
    expect(deps.trigger).toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation:message-submitted', payload: expect.objectContaining({ tabId: 't1', clientMessageId: 'cm-1', isSteer: true, permissionMode: 'plan' }) }))
  })

  it('drops a steer for an unregistered tab', () => {
    deps.sessionPlane.hasTab.mockReturnValueOnce(false)
    steer('ghost', 'x')
    expect(deps.engineBridge.sendSteer).not.toHaveBeenCalled()
  })
})

describe('plan-path sanitising (formerly ipc/engine.ts sanitizePlanFilePath)', () => {
  it('engineSetPlanMode forwards a valid planFilePath and drops a malformed one without aborting the toggle', () => {
    engineSetPlanMode('key-1', true, '/abs/PLAN.md')
    expect(deps.engineBridge.sendSetPlanMode).toHaveBeenCalledWith('key-1', true, undefined, 'prompt_sync', undefined, '/abs/PLAN.md')
    engineSetPlanMode('key-1', true, '../escape/PLAN.md')
    expect(deps.engineBridge.sendSetPlanMode).toHaveBeenLastCalledWith('key-1', true, undefined, 'prompt_sync', undefined, undefined)
  })

  it('setPermissionMode forwards a valid planFilePath, drops a malformed one, and ignores an invalid mode entirely', () => {
    setPermissionMode('tab1', 'plan', undefined, '/abs/PLAN.md')
    expect(deps.sessionPlane.setPermissionMode).toHaveBeenCalledWith('tab1', 'plan', undefined, '/abs/PLAN.md')
    setPermissionMode('tab1', 'plan', undefined, 'bad\npath')
    expect(deps.sessionPlane.setPermissionMode).toHaveBeenLastCalledWith('tab1', 'plan', undefined, undefined)
    deps.sessionPlane.setPermissionMode.mockClear()
    setPermissionMode('tab1', 'bogus', undefined, '/abs/PLAN.md')
    expect(deps.sessionPlane.setPermissionMode).not.toHaveBeenCalled()
  })

  it('engineFork routes the durable fork through the session plane', async () => {
    const target = { messageIndex: 4, entryId: 'entry-5', userTurnIndex: 2 }
    expect(await engineFork('source-tab', 'fork-tab', target)).toEqual({ ok: true, conversationId: 'fork-conversation' })
    expect(deps.sessionPlane.forkSession).toHaveBeenCalledWith('source-tab', 'fork-tab', target)
  })

  it('engineStopBackgroundTask refuses an empty task id before asking the engine', async () => {
    expect(await engineStopBackgroundTask('k', '  ')).toEqual({ ok: false, error: 'taskId is required' })
    expect(deps.engineBridge.stopBackgroundTask).not.toHaveBeenCalled()
  })
})
