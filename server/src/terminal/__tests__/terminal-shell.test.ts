import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, delimiter } from 'path'
import { resolveShell } from '../terminal-shell'

function withTempExe(name: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-shell-test-'))
  try {
    writeFileSync(join(dir, name), '')
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('resolveShell', () => {
  it('win32: picks pwsh.exe when present on PATH', () => {
    withTempExe('pwsh.exe', (dir) => {
      const r = resolveShell('win32', { PATH: dir }, () => ({}))
      expect(r.family).toBe('pwsh')
      expect(r.shell).toBe(join(dir, 'pwsh.exe'))
      expect(r.args).toEqual(['-NoLogo'])
      expect(r.reason).toBe('pwsh-on-path')
    })
  })

  it('win32: falls back to powershell.exe when pwsh is absent', () => {
    withTempExe('powershell.exe', (dir) => {
      const r = resolveShell('win32', { PATH: dir }, () => ({}))
      expect(r.family).toBe('powershell')
      expect(r.shell).toBe(join(dir, 'powershell.exe'))
      expect(r.reason).toBe('powershell-on-path')
    })
  })

  it('win32: falls back to COMSPEC when neither PowerShell variant is on PATH', () => {
    const r = resolveShell('win32', { PATH: '', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' }, () => ({}))
    expect(r.family).toBe('cmd')
    expect(r.shell).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(r.args).toEqual([])
    expect(r.reason).toBe('comspec')
  })

  it('win32: falls back to a hardcoded cmd.exe path with no PATH and no COMSPEC', () => {
    const r = resolveShell('win32', { PATH: '' }, () => ({}))
    expect(r.family).toBe('cmd')
    expect(r.shell).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(r.reason).toBe('cmd-fallback')
  })

  it('darwin: uses the account shell with login-interactive args', () => {
    const r = resolveShell('darwin', {}, () => ({ shell: '/bin/zsh' }))
    expect(r.shell).toBe('/bin/zsh')
    expect(r.family).toBe('zsh')
    expect(r.args).toEqual(['-il'])
    expect(r.reason).toBe('account-shell')
  })

  it('linux: an unrecognized account shell is family "other"', () => {
    const r = resolveShell('linux', {}, () => ({ shell: '/usr/bin/fish' }))
    expect(r.family).toBe('other')
    expect(r.shell).toBe('/usr/bin/fish')
  })

  it('darwin: falls back to /bin/zsh when the account has no shell', () => {
    const r = resolveShell('darwin', {}, () => ({}))
    expect(r.shell).toBe('/bin/zsh')
    expect(r.family).toBe('zsh')
    expect(r.reason).toBe('default-zsh')
  })

  it('PATH entries are split on the platform delimiter', () => {
    withTempExe('pwsh.exe', (dir) => {
      const pathVal = ['/does/not/exist', dir].join(delimiter)
      const r = resolveShell('win32', { PATH: pathVal }, () => ({}))
      expect(r.shell).toBe(join(dir, 'pwsh.exe'))
    })
  })
})
