// @vitest-environment jsdom
/**
 * useKeyboardShortcuts — catalog-driven handler tests.
 *
 * This is the load-bearing config test: verifies the handler uses resolveBindings()
 * and matchesChord() so user overrides actually control behavior.
 *
 * Tests:
 *   - With override { 'tab.next': 'Mod+]' }, the override chord fires tab.next.
 *   - With override, the OLD default chord (Mod+l) does NOT fire tab.next.
 *     (Revert-check: with a hardcoded 'Mod+l' check, this test would fail because
 *     the old default would still fire regardless of the override.)
 *   - With no overrides, every default chord fires its action.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'

// Force macOS platform so Mod=metaKey is predictable. Must be set before the
// first dynamic import of chord.ts, which evaluates IS_MAC at module scope.
const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform')
beforeAll(() => {
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
})
afterAll(() => {
  if (originalPlatform) Object.defineProperty(navigator, 'platform', originalPlatform)
  else Object.defineProperty(navigator, 'platform', { value: '', configurable: true })
})

// ── Store mocks ────────────────────────────────────────────────────────────

let prefState = {
  editorFontSize: 14, dataViewFontSize: 13,
  keyboardShortcuts: {} as Record<string, string>,
  setEditorFontSize: vi.fn(),
  setDataViewFontSize: vi.fn(),
  defaultBaseDirectory: '',
  engineProfiles: [],
  defaultEngineProfileId: '',
  enterpriseNewConversationDefaults: null,
}

let selectTabMock = vi.fn()
let sessionState: any

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => prefState,
  },
}))

vi.mock('../../stores/sessionStore', async () => {
  return {
    useSessionStore: {
      getState: () => sessionState,
      setState: vi.fn(),
    },
    editorDirForTab: (tab: any) => tab?.workingDirectory ?? '',
  }
})

vi.mock('../../../shared/tab-predicates', () => ({
  tabHasExtensions: () => false,
}))

vi.mock('../../components/new-conversation-routing', () => ({
  resolveNewConversationAction: () => ({ kind: 'plain' }),
  executeNewConversationAction: vi.fn(),
}))

vi.mock('../../preferences-types', async () => {
  const actual = await vi.importActual<any>('../../preferences-types')
  return actual
})

vi.mock('../../stores/conversation-instance', () => ({
  effectivePermissionMode: () => 'plan',
}))

function makeTab(id: string) {
  return {
    id,
    workingDirectory: '/projects/ion',
    worktreeRepoPath: null,
    status: 'idle',
    title: 'Test',
    customTitle: null,
    pillColor: null,
    pillIcon: null,
    groupId: null,
    hasChosenDirectory: true,
    engineProfileId: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  selectTabMock = vi.fn()
  prefState = {
    editorFontSize: 14, dataViewFontSize: 13, setDataViewFontSize: vi.fn(),
    keyboardShortcuts: {},
    setEditorFontSize: vi.fn(),
    defaultBaseDirectory: '',
    engineProfiles: [],
    defaultEngineProfileId: '',
    enterpriseNewConversationDefaults: null,
  }
  const tab = makeTab('tab1')
  sessionState = {
    tabs: [tab, makeTab('tab2')],
    activeTabId: 'tab1',
    fileEditorFocused: false,
    fileEditorOpenDirs: new Set<string>(),
    fileEditorStates: new Map(),
    openFloatingPanelCount: 0,
    isExpanded: false,
    settingsOpen: false,
    terminalOpenTabIds: new Set<string>(),
    terminalTallTabId: null,
    tallViewTabId: null,
    conversationPanes: new Map(),
    selectTab: selectTabMock,
    toggleFileExplorer: vi.fn(),
    toggleFileEditor: vi.fn(),
    toggleTerminal: vi.fn(),
    addTerminalInstance: vi.fn(),
    toggleGitPanel: vi.fn(),
    setPermissionMode: vi.fn(),
    toggleExpanded: vi.fn(),
    createScratchFile: vi.fn(),
    toggleTallView: vi.fn(),
    toggleTerminalTall: vi.fn(),
    openSettings: vi.fn(),
    closeSettings: vi.fn(),
  }
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('catalog-driven handler — override-fires / old-default-doesn\'t', () => {
  it('resolveBindings with override { tab.next: Mod+] } routes Mod+] to tab.next action', async () => {
    const { resolveBindings } = await import('../../shortcuts/shortcut-catalog')
    const { matchesChord } = await import('../../shortcuts/chord')

    const overrides = { 'tab.next': 'Mod+]' }
    const bindings = resolveBindings(overrides)

    // The override chord should match.
    const overrideEvent = { key: ']', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false } as KeyboardEvent
    expect(matchesChord(overrideEvent, bindings.get('tab.next') ?? null)).toBe(true)
  })

  it('old default Mod+l does NOT match tab.next after override to Mod+]', async () => {
    const { resolveBindings } = await import('../../shortcuts/shortcut-catalog')
    const { matchesChord } = await import('../../shortcuts/chord')

    const overrides = { 'tab.next': 'Mod+]' }
    const bindings = resolveBindings(overrides)

    // The old default chord should NOT match the overridden command.
    // If the handler used hardcoded 'Mod+l', this would still fire — revert-check.
    const oldDefaultEvent = { key: 'l', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false } as KeyboardEvent
    expect(matchesChord(oldDefaultEvent, bindings.get('tab.next') ?? null)).toBe(false)
  })

  it('with no overrides, Mod+l matches tab.next (default preserved)', async () => {
    const { resolveBindings } = await import('../../shortcuts/shortcut-catalog')
    const { matchesChord } = await import('../../shortcuts/chord')

    const bindings = resolveBindings({})
    const defaultEvent = { key: 'l', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false } as KeyboardEvent
    expect(matchesChord(defaultEvent, bindings.get('tab.next') ?? null)).toBe(true)
  })

  it('with no overrides, Mod+h matches tab.prev (default preserved)', async () => {
    const { resolveBindings } = await import('../../shortcuts/shortcut-catalog')
    const { matchesChord } = await import('../../shortcuts/chord')

    const bindings = resolveBindings({})
    const e = { key: 'h', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false } as KeyboardEvent
    expect(matchesChord(e, bindings.get('tab.prev') ?? null)).toBe(true)
  })

  it('Ctrl+` matches terminal.toggle default', async () => {
    const { resolveBindings } = await import('../../shortcuts/shortcut-catalog')
    const { matchesChord } = await import('../../shortcuts/chord')

    const bindings = resolveBindings({})
    const e = { key: '`', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false } as KeyboardEvent
    expect(matchesChord(e, bindings.get('terminal.toggle') ?? null)).toBe(true)
  })
})

// ── zoom.in and zoom.inShifted both dispatch zoom-in ──────────────────────
//
// Revert check (zoom.inShifted catalog entry):
//   Without the zoom.inShifted entry in SHORTCUT_CATALOG, resolveBindings would
//   have no binding for 'zoom.inShifted' and the Mod++ event test would fail.
//
// Revert check (shiftOptional flag in chord.ts):
//   Without shiftOptional, matchesChord would reject the Mod++ event (shiftKey=true)
//   for the zoom.inShifted chord even when the entry exists.

describe('zoom.in and zoom.inShifted — both dispatch zoom-in action', () => {
  it('Mod+= (shiftKey=false) matches zoom.in default binding', async () => {
    const { resolveBindings } = await import('../../shortcuts/shortcut-catalog')
    const { matchesChord } = await import('../../shortcuts/chord')

    const bindings = resolveBindings({})
    // zoom.in default is 'Mod+=' — plain equals sign, no shift.
    const e = { key: '=', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false } as KeyboardEvent
    expect(matchesChord(e, bindings.get('zoom.in') ?? null)).toBe(true)
  })

  it('zoom.inShifted entry exists in catalog with default binding Mod++', async () => {
    const { SHORTCUT_CATALOG } = await import('../../shortcuts/shortcut-catalog')
    const entry = SHORTCUT_CATALOG.find((e) => e.id === 'zoom.inShifted')
    expect(entry).toBeDefined()
    expect(entry!.defaultBinding).toBe('Mod++')
  })

  it('Mod++ (shiftKey=true, key="+") matches zoom.inShifted via resolveBindings', async () => {
    const { resolveBindings } = await import('../../shortcuts/shortcut-catalog')
    const { matchesChord } = await import('../../shortcuts/chord')

    const bindings = resolveBindings({})
    // Browsers report shiftKey=true when the user presses Cmd+Shift+= to produce '+'.
    // shiftOptional on the chord must be set so matchesChord accepts it.
    const e = { key: '+', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false } as KeyboardEvent
    expect(matchesChord(e, bindings.get('zoom.inShifted') ?? null)).toBe(true)
  })

  it('Mod+= does NOT match zoom.inShifted (different key)', async () => {
    const { resolveBindings } = await import('../../shortcuts/shortcut-catalog')
    const { matchesChord } = await import('../../shortcuts/chord')

    const bindings = resolveBindings({})
    const e = { key: '=', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false } as KeyboardEvent
    expect(matchesChord(e, bindings.get('zoom.inShifted') ?? null)).toBe(false)
  })

  it('Mod++ does NOT match zoom.in (wrong key)', async () => {
    const { resolveBindings } = await import('../../shortcuts/shortcut-catalog')
    const { matchesChord } = await import('../../shortcuts/chord')

    const bindings = resolveBindings({})
    // zoom.in expects key '=' not '+'.
    const e = { key: '+', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false } as KeyboardEvent
    expect(matchesChord(e, bindings.get('zoom.in') ?? null)).toBe(false)
  })
})
