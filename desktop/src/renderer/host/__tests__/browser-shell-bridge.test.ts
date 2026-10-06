// @vitest-environment jsdom
/**
 * Pins the bridged `host.shell` surface for a browser Studio client.
 *
 * The marshalling assertions matter more than they look: the server reads
 * named fields off `args[0]`, so a bridge entry that forwards a bare
 * positional argument where the preload sends `{ provider }` fails SILENTLY
 * — the server sees `undefined` and refuses with a validation error that
 * looks like a user mistake. Each case here is written against the server
 * action that reads the payload.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../web-storage', () => ({
  getDeviceSettings: vi.fn(async () => ({})),
  setDeviceSetting: vi.fn(async () => {}),
  getEnvCache: vi.fn(async () => null),
  setEnvCache: vi.fn(async () => {}),
}))

import { BrowserStudioHost } from '../BrowserStudioHost'
import { SHELL_INVOKE, SHELL_SUBSCRIBE } from '../browser-shell-bridge'

class FakeWebSocket {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 0
  sent: string[] = []
  private listeners: Record<string, Array<(ev: { data?: string }) => void>> = {}
  constructor(readonly url: string) { FakeWebSocket.instances.push(this) }
  addEventListener(type: string, cb: (ev: { data?: string }) => void): void {
    ;(this.listeners[type] ??= []).push(cb)
  }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.readyState = 3 }
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    for (const cb of this.listeners.open ?? []) cb({})
  }
  simulateMessage(data: string): void {
    for (const cb of this.listeners.message ?? []) cb({ data })
  }
}

function welcomeFrame(): string {
  return JSON.stringify({
    type: 'studio_welcome', protocolVersion: 1, environmentId: 'srv', label: 'Test',
    platform: 'linux', serverVersion: '0.0.0', engineVersion: '0.0.0', capabilities: [],
    principal: { subject: 'local:test', displayName: 'test' }, scopes: [], enterprisePolicy: null, settingsHiddenGroups: [], developerSurfaces: { sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: true }, policyHash: 'sha256:test', snapshot: {},
  })
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let host: BrowserStudioHost
let ws: FakeWebSocket

beforeEach(async () => {
  FakeWebSocket.instances.length = 0
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket
  Object.defineProperty(window, 'location', {
    value: { origin: 'http://ion.example.test', pathname: '/', search: '', href: '' },
    writable: true,
  })
  host = new BrowserStudioHost()
  await host.connectEnvironment('local', 'This Server', { kind: 'local' })
  await flush()
  ws = FakeWebSocket.instances[0]
  ws.simulateOpen()
  ws.simulateMessage(welcomeFrame())
  ws.sent.length = 0
})

/** The studio_action frame the last bridged call put on the wire. */
function lastAction(): { action: string; args: unknown[]; id: string } {
  const frames = ws.sent.map((s) => JSON.parse(s)).filter((f) => f.type === 'studio_action')
  return frames[frames.length - 1]
}

describe('bridged invoke marshalling', () => {
  it('wraps a single positional argument the way the preload does', () => {
    void host.shell.setDefaultProvider('anthropic')
    expect(lastAction()).toMatchObject({ action: 'provider.setDefault', args: [{ provider: 'anthropic' }] })
  })

  it('packs storeCredential into one object, not two positionals', () => {
    void host.shell.storeCredential('anthropic', 'sk-test')
    expect(lastAction().args).toEqual([{ provider: 'anthropic', credential: 'sk-test' }])
  })

  it('packs removeModelTier by name', () => {
    void host.shell.removeModelTier('fast')
    expect(lastAction().args).toEqual([{ name: 'fast' }])
  })

  it('passes a whole tier object straight through', () => {
    const tier = { name: 'fast', model: 'claude-sonnet-5', fallbacks: [] }
    void host.shell.setModelTier(tier)
    expect(lastAction().args).toEqual([tier])
  })

  it('names the directory the way the fs handler reads it', () => {
    void host.shell.fsReadDir('/data/repos/ion')
    expect(lastAction()).toMatchObject({ action: 'fs.readDir', args: [{ directory: '/data/repos/ion' }] })
  })

  it('sends a workspace search request as the one object the server reads', () => {
    const request = { roots: ['/data/repos/ion'], query: 'platform_grafana_principal_id', caseSensitive: false, wholeWord: true }
    void host.shell.searchText(request)
    expect(lastAction()).toMatchObject({ action: 'fs.searchText', args: [request] })
  })

  it('packs fsWriteFile into one object, not two positionals', () => {
    void host.shell.fsWriteFile('/data/repos/ion/a.txt', 'body')
    expect(lastAction().args).toEqual([{ filePath: '/data/repos/ion/a.txt', content: 'body' }])
  })

  it('packs fsRename into one object', () => {
    void host.shell.fsRename('/a', '/b')
    expect(lastAction().args).toEqual([{ oldPath: '/a', newPath: '/b' }])
  })

  it('sends no arguments for the parameterless reads', () => {
    void host.shell.listModels()
    expect(lastAction()).toMatchObject({ action: 'model.list', args: [] })
  })

  it('resolves with the server value', async () => {
    const pending = host.shell.listModelTiers()
    const { id } = lastAction()
    ws.simulateMessage(JSON.stringify({ type: 'studio_action_result', id, ok: true, value: [{ name: 'fast' }] }))
    await expect(pending).resolves.toEqual([{ name: 'fast' }])
  })

  it('rejects with the server refusal message', async () => {
    const pending = host.shell.setDefaultProvider('anthropic')
    const { id } = lastAction()
    ws.simulateMessage(JSON.stringify({
      type: 'studio_action_result', id, ok: false,
      refusal: { code: 'scope', message: 'provider.setDefault requires scope admin' },
    }))
    await expect(pending).rejects.toThrow('requires scope admin')
  })
})

describe('FR-04 git identity bridging', () => {
  it('sends no arguments for the parameterless list', () => {
    void host.shell.gitIdentityList()
    expect(lastAction()).toMatchObject({ action: 'gitIdentity.list', args: [] })
  })

  it('names the host for mintSshKey/remove/authorize', () => {
    void host.shell.gitIdentityMintSshKey('github.com')
    expect(lastAction()).toMatchObject({ action: 'gitIdentity.mintSshKey', args: [{ host: 'github.com' }] })
    void host.shell.gitIdentityRemove('github.com')
    expect(lastAction()).toMatchObject({ action: 'gitIdentity.remove', args: [{ host: 'github.com' }] })
    void host.shell.gitIdentityAuthorize('gitlab.example.com')
    expect(lastAction()).toMatchObject({ action: 'gitIdentity.authorize', args: [{ host: 'gitlab.example.com' }] })
  })

  it('packs setSshKey into one object', () => {
    void host.shell.gitIdentitySetSshKey('github.com', 'PRIVATE-KEY')
    expect(lastAction()).toMatchObject({ action: 'gitIdentity.setSshKey', args: [{ host: 'github.com', privateKey: 'PRIVATE-KEY' }] })
  })

  it('packs setToken into one object', () => {
    void host.shell.gitIdentitySetToken('gitlab.example.com', 'glpat-x', 'alice')
    expect(lastAction()).toMatchObject({ action: 'gitIdentity.setToken', args: [{ host: 'gitlab.example.com', token: 'glpat-x', username: 'alice' }] })
  })

  it('resolves mintSshKey with the servers value', async () => {
    const pending = host.shell.gitIdentityMintSshKey('github.com')
    const { id } = lastAction()
    ws.simulateMessage(JSON.stringify({ type: 'studio_action_result', id, ok: true, value: { publicKey: 'ssh-ed25519 AAAA' } }))
    await expect(pending).resolves.toEqual({ publicKey: 'ssh-ed25519 AAAA' })
  })

  it('rejects mintSshKey with the servers error message', async () => {
    const pending = host.shell.gitIdentityMintSshKey('github.com')
    const { id } = lastAction()
    ws.simulateMessage(JSON.stringify({ type: 'studio_action_result', id, ok: false, error: { code: 'mint_failed', message: 'ssh-keygen not found' } }))
    await expect(pending).rejects.toThrow('ssh-keygen not found')
  })
})

describe('terminal bridging', () => {
  it('packs create, attach, write and resize the way the preload does', () => {
    void host.shell.terminalCreate('tab-1:inst-1', '/repo')
    expect(lastAction()).toMatchObject({ action: 'terminal.create', args: [{ key: 'tab-1:inst-1', cwd: '/repo' }] })

    void host.shell.terminalAttach('tab-1:inst-1', { restartIfNotRunning: true, cwd: '/repo' })
    expect(lastAction().args).toEqual([{ key: 'tab-1:inst-1', restartIfNotRunning: true, cwd: '/repo' }])

    host.shell.terminalWrite('tab-1:inst-1', 'ls\n')
    expect(lastAction()).toMatchObject({ action: 'terminal.write', args: [{ key: 'tab-1:inst-1', data: 'ls\n' }] })

    host.shell.terminalResize('tab-1:inst-1', 120, 40)
    expect(lastAction().args).toEqual([{ key: 'tab-1:inst-1', cols: 120, rows: 40 }])
  })

  it('sends a keystroke without arming a correlation listener or timer', () => {
    // One-way: the whole point is that typing does not create a pending
    // promise plus a 30s timer per keypress. It returns undefined, not a
    // promise, and nothing waits for the server's reply.
    const result = host.shell.terminalWrite('tab-1:inst-1', 'x') as unknown
    expect(result).toBeUndefined()
    expect(lastAction().action).toBe('terminal.write')
  })

  it('spreads a multi-argument terminal event into positional callback args', () => {
    // ion:terminal-incoming is published as broadcast(channel, key, data), so
    // the payload arrives as [key, data]. Handing the listener the array
    // instead would give it key === [key, data] -- a mismatch that only shows
    // up as a terminal rendering its own key as output.
    const seen: unknown[][] = []
    host.shell.onTerminalData((key: string, data: string) => seen.push([key, data]))
    ws.simulateMessage(JSON.stringify({
      type: 'studio_event', channel: 'ion:terminal-incoming', payload: ['tab-1:inst-1', 'hello'],
    }))
    expect(seen).toEqual([['tab-1:inst-1', 'hello']])
  })

  it('spreads the exit event too', () => {
    const seen: unknown[][] = []
    host.shell.onTerminalExit((key: string, code: number) => seen.push([key, code]))
    ws.simulateMessage(JSON.stringify({
      type: 'studio_event', channel: 'ion:terminal-exit', payload: ['tab-1:inst-1', 0],
    }))
    expect(seen).toEqual([['tab-1:inst-1', 0]])
  })

  it('does NOT spread the single-object activity event', () => {
    const seen: unknown[] = []
    host.shell.onTerminalActivity((activity: unknown) => seen.push(activity))
    ws.simulateMessage(JSON.stringify({
      type: 'studio_event', channel: 'ion:terminal-activity', payload: { tabId: 'tab-1', busy: true },
    }))
    expect(seen).toEqual([{ tabId: 'tab-1', busy: true }])
  })

})

describe('bridged subscriptions', () => {
  it('delivers the matching studio_event channel and ignores others', () => {
    const seen: unknown[] = []
    const off = host.shell.onModelTiersUpdated(() => seen.push('tiers'))
    ws.simulateMessage(JSON.stringify({ type: 'studio_event', channel: 'ion:default-provider-updated', payload: null }))
    expect(seen).toHaveLength(0)
    ws.simulateMessage(JSON.stringify({ type: 'studio_event', channel: 'ion:model-tiers-updated', payload: null }))
    expect(seen).toEqual(['tiers'])
    off()
    ws.simulateMessage(JSON.stringify({ type: 'studio_event', channel: 'ion:model-tiers-updated', payload: null }))
    expect(seen).toEqual(['tiers'])
  })
})

describe('the refusal proxy still refuses everything unbridged', () => {
  it('throws for a genuinely Electron-only verb', () => {
    expect(() => (host.shell as unknown as { showTray: () => void }).showTray()).toThrow('not available in a browser')
  })

  it('still refuses the three genuinely native filesystem verbs', () => {
    for (const verb of ['fsSaveDialog', 'fsRevealInFinder', 'fsOpenNative']) {
      expect(() => (host.shell as unknown as Record<string, () => void>)[verb]())
        .toThrow('not available in a browser')
    }
  })

  it('every subscribe entry names a channel and every invoke entry a namespaced action', () => {
    for (const [name, spec] of Object.entries(SHELL_INVOKE)) {
      expect(spec.action, name).toMatch(/^(auth|automation|backup|bash|chart|deeplink|engine|entra|fs|git|gitIdentity|graphView|mcp|model|oauth|planBashAllowlist|plugin|policy|presence|provider|questions|resource|lifecycle|remote|session|settings|studio|terminal|themes|transcribe|worktree)\./)
    }
    for (const [name, spec] of Object.entries(SHELL_SUBSCRIBE)) {
      expect(spec.channel, name).toMatch(/^(ion|studio):/)
    }
  })

  it('the Guided Questions feed hears every Environment', () => {
    // A question is parked on one conversation, and that conversation may
    // live on any connected Environment. The default `local` scope dropped
    // every remote snapshot, so a question asked on a visited server never
    // reached the operator. `all` also hands the listener the Environment id,
    // which is how `questions-store` keys the union and routes the answer
    // back to the server holding the question.
    expect(SHELL_SUBSCRIBE.onQuestionsState.scope).toBe('all')
  })

  it('only the fire-and-forget verbs are one-way', () => {
    // A verb whose ANSWER the caller needs must not be one-way: it would
    // resolve undefined and the caller would read a result that never came.
    // The one-way set mirrors the preload's `ipcRenderer.send` calls exactly:
    // a verb is one-way here if and only if the preload sends rather than
    // invokes. Anything else would drop a reply the caller is awaiting.
    const oneWay = Object.entries(SHELL_INVOKE).filter(([, s]) => s.oneWay).map(([name]) => name).sort()
    expect(oneWay).toEqual(['cancelBash', 'markResourceRead', 'notifyTabFocus', 'publishResourceDelete', 'remoteStopDiscovery', 'requestChartJump', 'resolveAutomationCommand', 'resolveDeepLinkConfirm', 'setDeepLinkConfirmAvailability', 'terminalResize', 'terminalWrite'])
  })
})

describe('a reported capability is only as true as the bridge', () => {
  /**
   * Genuinely Electron-only: native OS surfaces with no server-side meaning.
   * A browser client reports no capability that routes a caller here, and
   * these will never move to the bridge.
   */
  const ELECTRON_ONLY = new Set([
    'fsSaveDialog', 'fsRevealInFinder', 'fsOpenNative', 'fsOpenNativeData', 'fsSaveData', 'selectDirectory', 'selectExtensionFiles',
    'pickFile', 'pickDirectory', 'openExternal', 'getPathForFile', 'clipboardWriteImage',
    'showItemInFolder', 'listFonts', 'getFavicon', 'copyPngToClipboard',
    'takeScreenshot', 'attachFileByPath',
    // Reveals a path in the OS file manager, on the machine the UI runs on.
    'revealPath',
    // The engine event stream's DIRECT transport. A browser client is not
    // missing these -- `useEngineEvents` gates the whole block on the
    // `engineDirect` capability and takes its wire-frame path instead, which
    // carries the identical events as `studio_event` frames.
    'onTabStatusChange', 'onSkillStatus',
    // The embedded Studio Browser is an Electron WebContentsView composited
    // over the window. A browser tab cannot host one, and the surface
    // renders its own unavailable state rather than a broken frame.
    'studioBrowserViewEnsure', 'studioBrowserSetNetworkShield',
    'studioBrowserSetSessionMode', 'studioPreviewAllowNetwork',
    'studioSetTitleBarOverlay', 'onStudioWindowChrome', 'onWindowShown', 'onShowSettings',
    'onStudioBrowserCommand', 'onStudioBrowserOpenUrl', 'onStudioBrowserViewState',
    'studioBrowserPopoverRects', 'studioBrowserCommandResult', 'studioBrowserViewAction',
    'studioBrowserViewBounds', 'studioBrowserViewClose', 'studioBrowserViewNavigate',
    'studioBrowserFind', 'onStudioBrowserFindResult', 'studioBrowserSetZoom', 'onStudioBrowserShortcut',
    'onStudioBrowserPrompt', 'studioBrowserPromptAnswer',
    'studioExportImage', 'studioExportVideo',
    'onUpdateDownloaded', 'onUpdateProgress', 'onUpdateStaged', 'onUpdateError',
    // Device Metrics: this machine's own Electron processes. A browser tab
    // has none; the Environment page gates them on `nativeShell`.
    'deviceMetricsWatch', 'onDeviceMetrics',
    'installUpdate', 'restartForUpdate', 'startupReport',
    // The Build Notice describes this desktop's own installed build. A
    // browser tab has none; the dialog gates on the `updates` capability.
    'getBuildNotice', 'acknowledgeBuildNotice',
    // Opens a separate native Electron window; the verbs behind that window
    // are the `worktree.overlap.*` actions and are bridged.
    'openWorktreeOverlap', 'getWorktreeOverlapContext',
    'platform', 'on', 'off', 'logWrite', 'onError', 'onEvent',
  ])

  /**
   * Not bridged YET, and unreachable in a browser today because a capability
   * this client does not report gates every call site.
   *
   * This list is the remaining browser-parity debt, stated plainly rather
   * than hidden behind a `?.` or a gate nobody has inventoried. It exists to
   * SHRINK: bridging a domain moves its verbs into SHELL_INVOKE and deletes
   * them from here.
   *
   * Enabling a capability without emptying its rows first is precisely the
   * mistake this file now catches. The former `gitDirect` was reported while
   * `onWorktreeTitled` was still unbridged; it matched neither of the old
   * scan's `git*`/`onGit*` patterns, so nothing failed until it threw out of
   * a mount effect into the root error boundary on a live site.
   */

  it('bridges every host.shell verb the renderer calls, or classifies it', async () => {
    const { readFileSync, readdirSync, statSync } = await import('fs')
    const { join, dirname } = await import('path')
    const { fileURLToPath } = await import('url')
    const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

    const used = new Map<string, string>()
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!/\.tsx?$/.test(p) || /__tests__|\.test\./.test(p)) continue
        const src = readFileSync(p, 'utf-8')
        // `host.shell` and the verb are frequently on different lines --
        // `void host.shell\n  .mcpAdd(request)` is the shape the MCP settings
        // page used for every one of its four mutations. A `host\.shell\.` regex missed
        // all of them, so four unbridged verbs sat unclassified and this
        // scan reported clean.
        for (const m of src.matchAll(/host\.shell\s*\.\s*([A-Za-z]+)/g)) {
          // Skip prose in comments (`host.shell.git*` and friends).
          const lineStart = src.lastIndexOf('\n', m.index) + 1
          const line = src.slice(lineStart, src.indexOf('\n', m.index))
          if (/^\s*(\*|\/\/)/.test(line)) continue
          if (!used.has(m[1])) used.set(m[1], p)
        }
      }
    }
    walk(rendererRoot)

    const unclassified = [...used.entries()]
      .filter(([v]) => !(v in SHELL_INVOKE) && !(v in SHELL_SUBSCRIBE)
        && !ELECTRON_ONLY.has(v))
      .map(([v, file]) => `${v} (${file.slice(file.indexOf('src/'))})`)
      .sort()

    expect(used.size).toBeGreaterThan(50)
    expect(
      unclassified,
      `host.shell verb(s) neither bridged nor classified:\n  ${unclassified.join('\n  ')}`,
    ).toEqual([])
  })

  // useStudioLayout.ts, surface-hydration.ts and surface-persist.ts call
  // studioGetSettings/studioSetSetting unconditionally on every host (the
  // `persistedLayout` gate that once covered them is gone). Pinned directly:
  // if either row leaves the table, every browser reload resets the sidebar
  // and surface panel, which is the exact live defect of 2026-09-16.
  it('studioReadThemeAsset decodes the base64 reply back to the ArrayBuffer the loader expects', async () => {
    const pending = host.shell.studioReadThemeAsset('ion-works', 'a.png')
    const sent = JSON.parse(ws.sent.at(-1) as string) as { id: string; action: string; args: unknown[] }
    expect(sent.action).toBe('studio.readThemeAsset')
    expect(sent.args).toEqual(['ion-works', 'a.png'])
    ws.simulateMessage(JSON.stringify({ type: 'studio_action_result', id: sent.id, ok: true, value: 'iVBORw==' }))
    const bytes = new Uint8Array((await pending) as ArrayBuffer)
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('studioReadThemeAsset passes a null reply through', async () => {
    const pending = host.shell.studioReadThemeAsset('ion-works', 'missing.png')
    const sent = JSON.parse(ws.sent.at(-1) as string) as { id: string }
    ws.simulateMessage(JSON.stringify({ type: 'studio_action_result', id: sent.id, ok: true, value: null }))
    expect(await pending).toBeNull()
  })

  it('layout persistence: both verbs it depends on are bridged', () => {
    expect(SHELL_INVOKE).toHaveProperty('studioGetSettings')
    expect(SHELL_INVOKE).toHaveProperty('studioSetSetting')
  })
})

describe('the Provider Subscription verbs', () => {
  it('reach the person\'s own subscription, so a person without admin can choose and look up again', () => {
    expect(SHELL_INVOKE.providerSubscription.action).toBe('provider.subscription')
    expect(SHELL_INVOKE.selectProviderSubscription.action).toBe('provider.selectOwnSubscription')
    expect(SHELL_INVOKE.refreshProviderSubscription.action).toBe('provider.refreshOwnSubscription')
    expect(SHELL_INVOKE.selectProviderSubscription.pack([{ id: 'prem' }])).toEqual([{ id: 'prem' }])
  })
})

