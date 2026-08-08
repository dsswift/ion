import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../worktree/provision-manifest', () => ({ readBenchVerify: vi.fn() }))
vi.mock('../worktree/provision-run', () => ({ runProvisionCommand: vi.fn() }))

import { readBenchVerify } from '../worktree/provision-manifest'
import { runProvisionCommand } from '../worktree/provision-run'
import { runBenchVerify } from '../integration/bench-verify'

const mockedRead = vi.mocked(readBenchVerify)
const mockedRun = vi.mocked(runProvisionCommand)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runBenchVerify', () => {
  it('skips successfully when project declares no command', async () => {
    mockedRead.mockReturnValue(undefined)

    await expect(runBenchVerify('/repo', '/bench')).resolves.toEqual({
      ran: false,
      ok: true,
      output: '',
      command: '',
    })
    expect(mockedRun).not.toHaveBeenCalled()
  })

  it('runs declared command in bench with declared timeout', async () => {
    mockedRead.mockReturnValue({ verify: 'npm test', verifyTimeoutMs: 4567 })
    mockedRun.mockResolvedValue({ ok: false, exitCode: 1, output: 'failed', error: 'exited 1' })

    await expect(runBenchVerify('/repo', '/bench')).resolves.toEqual({
      ran: true,
      ok: false,
      output: 'failed',
      command: 'npm test',
    })
    expect(mockedRun).toHaveBeenCalledWith('npm test', '/bench', 4567)
  })

  /**
   * The assembled bench tree is the authority on what the enrolled combination
   * declares. A member that INTRODUCES the bench block is exactly the case that
   * must be honoured: reading only the source branch means the block is invisible
   * until it lands, so verification is skipped for every assembly that contains
   * it -- which is how a poisoned rerere replay reached a build once already.
   */
  it('prefers the assembled bench manifest over the source repo', async () => {
    mockedRead.mockImplementation((path: string) => (
      path === '/bench' ? { verify: 'make verify', verifyTimeoutMs: undefined } : undefined
    ))
    mockedRun.mockResolvedValue({ ok: true, exitCode: 0, output: 'ok' })

    await expect(runBenchVerify('/repo', '/bench')).resolves.toEqual({
      ran: true,
      ok: true,
      output: 'ok',
      command: 'make verify',
    })
    expect(mockedRun).toHaveBeenCalledWith('make verify', '/bench', undefined)
  })

  /**
   * The source repo remains the fallback, so a project that declares the block
   * on its branch keeps working when the bench tree has no manifest of its own.
   */
  it('falls back to the source repo when the bench declares nothing', async () => {
    mockedRead.mockImplementation((path: string) => (
      path === '/repo' ? { verify: 'make verify', verifyTimeoutMs: undefined } : undefined
    ))
    mockedRun.mockResolvedValue({ ok: true, exitCode: 0, output: 'ok' })

    await expect(runBenchVerify('/repo', '/bench')).resolves.toMatchObject({ ran: true, ok: true })
    expect(mockedRun).toHaveBeenCalledWith('make verify', '/bench', undefined)
  })
})
