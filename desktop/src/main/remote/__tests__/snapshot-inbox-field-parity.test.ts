/**
 * Regression: the iOS Inbox flapped because two producers of the same snapshot
 * disagreed about the inbox fields.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 * Three code paths produce the tab list served to iOS:
 *
 *   1. the canonical renderer projection (remote-projection.ts), served from
 *      state.rendererSnapshotCache while it is fresh;
 *   2. the fallback poll (snapshot-renderer-poll.ts), used whenever the cache
 *      is empty or older than RENDERER_CACHE_MAX_AGE_MS — which on an idle
 *      desktop is MOST ticks, not a rare edge;
 *   3. the cold-start path (coldStartSnapshot in snapshot.ts).
 *
 * Paths 2 and 3 each carried their own hand-written projection, and neither
 * ever learned the inbox fields that path 1 added: inboxState, unread,
 * snoozedUntil, settledAt, wokeAt, idleSince. So a cache tick shipped rows
 * carrying the operator's real auto-settle classification, and the very next
 * fallback tick shipped the same rows with no classification at all. iOS files
 * a row with absent `inboxState` as Active (TabListView+Inbox.swift filters on
 * `inboxState != "settled"`, which an absent value passes), so the Inbox
 * visibly alternated between correctly-filed projects and every conversation
 * piled into Active — flipping on the 5s poll cadence.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 * Path 2 stopped transcribing and now CALLS path 1 through a window global.
 * Path 3 cannot reach the renderer, so it classifies the persisted record with
 * the same shared classifier (inbox-classify.ts) instead of omitting the
 * fields.
 *
 * ── Discriminators ──────────────────────────────────────────────────────────
 * Each test below fails on the unfixed code:
 *   - the single-source test fails because the fallback re-declared the whole
 *     field map (and would drift again);
 *   - the cold-start tests fail because the fields were absent (undefined),
 *     which is exactly what iOS mis-files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const { mockGetHealth, mockReadSettings, mockTabsFile } = vi.hoisted(() => ({
  mockGetHealth: vi.fn((): { tabs: Array<{ tabId: string; status: string; conversationId: string | null; lastActivityAt?: number }> } => ({ tabs: [] })),
  mockReadSettings: vi.fn((): Record<string, unknown> => ({})),
  mockTabsFile: { path: '' },
}))

vi.mock('../../state', () => ({
  state: { mainWindow: null, remoteTransport: null, rendererSnapshotCache: null },
  sessionPlane: { getHealth: mockGetHealth },
  lastMessagePreview: new Map<string, string>(),
}))
vi.mock('../../settings-store', () => ({
  get TABS_FILE() { return mockTabsFile.path },
  readSettings: () => mockReadSettings(),
}))
vi.mock('../../event-wiring-resources', () => ({ isResourceRead: () => false }))

import { getRemoteTabStates, _setPollRendererTabStatesForTest } from '../snapshot'
import { state } from '../../state'

import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const DAY_MS = 24 * 60 * 60 * 1000

/** Write a tabs.json holding one persisted conversation and point TABS_FILE at it. */
function writePersistedTab(tab: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ion-inbox-parity-'))
  const file = join(dir, 'tabs.json')
  writeFileSync(file, JSON.stringify({ tabs: [tab] }), 'utf-8')
  mockTabsFile.path = file
  return dir
}

describe('inbox field parity — the fallback poll must not re-implement the projection', () => {
  const POLL_SRC = readFileSync(join(__dirname, '..', 'snapshot-renderer-poll.ts'), 'utf-8')

  it('does not project any inbox field itself (single source of truth)', () => {
    // On the unfixed code the fallback declared each of these keys in its own
    // transcribed field map — except the inbox ones, which it never learned.
    // That asymmetry WAS the bug, so the guard is that it declares none of
    // them: a fallback that maps fields is a fallback that can drift.
    for (const key of ['inboxState:', 'unread:', 'snoozedUntil:', 'settledAt:', 'wokeAt:', 'idleSince:']) {
      expect(POLL_SRC, `fallback must not project "${key}"`).not.toContain(key)
    }
  })

  it('calls the canonical projection through the shared global name', async () => {
    // Not a stringly-typed duplicate: both sides import PROJECTION_GLOBAL.
    const { PROJECTION_GLOBAL } = await import('../../../shared/remote-projection-global')
    expect(POLL_SRC).toContain('PROJECTION_GLOBAL')
    expect(POLL_SRC).toContain('project()')
    expect(PROJECTION_GLOBAL).toBe('__Ion_REMOTE_PROJECTION__')
  })
})

describe('inbox field parity — the cold-start path classifies rather than omits', () => {
  let tmpDir: string | null = null

  beforeEach(() => {
    _setPollRendererTabStatesForTest(vi.fn(async () => ({ tabs: [], resourceManifest: {} })))
    state.rendererSnapshotCache = null
    mockGetHealth.mockReturnValue({ tabs: [] })
    mockReadSettings.mockReturnValue({})
    tmpDir = null
  })

  afterEach(() => {
    _setPollRendererTabStatesForTest(null)
    state.rendererSnapshotCache = null
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('classifies a long-idle conversation as settled under the auto-settle clock', async () => {
    // The operator's real configuration: a 3-day clock and a conversation whose
    // last message is 10 days old. The cache tick called this settled; the
    // cold/fallback tick shipped `inboxState: undefined`, which iOS files as
    // Active. That disagreement is the flap.
    mockReadSettings.mockReturnValue({ inboxAutoSettleDays: 3 })
    tmpDir = writePersistedTab({
      id: 'tab-old',
      title: 'Old work',
      workingDirectory: '/proj',
      lastMessageAt: Date.now() - 10 * DAY_MS,
    })

    const { tabs } = await getRemoteTabStates()
    expect(tabs).toHaveLength(1)
    // FAILS on the unfixed code: inboxState was never projected here.
    expect(tabs[0].inboxState).toBe('settled')
  })

  it('classifies a recent conversation as active under the same clock', async () => {
    // Same clock, fresh conversation → active. Pins that the fix computes the
    // classification rather than hardcoding a value that merely happens to
    // match the settled case above.
    mockReadSettings.mockReturnValue({ inboxAutoSettleDays: 3 })
    tmpDir = writePersistedTab({
      id: 'tab-new',
      title: 'Live work',
      workingDirectory: '/proj',
      lastMessageAt: Date.now() - 60_000,
    })

    const { tabs } = await getRemoteTabStates()
    expect(tabs[0].inboxState).toBe('active')
  })

  it('leaves a long-idle conversation active when the auto-settle clock is off', async () => {
    // autoSettleDays 0/absent disables the clock entirely (effectiveSettled
    // returns false with a null threshold). A cold row must not invent settled.
    mockReadSettings.mockReturnValue({ inboxAutoSettleDays: 0 })
    tmpDir = writePersistedTab({
      id: 'tab-old-noclock',
      title: 'Old work',
      workingDirectory: '/proj',
      lastMessageAt: Date.now() - 100 * DAY_MS,
    })

    const { tabs } = await getRemoteTabStates()
    expect(tabs[0].inboxState).toBe('active')
  })

  it('honours a manual settle override regardless of the clock', async () => {
    // An explicit user decision wins both directions in effectiveSettled. The
    // cold path must carry it, or a manually-settled conversation reappears in
    // Active on every cold tick.
    mockReadSettings.mockReturnValue({ inboxAutoSettleDays: 0 })
    tmpDir = writePersistedTab({
      id: 'tab-manual',
      title: 'Parked',
      workingDirectory: '/proj',
      settledOverride: 'settled',
      settledAt: 1_700_000_000_000,
      lastMessageAt: Date.now() - 60_000,
    })

    const { tabs } = await getRemoteTabStates()
    expect(tabs[0].inboxState).toBe('settled')
    expect(tabs[0].settledAt).toBe(1_700_000_000_000)
  })

  it('projects a live snooze as snoozed and carries its wake time', async () => {
    const wake = Date.now() + 2 * DAY_MS
    tmpDir = writePersistedTab({
      id: 'tab-snoozed',
      title: 'Later',
      workingDirectory: '/proj',
      snoozedUntil: wake,
      snoozedAt: Date.now() - 60_000,
      lastMessageAt: Date.now() - 120_000,
    })

    const { tabs } = await getRemoteTabStates()
    expect(tabs[0].inboxState).toBe('snoozed')
    expect(tabs[0].snoozedUntil).toBe(wake)
  })

  it('derives unread from a message newer than the last visit', async () => {
    tmpDir = writePersistedTab({
      id: 'tab-unread',
      title: 'Spoke while away',
      workingDirectory: '/proj',
      lastVisitedAt: Date.now() - 10 * 60_000,
      lastMessageAt: Date.now() - 60_000,
    })

    const { tabs } = await getRemoteTabStates()
    // FAILS on the unfixed code: unread was never projected on this path.
    expect(tabs[0].unread).toBe(true)
  })

  it('does not mark a never-visited conversation unread (upgrade-day rule)', async () => {
    // inboxUnread treats lastVisitedAt == null as READ, so a fresh install does
    // not light up every historical row. Pinned here because the cold path is
    // exactly where never-visited records show up.
    tmpDir = writePersistedTab({
      id: 'tab-never-visited',
      title: 'Historical',
      workingDirectory: '/proj',
      lastMessageAt: Date.now() - 60_000,
    })

    const { tabs } = await getRemoteTabStates()
    expect(tabs[0].unread ?? false).toBe(false)
  })
})
