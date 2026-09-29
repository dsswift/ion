import { describe, it, expect } from 'vitest'
import { commandShell } from '../terminal-shell'

const noAccount = (): { shell?: string | null } => ({ shell: null })

describe('commandShell', () => {
  it('runs the command through the pane shell with -lc off windows', () => {
    const run = commandShell('echo hi', 'darwin', {}, () => ({ shell: '/bin/bash' }))
    expect(run).toEqual({ shell: '/bin/bash', args: ['-lc', 'echo hi'], family: 'bash' })
  })

  it('hands powershell the command line on windows', () => {
    const env = { PATH: process.cwd(), COMSPEC: 'C:\\Windows\\System32\\cmd.exe' }
    const run = commandShell('echo hi', 'win32', env, noAccount)
    // No pwsh/powershell on this PATH: cmd is the runner, with its own flags.
    expect(run.family).toBe('cmd')
    expect(run.args).toEqual(['/d', '/s', '/c', 'echo hi'])
    expect(run.shell).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})
