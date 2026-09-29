// @vitest-environment jsdom
/**
 * The Electron host routes each bridged shell call to the Environment its
 * arguments name (ADR-033 union store), resolves only that server's reply,
 * and scopes bridged subscriptions: `tab` channels from every Environment,
 * `active` channels from the active conversation's Environment, `local`
 * channels from the local server only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn() }))

import { useSessionStore } from '@ion/server/store/sessionStore'
import { ElectronStudioHost } from '../ElectronStudioHost'

function preloadStub(): { sent: Array<{ environmentId: string; frame: StudioFrame }>; deliver: (environmentId: string, frame: StudioFrame) => void } {
  const sent: Array<{ environmentId: string; frame: StudioFrame }> = []
  const listeners = new Set<(environmentId: string, frame: StudioFrame) => void>()
  const deliver = (environmentId: string, frame: StudioFrame): void => { for (const l of [...listeners]) l(environmentId, frame) }
  ;(window as unknown as { ion: unknown }).ion = {
    hostSendFrame(environmentId: string, frame: StudioFrame) {
      sent.push({ environmentId, frame })
      if (frame.type !== 'studio_action') return
      deliver('other', { type: 'studio_action_result', id: frame.id, ok: true, value: 'from-other' })
      deliver(environmentId, { type: 'studio_action_result', id: frame.id, ok: true, value: `from-${environmentId}` })
    },
    onHostFrame(cb: (environmentId: string, frame: StudioFrame) => void) { listeners.add(cb); return () => listeners.delete(cb) },
  }
  return { sent, deliver }
}

beforeEach(() => {
  useSessionStore.setState({
    tabs: [{ id: 'l1', workingDirectory: '/l' }, { id: 'g1', workingDirectory: '/g', environmentId: 'grover' }] as never,
    activeTabId: 'l1',
  } as never)
})
afterEach(() => { delete (window as unknown as { ion?: unknown }).ion })

describe('ElectronStudioHost routing', () => {
  it('sends a terminal keystroke to the server that owns the terminal\'s tab', async () => {
    const { sent } = preloadStub()
    const host = new ElectronStudioHost()
    host.shell.terminalWrite('g1:shell', 'ls\n')
    expect(sent[0]).toMatchObject({ environmentId: 'grover', frame: { action: 'terminal.write' } })
  })

  it('sends a path-based call to the active conversation\'s server and resolves only its reply', async () => {
    const { sent } = preloadStub()
    const host = new ElectronStudioHost()
    expect(await host.shell.gitIsRepo('/g')).toBe('from-local')
    useSessionStore.setState({ activeTabId: 'g1' } as never)
    expect(await host.shell.gitIsRepo('/g')).toBe('from-grover')
    expect(sent.map((s) => s.environmentId)).toEqual([LOCAL_ENVIRONMENT_ID, 'grover'])
  })

  it('keeps per-device calls on the local server whatever tab is active', async () => {
    const { sent } = preloadStub()
    const host = new ElectronStudioHost()
    useSessionStore.setState({ activeTabId: 'g1' } as never)
    expect(await host.shell.listModels()).toBe('from-local')
    expect(sent[0]?.environmentId).toBe(LOCAL_ENVIRONMENT_ID)
  })

  it('scopes subscriptions: tab channels from every environment, active channels follow the active tab, local channels stay local', () => {
    const { deliver } = preloadStub()
    const host = new ElectronStudioHost()
    const terminal: unknown[] = []
    const git: unknown[] = []
    const models: unknown[] = []
    host.shell.onTerminalData((key: string) => terminal.push(key))
    host.shell.onGitEvent((payload: unknown) => git.push(payload))
    host.shell.onOpenAuthUrl((payload: { url: string }) => models.push(payload))
    deliver(LOCAL_ENVIRONMENT_ID, { type: 'studio_event', channel: 'ion:terminal-incoming', payload: ['l1:sh', 'a'] })
    deliver('grover', { type: 'studio_event', channel: 'ion:terminal-incoming', payload: ['g1:sh', 'b'] })
    deliver(LOCAL_ENVIRONMENT_ID, { type: 'studio_event', channel: 'ion:git-event', payload: 'git-local' })
    deliver('grover', { type: 'studio_event', channel: 'ion:git-event', payload: 'git-grover-1' })
    useSessionStore.setState({ activeTabId: 'g1' } as never)
    deliver('grover', { type: 'studio_event', channel: 'ion:git-event', payload: 'git-grover-2' })
    deliver(LOCAL_ENVIRONMENT_ID, { type: 'studio_event', channel: 'ion:open-auth-url', payload: { url: 'm-local' } })
    deliver('grover', { type: 'studio_event', channel: 'ion:open-auth-url', payload: { url: 'm-grover' } })
    expect(terminal).toEqual(['l1:sh', 'g1:sh'])
    expect(git).toEqual(['git-local', 'git-grover-2'])
    expect(models).toEqual([{ url: 'm-local' }])
  })
})
