/**
 * Tests for the deep-link dispatcher and the terminal action.
 *
 * The trust gate is the property that matters most here, and it is tested from
 * both directions: a trusted request must execute WITHOUT asking, and an
 * untrusted one must not touch anything until an approval comes back. A gate
 * that only worked in one direction would either break `dev run` or leave the
 * hole the gate exists to close.
 *
 * Target resolution is the other half. A terminal request must land on the tab
 * it names and be refused when it names none or names a dead one — never
 * retargeted to whatever is active.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createInstance: vi.fn(),
  terminalWrite: vi.fn(),
  runPrompt: vi.fn(),
  confirm: vi.fn(),
  ensureVisible: vi.fn(),
  isTrusted: vi.fn(),
  consumeHandoff: vi.fn(),
  logLines: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
}))

vi.mock('../../logger', () => ({
  log: (_t: string, msg: string, fields?: Record<string, unknown>) => {
    mocks.logLines.push({ msg, fields })
  },
  debug: vi.fn(),
  warn: (_t: string, msg: string, fields?: Record<string, unknown>) => {
    mocks.logLines.push({ msg, fields })
  },
  error: vi.fn(),
}))

vi.mock('../../remote/handlers/terminal', () => ({
  createTerminalInstanceOnTab: (...a: unknown[]) => mocks.createInstance(...a),
}))

vi.mock('../../terminal-manager-instance', () => ({
  terminalManager: { write: (...a: unknown[]) => mocks.terminalWrite(...a) },
}))

vi.mock('../action-prompt', () => ({
  runPromptAction: (...a: unknown[]) => mocks.runPrompt(...a),
}))

vi.mock('../confirm', () => ({
  requestDeepLinkConfirmation: (...a: unknown[]) => mocks.confirm(...a),
}))

vi.mock('../token', () => ({
  isTrustedToken: (...a: unknown[]) => mocks.isTrusted(...a),
}))

vi.mock('../handoff', () => ({
  consumeHandoff: (...a: unknown[]) => mocks.consumeHandoff(...a),
}))

import { handleDeepLink, markDeepLinksReady, resetDeepLinkStateForTests, configureDeepLinks } from '../dispatch'
import { runTerminalAction } from '../action-terminal'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.logLines.length = 0
  resetDeepLinkStateForTests()
  configureDeepLinks({ presentConfirmation: () => {
    mocks.ensureVisible()
    return 'overlay'
  } })
  markDeepLinksReady()
  // Default: a real pane is created.
  mocks.createInstance.mockResolvedValue({ id: 'inst-1', label: 'api', kind: 'user', cwd: '/repo' })
  mocks.runPrompt.mockResolvedValue({ ok: true })
  mocks.confirm.mockResolvedValue({ approved: true })
})

describe('runTerminalAction — target resolution', () => {
  it('creates the pane on the tab the request names', async () => {
    const r = await runTerminalAction({ action: 'terminal', tabId: 'tab-a', title: 'api', cmd: '', dir: '' })

    expect(r.ok).toBe(true)
    expect(mocks.createInstance).toHaveBeenCalledWith('tab-a', { label: 'api', cwd: undefined })
  })

  it('refuses when no tab is named, and explains why', async () => {
    const r = await runTerminalAction({ action: 'terminal', tabId: '', title: '', cmd: 'npm start', dir: '' })

    expect(r.ok).toBe(false)
    // The operator-facing message must say what to do, not just "failed".
    expect(r.error).toContain('No conversation was named')
    expect(mocks.createInstance).not.toHaveBeenCalled()
  })

  it('refuses when the named tab is gone, and never retargets', async () => {
    // A dead tab: createTerminalInstanceOnTab answers null.
    mocks.createInstance.mockResolvedValue(null)

    const r = await runTerminalAction({ action: 'terminal', tabId: 'tab-gone', title: '', cmd: '', dir: '' })

    expect(r.ok).toBe(false)
    expect(r.error).toContain('no longer open')
    // Exactly one attempt, against the named tab. No second attempt anywhere.
    expect(mocks.createInstance).toHaveBeenCalledTimes(1)
    expect(mocks.createInstance).toHaveBeenCalledWith('tab-gone', { label: undefined, cwd: undefined })
    expect(mocks.terminalWrite).not.toHaveBeenCalled()
  })

  it('writes the command into the new pane', async () => {
    await runTerminalAction({ action: 'terminal', tabId: 'tab-a', title: '', cmd: 'npm run dev', dir: '' })

    expect(mocks.terminalWrite).toHaveBeenCalledWith('tab-a:inst-1', 'npm run dev\n')
  })

  it('forwards a service directory before writing the command', async () => {
    // Regression for `dev run`: host-tier services commonly invoke commands
    // with project-relative files (`func start`, `dotnet watch --project
    // file.csproj`). Their deep link includes the resolved service directory,
    // and losing it makes both commands run at the conversation repo root.
    await runTerminalAction({
      action: 'terminal',
      tabId: 'tab-a',
      title: 'AD API',
      cmd: 'func start --port 7071',
      dir: '/repo/a/services/active-directory-api',
    })

    expect(mocks.createInstance).toHaveBeenCalledWith('tab-a', {
      label: 'AD API',
      cwd: '/repo/a/services/active-directory-api',
    })
    expect(mocks.terminalWrite).toHaveBeenCalledWith('tab-a:inst-1', 'func start --port 7071\n')
  })

  it('creates a pane with no command when none was given', async () => {
    const r = await runTerminalAction({ action: 'terminal', tabId: 'tab-a', title: '', cmd: '', dir: '' })

    expect(r.ok).toBe(true)
    expect(mocks.terminalWrite).not.toHaveBeenCalled()
  })

  it('passes no label through when the request has no title', async () => {
    // undefined, not '' — the store falls back to Shell N only on undefined.
    await runTerminalAction({ action: 'terminal', tabId: 'tab-a', title: '', cmd: '', dir: '' })

    expect(mocks.createInstance).toHaveBeenCalledWith('tab-a', { label: undefined, cwd: undefined })
  })
})

describe('handleDeepLink — trust gate', () => {
  it('executes a trusted request without asking', async () => {
    mocks.isTrusted.mockReturnValue(true)

    const r = await handleDeepLink('ion://terminal?tabId=tab-a&cmd=npm%20start&token=good')

    expect(r.ok).toBe(true)
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.createInstance).toHaveBeenCalledWith('tab-a', { label: undefined, cwd: undefined })
  })

  it('asks before running an untrusted request, and runs it on approval', async () => {
    mocks.isTrusted.mockReturnValue(false)
    mocks.confirm.mockResolvedValue({ approved: true })

    const r = await handleDeepLink('ion://terminal?tabId=tab-a&cmd=npm%20start')

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(true)
    expect(mocks.createInstance).toHaveBeenCalled()
  })

  it('does NOT act when an untrusted request is declined', async () => {
    mocks.isTrusted.mockReturnValue(false)
    mocks.confirm.mockResolvedValue({ approved: false })

    const r = await handleDeepLink('ion://terminal?tabId=tab-a&cmd=rm%20-rf%20%2F')

    expect(r.ok).toBe(false)
    expect(r.error).toBe('declined')
    // The whole point: nothing ran.
    expect(mocks.createInstance).not.toHaveBeenCalled()
    expect(mocks.terminalWrite).not.toHaveBeenCalled()
  })

  it('lets an untrusted no-tab terminal request use the chosen tab', async () => {
    mocks.isTrusted.mockReturnValue(false)
    mocks.confirm.mockResolvedValue({ approved: true, tabId: 'picked-tab' })

    await handleDeepLink('ion://terminal?cmd=npm%20start')

    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ action: 'terminal', tabId: '' }), 'overlay', true)
    expect(mocks.createInstance).toHaveBeenCalledWith('picked-tab', expect.anything())
  })

  it('refuses a trusted terminal request without a target', async () => {
    mocks.isTrusted.mockReturnValue(true)

    const result = await handleDeepLink('ion://terminal?cmd=npm%20start&token=good')

    expect(result.ok).toBe(false)
    expect(mocks.createInstance).not.toHaveBeenCalled()
  })

  it('surfaces the window before asking, so the dialog is not hidden', async () => {
    mocks.isTrusted.mockReturnValue(false)
    mocks.confirm.mockResolvedValue({ approved: false })

    await handleDeepLink('ion://prompt?dir=/repo&text=hi')

    expect(mocks.ensureVisible).toHaveBeenCalled()
  })

  it('gates the prompt action too, not just terminal', async () => {
    mocks.isTrusted.mockReturnValue(false)
    mocks.confirm.mockResolvedValue({ approved: false })

    await handleDeepLink('ion://prompt?dir=/repo&text=hello')

    expect(mocks.runPrompt).not.toHaveBeenCalled()
  })

  it('contains a terminal action exception as a refused outcome', async () => {
    mocks.isTrusted.mockReturnValue(true)
    mocks.createInstance.mockRejectedValue(new Error('renderer disconnected'))

    const result = await handleDeepLink('ion://terminal?tabId=tab-a&token=good')

    expect(result).toEqual({ ok: false, error: 'The terminal could not be created.' })
    expect(mocks.logLines.some((line) => line.msg === 'terminal action failed')).toBe(true)
  })

  it('contains an action exception that escapes its action boundary', async () => {
    mocks.isTrusted.mockReturnValue(true)
    mocks.runPrompt.mockRejectedValue(new Error('unexpected action failure'))

    const result = await handleDeepLink('ion://prompt?dir=/repo&text=hello&token=good')

    expect(result).toEqual({ ok: false, error: 'The deep link action could not be completed.' })
    expect(mocks.logLines.some((line) => line.msg === 'deep link action failed')).toBe(true)
  })

  it('routes an approved prompt request to the prompt action', async () => {
    mocks.isTrusted.mockReturnValue(true)

    await handleDeepLink('ion://prompt?dir=/repo&text=hello&token=good')

    expect(mocks.runPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prompt', dir: '/repo', text: 'hello' }),
    )
  })
})

describe('handleDeepLink — transports and refusals', () => {
  it('resolves a handoff request through the file, then acts', async () => {
    mocks.isTrusted.mockReturnValue(true)
    mocks.consumeHandoff.mockReturnValue({
      kind: 'ok',
      payload: { action: 'terminal', tabId: 'tab-h', title: 'web', cmd: 'yarn dev', dir: '' },
      token: 'good',
    })

    const r = await handleDeepLink('ion://terminal?req=123e4567-e89b-12d3-a456-426614174000')

    expect(mocks.consumeHandoff).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174000')
    expect(r.ok).toBe(true)
    expect(mocks.createInstance).toHaveBeenCalledWith('tab-h', { label: 'web', cwd: undefined })
  })

  it('refuses when the handoff file is unusable', async () => {
    mocks.consumeHandoff.mockReturnValue({ kind: 'error', reason: 'handoff file is stale (600s old)' })

    const r = await handleDeepLink('ion://terminal?req=123e4567-e89b-12d3-a456-426614174000')

    expect(r.ok).toBe(false)
    expect(r.error).toContain('stale')
    expect(mocks.createInstance).not.toHaveBeenCalled()
  })

  it('refuses a malformed url and logs the reason', async () => {
    const r = await handleDeepLink('ion://exfiltrate?x=1')

    expect(r.ok).toBe(false)
    expect(mocks.logLines.some((l) => l.msg.includes('rejected'))).toBe(true)
  })

  it('logs the outcome with action, transport, and trust tier', async () => {
    mocks.isTrusted.mockReturnValue(true)

    await handleDeepLink('ion://terminal?tabId=tab-a&token=good')

    const outcome = mocks.logLines.find((l) => l.msg === 'deep link outcome')
    expect(outcome?.fields).toMatchObject({
      action: 'terminal', transport: 'inline', trust: 'trusted', ok: true,
    })
  })
})

describe('handleDeepLink — cold start', () => {
  it('queues a request that arrives before the renderer is ready', async () => {
    resetDeepLinkStateForTests()
    mocks.isTrusted.mockReturnValue(true)

    // Not ready: this is a cold launch, the store does not exist yet.
    await handleDeepLink('ion://terminal?tabId=tab-a&token=good')
    expect(mocks.createInstance).not.toHaveBeenCalled()

    // Once the renderer is up, the queued request runs.
    markDeepLinksReady()
    await vi.waitFor(() => expect(mocks.createInstance).toHaveBeenCalledWith('tab-a', { label: undefined }))
  })

  it('flushes queued requests in arrival order', async () => {
    resetDeepLinkStateForTests()
    mocks.isTrusted.mockReturnValue(true)

    await handleDeepLink('ion://terminal?tabId=tab-1&token=good')
    await handleDeepLink('ion://terminal?tabId=tab-2&token=good')
    markDeepLinksReady()

    await vi.waitFor(() => expect(mocks.createInstance).toHaveBeenCalledTimes(2))
    expect(mocks.createInstance.mock.calls[0][0]).toBe('tab-1')
    expect(mocks.createInstance.mock.calls[1][0]).toBe('tab-2')
  })
})
