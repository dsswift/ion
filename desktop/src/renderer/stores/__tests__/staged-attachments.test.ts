/**
 * Staged attachments survive restart, rewind, and fork.
 *
 * The defect these pin: text and attachments were not treated as one unit of
 * unsent composition.
 *
 *   - PERSISTENCE. `draftInput` was written to tabs.json; `tab.attachments`
 *     was not. A user who pasted an image, typed a sentence, and relaunched
 *     got the sentence back and a stranded image.
 *   - REWIND. Rewinding to a turn pre-filled the input bar with the turn's
 *     TEXT (pendingInput/draftInput) and dropped `targetMessage.attachments`
 *     on the floor. The truncation then removed the only row that referenced
 *     them, so the turn became un-resendable as sent.
 *   - FORK. The same drop, at the fork seam.
 *
 * The persisted form deliberately omits `dataUrl`: it is a base64 preview,
 * tabs.json is rewritten on a 100 ms debounce, and prompt-pipeline's
 * encodeAttachments re-reads the bytes from `path` at send time. Correctness
 * is in `path`; the thumbnail is rebuilt on restore.
 *
 * Revert check: drop `attachments: restagedAttachments` from
 * engine-slice-rewind and the rewind arms go red; drop the
 * `...(t.attachments.length > 0 ...)` spread from session-store-persistence
 * and the persistence arm goes red.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({
      tabRecoveryEnabled: false,
      expandOnTabSwitch: true,
      keepTerminalOnCollapse: false,
      keepExplorerOnCollapse: false,
      keepGitPanelOnCollapse: false,
      keepStatusDrawerOnCollapse: false,
    }),
  },
}))
vi.mock('../../components/TerminalInstance', () => ({
  serializeTerminalBuffer: () => null,
}))
vi.mock('../../../shared/tab-predicates', () => ({
  tabHasExtensions: () => false,
}))
vi.mock('../serialize-conversation-pane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../serialize-conversation-pane')>()
  return { ...actual, serializeConversationPane: () => null }
})
vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({ attachments: [], queuedPrompts: [] })),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

import { setupPersistence } from '../session-store-persistence'
import { createEngineRewindActions } from '../slices/engine-slice-rewind'
import { createAttachmentsSlice } from '../slices/attachments-slice'
import { createForkSlice } from '../slices/resume-slice-fork'
import { stageableAttachments, persistableAttachments, needsPreviewRehydration } from '../../../shared/staged-attachments'
import type { State } from '../session-store-types'
import type { FileAttachment, Attachment } from '../../../shared/types-session'

const IMAGE: FileAttachment = {
  id: 'att-1',
  type: 'image',
  name: 'screenshot.png',
  path: '/perm/store/ab12cd.png',
  mimeType: 'image/png',
  contentHash: 'ab12cd',
  dataUrl: 'data:image/png;base64,AAAA',
  size: 4096,
}

const PLAN: Attachment = { id: 'att-plan', type: 'plan', name: 'plan.md', path: '/plans/p.md' }

// ─── The shared narrowings ───────────────────────────────────────────────────

describe('staged-attachments helpers', () => {
  it('stageableAttachments drops plan pointers and keeps file attachments', () => {
    expect(stageableAttachments([IMAGE, PLAN])).toEqual([IMAGE])
    expect(stageableAttachments(undefined)).toEqual([])
    expect(stageableAttachments([])).toEqual([])
  })

  it('persistableAttachments strips dataUrl and keeps the path identity', () => {
    const [persisted] = persistableAttachments([IMAGE])
    expect(persisted.dataUrl).toBeUndefined()
    expect(persisted.path).toBe(IMAGE.path)
    expect(persisted.contentHash).toBe(IMAGE.contentHash)
    expect(persisted.size).toBe(IMAGE.size)
    // The source row is untouched — the tray keeps its live preview.
    expect(IMAGE.dataUrl).toBe('data:image/png;base64,AAAA')
  })

  it('needsPreviewRehydration selects exactly the previewless images', () => {
    expect(needsPreviewRehydration(IMAGE)).toBe(false)
    expect(needsPreviewRehydration({ ...IMAGE, dataUrl: undefined })).toBe(true)
    // A non-image has no thumbnail to rebuild.
    expect(needsPreviewRehydration({ ...IMAGE, type: 'file', dataUrl: undefined })).toBe(false)
  })
})

// ─── Persistence ─────────────────────────────────────────────────────────────

function makeTab(overrides: Record<string, any> = {}): any {
  return {
    id: 'tab1',
    title: 'Test Tab',
    customTitle: null,
    workingDirectory: '/tmp',
    hasChosenDirectory: false,
    conversationId: null,
    status: 'idle',
    historicalSessionIds: [],
    lastKnownSessionId: null,
    bashResults: [],
    pillColor: null,
    pillIcon: null,
    forkedFromSessionId: null,
    worktree: null,
    groupId: null,
    groupPinned: false,
    queuedPrompts: [],
    attachments: [],
    contextTokens: 0,
    lastMessagePreview: null,
    lastEventAt: null,
    isTerminalOnly: false,
    additionalDirs: [],
    permissionMode: 'auto',
    engineProfileId: null,
    ...overrides,
  }
}

function makeStoreStub(initialState: Partial<any> = {}) {
  const listeners: Array<(s: any, p: any) => void> = []
  let currentState: any = {
    tabs: [],
    activeTabId: 'tab1',
    isExpanded: true,
    fileEditorStates: new Map(),
    fileEditorOpenDirs: new Set(),
    editorGeometry: { x: 0, y: 0, w: 0, h: 0 },
    planGeometry: { x: 0, y: 0, w: 0, h: 0 },
    agentDetailGeometry: { x: 0, y: 0, w: 0, h: 0 },
    terminalPanes: new Map(),
    conversationPanes: new Map(),
    settledHistory: [],
    tabRecoveryEnabled: false,
    rehydrating: false,
    tabsReady: false,
    forceRecoverTab: vi.fn(),
    ...initialState,
  }
  return {
    subscribe: (fn: (s: any, p: any) => void) => { listeners.push(fn); return () => {} },
    getState: () => currentState,
    setState: (patch: any) => {
      const prev = { ...currentState }
      const next = typeof patch === 'function' ? patch(currentState) : patch
      currentState = { ...currentState, ...next }
      listeners.forEach((fn) => fn(currentState, prev))
    },
  } as any
}

function lastSavedTabs(): any[] {
  const calls = ((globalThis as any).window.ion.saveTabs as ReturnType<typeof vi.fn>).mock.calls
  return calls[calls.length - 1][0].tabs
}

beforeEach(() => {
  ;(globalThis as any).window = {
    addEventListener: vi.fn(),
    ion: {
      saveTabs: vi.fn().mockResolvedValue(undefined),
      loadSessionChains: vi.fn(() => Promise.resolve({ chains: {}, reverse: {} })),
      saveSessionChains: vi.fn(() => Promise.resolve()),
    },
  }
})

describe('session-store-persistence — staged attachments', () => {
  it('writes the staged tray alongside the draft, without the base64 preview', () => {
    const store = makeStoreStub({ tabs: [makeTab({ conversationId: null })] })
    setupPersistence(store)
    // conversationId capture forces an immediate (non-debounced) persist.
    store.setState({ tabs: [makeTab({ conversationId: 'conv-1', attachments: [IMAGE] })] })

    const [saved] = lastSavedTabs()
    expect(saved.attachments).toHaveLength(1)
    expect(saved.attachments[0].path).toBe(IMAGE.path)
    expect(saved.attachments[0].dataUrl).toBeUndefined()
  })

  it('omits the field entirely when the tray is empty', () => {
    const store = makeStoreStub({ tabs: [makeTab({ conversationId: null })] })
    setupPersistence(store)
    store.setState({ tabs: [makeTab({ conversationId: 'conv-1', attachments: [] })] })

    expect(lastSavedTabs()[0]).not.toHaveProperty('attachments')
  })
})

// ─── Rewind ──────────────────────────────────────────────────────────────────

function makeInstance(messages: any[]) {
  return {
    id: 'inst1',
    label: 'Engine',
    messages,
    messageCount: messages.length,
    modelOverride: null,
    modelOverrideSource: null,
    sessionModel: null,
    permissionMode: 'auto',
    permissionDenied: null,
    permissionQueue: [],
    elicitationQueue: [],
    conversationIds: ['conv-prior'],
    draftInput: '',
    agentStates: [],
    statusFields: null,
    planFilePath: null,
    dispatchTelemetry: [],
    contextBreakdown: null,
  }
}

function buildRewindHarness(messages: any[], tabAttachments: FileAttachment[] = []) {
  const state: any = {
    tabs: [{ id: 'tab1', title: 'Engine', engineProfileId: 'p', attachments: tabAttachments }],
    conversationPanes: new Map([['tab1', { instances: [makeInstance(messages)], activeInstanceId: 'inst1' }]]),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const slice = createEngineRewindActions(set, () => state as State) as State
  return { state, slice }
}

const REWIND_MESSAGES = [
  { id: 'e-0', role: 'user', content: 'first prompt', timestamp: 1 },
  { id: 'a-0', role: 'assistant', content: 'reply', timestamp: 2 },
  { id: 'e-1', role: 'user', content: 'look at this', timestamp: 3, attachments: [IMAGE, PLAN] },
  { id: 'a-1', role: 'assistant', content: 'reply', timestamp: 4 },
]

describe('rewindEngineInstance — attachment restaging', () => {
  beforeEach(() => {
    ;(globalThis as any).window = {
      ion: {
        engineRewind: vi.fn(async () => ({ ok: true })),
        engineBroadcastHistory: vi.fn(async () => {}),
        engineStop: vi.fn(async () => {}),
        engineStart: vi.fn(async () => ({ ok: true })),
      },
    }
  })

  it('restages the rewound turn\'s file attachments onto the tab', async () => {
    const { state, slice } = buildRewindHarness(REWIND_MESSAGES)
    const result = await slice.rewindEngineInstance('tab1', 'inst1', 'e-1')

    expect(result.ok).toBe(true)
    expect(result.prefill).toEqual({ text: 'look at this', attachments: [IMAGE] })
    expect(state.tabs[0].pendingInput).toBe('look at this')
    // The image comes back with its preview; the plan pointer does not.
    expect(state.tabs[0].attachments).toEqual([IMAGE])
  })

  it('clears a stale tray when the rewound turn had no attachments', async () => {
    // The tray reflects the turn being re-composed. Leaving a previously
    // staged image behind would silently add a file to the resent prompt.
    const { state, slice } = buildRewindHarness(REWIND_MESSAGES, [IMAGE])
    const result = await slice.rewindEngineInstance('tab1', 'inst1', 'e-0')

    expect(result.prefill).toEqual({ text: 'first prompt', attachments: [] })
    expect(state.tabs[0].pendingInput).toBe('first prompt')
    expect(state.tabs[0].attachments).toEqual([])
  })

  it('leaves the tray untouched when the engine refuses the rewind', async () => {
    ;(globalThis as any).window.ion.engineRewind = vi.fn(async () => ({ ok: false, error: 'nope' }))
    const { state, slice } = buildRewindHarness(REWIND_MESSAGES, [IMAGE])
    const result = await slice.rewindEngineInstance('tab1', 'inst1', 'e-0')

    expect(result.ok).toBe(false)
    expect(result.prefill).toBeUndefined()
    expect(state.tabs[0].attachments).toEqual([IMAGE])
    expect(state.tabs[0].pendingInput).toBeUndefined()
  })
})

// ─── Fork ────────────────────────────────────────────────────────────────────

describe('forkFromMessage — attachment restaging', () => {
  it('seeds the new tab\'s tray from the forked turn', async () => {
    ;(globalThis as any).window = {
      ion: {
        createTab: vi.fn(async () => ({ tabId: 'tab2' })),
        setPermissionMode: vi.fn(),
      },
    }
    const state: any = {
      tabs: [{
        id: 'tab1', title: 'Source', customTitle: null, workingDirectory: '/tmp',
        hasChosenDirectory: true, additionalDirs: [], pillColor: null, pillIcon: null,
        engineProfileId: 'p', conversationId: 'conv-1', attachments: [],
      }],
      conversationPanes: new Map([['tab1', { instances: [makeInstance(REWIND_MESSAGES)], activeInstanceId: 'inst1' }]]),
    }
    const set = (partial: any) => {
      const patch = typeof partial === 'function' ? partial(state) : partial
      Object.assign(state, patch)
    }
    const slice = createForkSlice(set, () => state as State) as State

    const newTabId = await slice.forkFromMessage('tab1', 'e-1')

    expect(newTabId).toBe('tab2')
    const forked = state.tabs.find((t: any) => t.id === 'tab2')
    expect(forked.pendingInput).toBe('look at this')
    expect(forked.attachments).toEqual([IMAGE])
  })
})

// ─── Preview rehydration ─────────────────────────────────────────────────────

describe('rehydrateAttachmentPreviews', () => {
  function buildSlice(tabs: any[]) {
    const state: any = { tabs, activeTabId: tabs[0]?.id }
    const set = (partial: any) => {
      const patch = typeof partial === 'function' ? partial(state) : partial
      Object.assign(state, patch)
    }
    return { state, slice: createAttachmentsSlice(set, () => state as State) as State }
  }

  it('rebuilds the preview from the attachment path', async () => {
    const stripped = { ...IMAGE, dataUrl: undefined }
    const attachFileByPath = vi.fn(async () => ({ ...IMAGE, dataUrl: 'data:image/png;base64,REBUILT' }))
    ;(globalThis as any).window = { ion: { attachFileByPath } }

    const { state, slice } = buildSlice([{ id: 'tab1', attachments: [stripped] }])
    await slice.rehydrateAttachmentPreviews()

    expect(attachFileByPath).toHaveBeenCalledWith(IMAGE.path)
    expect(state.tabs[0].attachments[0].dataUrl).toBe('data:image/png;base64,REBUILT')
    // Identity is preserved — rehydration patches the row, it does not replace it.
    expect(state.tabs[0].attachments[0].id).toBe(IMAGE.id)
  })

  it('keeps the row when the file is gone rather than dropping a staged attachment', async () => {
    const stripped = { ...IMAGE, dataUrl: undefined }
    ;(globalThis as any).window = { ion: { attachFileByPath: vi.fn(async () => null) } }

    const { state, slice } = buildSlice([{ id: 'tab1', attachments: [stripped] }])
    await slice.rehydrateAttachmentPreviews()

    expect(state.tabs[0].attachments).toHaveLength(1)
    expect(state.tabs[0].attachments[0].dataUrl).toBeUndefined()
  })

  it('does not call IPC when every preview is already present', async () => {
    const attachFileByPath = vi.fn()
    ;(globalThis as any).window = { ion: { attachFileByPath } }

    const { slice } = buildSlice([{ id: 'tab1', attachments: [IMAGE] }])
    await slice.rehydrateAttachmentPreviews()

    expect(attachFileByPath).not.toHaveBeenCalled()
  })
})
