/** Every git subprocess is one `git.exec` client span, start to exit, named by its subcommand. */
import { describe, expect, it, vi } from 'vitest'

const logger = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(), info: vi.fn() }))
vi.mock('../../logger', () => logger)
vi.mock('../../cli-env', () => ({ getCliPath: () => process.env.PATH ?? '' }))

import { gitExec } from '../git-exec'
import { spansNamed } from '../../tracing/__tests__/span-capture'

describe('git.exec', () => {
  it('spans a subprocess with its subcommand and working directory', async () => {
    const { stdout } = await gitExec('git', ['--no-pager', 'version'], { cwd: process.cwd() })
    expect(stdout).toMatch(/^git version/)
    const span = spansNamed(logger, 'git.exec')[0]
    expect(span.level).toBe('INFO')
    expect(span.fields).toMatchObject({ span_kind: 'client', git_command: 'version', cwd: process.cwd() })
    expect(typeof span.fields.duration_ms).toBe('number')
  })

  it('fails the span when git exits non-zero', async () => {
    await expect(gitExec('git', ['definitely-not-a-command'])).rejects.toThrow()
    const failed = spansNamed(logger, 'git.exec').find((s) => s.fields.git_command === 'definitely-not-a-command')!
    expect(failed.level).toBe('WARN')
    expect(typeof failed.fields.error).toBe('string')
  })
})
