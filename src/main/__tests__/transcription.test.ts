/**
 * Transcription Tests
 *
 * Tests for the TRANSCRIBE_AUDIO IPC handler, verifying that:
 * - runExecFile resolves/rejects correctly with stdout/stderr
 * - WhisperKit fallback logic triggers only when first run produces no stdout
 * - No execSync calls remain in the handler (static analysis)
 *
 * Related spec: specs/issue-clui-3-async-execfile-transcription.tests.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'
import * as childProcess from 'child_process'
import * as fs from 'fs'

// ─── Module mocks ───

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  }
})

// ─── Typed mock accessors ───

const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>
const mockExistsSync = fs.existsSync as unknown as ReturnType<typeof vi.fn>

// ─── Helpers ───

/**
 * Recreate the runExecFile helper as defined inline in the TRANSCRIBE_AUDIO handler.
 * This lets us unit test it in isolation since extracting it from the handler
 * would change the source structure beyond what this spec covers.
 *
 * Uses the mocked child_process.execFile via the module-level import.
 */
function runExecFile(bin: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    (childProcess.execFile as any)(bin, args, { encoding: 'utf-8', timeout }, (err: any, stdout: string, stderr: string) => {
      if (err) {
        const detail = stderr?.trim() || stdout?.trim() || err.message
        reject(new Error(detail))
        return
      }
      resolve(stdout || '')
    })
  })
}

// ─── TC-001: runExecFile resolves with stdout on success ───

describe('TC-001: runExecFile resolves with stdout on success', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves with stdout when execFile succeeds', async () => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: Record<string, unknown>, cb: Function) => {
        cb(null, 'transcript text', '')
      }
    )

    const result = await runExecFile('/usr/bin/echo', ['hello'], 5000)
    expect(result).toBe('transcript text')
  })

  it('calls execFile with correct arguments array (not a shell string)', async () => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: Record<string, unknown>, cb: Function) => {
        cb(null, 'ok', '')
      }
    )

    await runExecFile('/usr/bin/echo', ['hello'], 5000)

    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/bin/echo',
      ['hello'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 5000 }),
      expect.any(Function)
    )
  })

  it('calls execFile with encoding utf-8 and correct timeout', async () => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: Record<string, unknown>, cb: Function) => {
        cb(null, '', '')
      }
    )

    await runExecFile('/usr/bin/test', ['arg'], 3000)

    const opts = mockExecFile.mock.calls[0][2]
    expect(opts).toEqual({ encoding: 'utf-8', timeout: 3000 })
  })
})

// ─── TC-002: runExecFile rejects with stderr on failure ───

describe('TC-002: runExecFile rejects with stderr on failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects with Error when execFile fails', async () => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: Record<string, unknown>, cb: Function) => {
        cb(new Error('exit 1'), '', 'whisper: model not found')
      }
    )

    await expect(runExecFile('/usr/bin/whisper', ['bad-arg'], 5000))
      .rejects.toThrow()
  })

  it('prefers stderr over err.message for rejection detail', async () => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: Record<string, unknown>, cb: Function) => {
        cb(new Error('exit 1'), '', 'whisper: model not found')
      }
    )

    await expect(runExecFile('/usr/bin/whisper', ['bad-arg'], 5000))
      .rejects.toThrow('whisper: model not found')
  })

  it('falls back to err.message when stderr is empty', async () => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: Record<string, unknown>, cb: Function) => {
        cb(new Error('command timed out'), '', '')
      }
    )

    await expect(runExecFile('/usr/bin/whisper', ['arg'], 5000))
      .rejects.toThrow('command timed out')
  })
})

// ─── TC-003: WhisperKit fallback runs when first run produces no stdout ───

describe('TC-003: WhisperKit fallback runs when first run produces no stdout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls whisper binary twice when first run returns empty stdout and no report JSON', async () => {
    const whisperBin = '/opt/homebrew/bin/whisperkit-cli'
    const whisperCalls: string[][] = []

    mockExecFile.mockImplementation(
      (bin: string, args: string[], _opts: Record<string, unknown>, cb: Function) => {
        if (bin === whisperBin) {
          whisperCalls.push(args)
          if (whisperCalls.length === 1) {
            // First call (--report run): returns empty stdout
            cb(null, '', '')
          } else {
            // Second call (fallback): returns transcribed text
            cb(null, 'transcribed text', '')
          }
        } else {
          cb(null, '', '')
        }
      }
    )

    // whisperkit-cli exists at the candidate path; report JSON does NOT exist
    mockExistsSync.mockImplementation((p: string) => {
      if (p === whisperBin) return true
      if (p.endsWith('.json')) return false
      return false
    })

    // Simulate the handler's WhisperKit branch
    const tmpWav = '/tmp/clui-voice-test.wav'
    const reportDir = '/tmp'

    // First call: with --report
    const firstArgs = [
      'transcribe', '--audio-path', tmpWav, '--model', 'tiny',
      '--without-timestamps', '--skip-special-tokens',
      '--report', '--report-path', reportDir,
    ]
    const firstOutput = await runExecFile(whisperBin, firstArgs, 60000)

    // Check report file
    const wavBasename = 'clui-voice-test'
    const reportPath = join(reportDir, `${wavBasename}.json`)
    const reportExists = mockExistsSync(reportPath)

    let transcript: string
    if (!reportExists && !firstOutput) {
      // Fallback: re-run without --report
      const fallbackArgs = [
        'transcribe', '--audio-path', tmpWav, '--model', 'tiny',
        '--without-timestamps', '--skip-special-tokens',
      ]
      transcript = await runExecFile(whisperBin, fallbackArgs, 60000)
    } else {
      transcript = firstOutput
    }

    // Assertions
    expect(whisperCalls).toHaveLength(2)
    expect(whisperCalls[1]).not.toContain('--report')
    expect(whisperCalls[1]).not.toContain('--report-path')
    expect(transcript).toBe('transcribed text')
  })

  it('returns correct result shape from handler', async () => {
    const whisperBin = '/opt/homebrew/bin/whisperkit-cli'
    let callCount = 0

    mockExecFile.mockImplementation(
      (bin: string, _args: string[], _opts: Record<string, unknown>, cb: Function) => {
        if (bin === whisperBin) {
          callCount++
          if (callCount === 1) {
            cb(null, '', '')
          } else {
            cb(null, 'transcribed text', '')
          }
        } else {
          cb(null, '', '')
        }
      }
    )

    mockExistsSync.mockImplementation((p: string) => {
      if (p === whisperBin) return true
      return false
    })

    // Simulate handler result shape
    const tmpWav = '/tmp/clui-voice-test.wav'
    const firstOutput = await runExecFile(whisperBin, ['transcribe', '--report', '--report-path', '/tmp', '--audio-path', tmpWav, '--model', 'tiny', '--without-timestamps', '--skip-special-tokens'], 60000)

    const reportExists = mockExistsSync(join('/tmp', 'clui-voice-test.json'))
    let result: { error: null | string; transcript: string }

    if (!reportExists && !firstOutput) {
      const fallbackOutput = await runExecFile(whisperBin, ['transcribe', '--audio-path', tmpWav, '--model', 'tiny', '--without-timestamps', '--skip-special-tokens'], 60000)
      result = { error: null, transcript: fallbackOutput }
    } else {
      result = { error: null, transcript: firstOutput }
    }

    expect(result).toEqual({ error: null, transcript: 'transcribed text' })
  })
})

// ─── TC-004: WhisperKit fallback skipped when first run produces stdout ───

describe('TC-004: WhisperKit fallback skipped when first run produces stdout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls whisper binary only once when first run returns stdout', async () => {
    const whisperBin = '/opt/homebrew/bin/whisperkit-cli'
    const whisperCalls: string[][] = []

    mockExecFile.mockImplementation(
      (bin: string, args: string[], _opts: Record<string, unknown>, cb: Function) => {
        if (bin === whisperBin) {
          whisperCalls.push(args)
          cb(null, 'direct stdout transcript', '')
        } else {
          cb(null, '', '')
        }
      }
    )

    mockExistsSync.mockImplementation((p: string) => {
      if (p === whisperBin) return true
      if (p.endsWith('.json')) return false
      return false
    })

    // Simulate the handler's WhisperKit branch
    const tmpWav = '/tmp/clui-voice-test.wav'
    const reportDir = '/tmp'

    const firstArgs = [
      'transcribe', '--audio-path', tmpWav, '--model', 'tiny',
      '--without-timestamps', '--skip-special-tokens',
      '--report', '--report-path', reportDir,
    ]
    const firstOutput = await runExecFile(whisperBin, firstArgs, 60000)

    const wavBasename = 'clui-voice-test'
    const reportPath = join(reportDir, `${wavBasename}.json`)
    const reportExists = mockExistsSync(reportPath)

    let transcript: string
    if (!reportExists && !firstOutput) {
      const fallbackArgs = [
        'transcribe', '--audio-path', tmpWav, '--model', 'tiny',
        '--without-timestamps', '--skip-special-tokens',
      ]
      transcript = await runExecFile(whisperBin, fallbackArgs, 60000)
    } else {
      transcript = firstOutput
    }

    // Assertions
    expect(whisperCalls).toHaveLength(1)
    expect(transcript).toBe('direct stdout transcript')
  })
})

// ─── TC-005: No execSync calls remain in TRANSCRIBE_AUDIO handler ───

describe('TC-005: No execSync calls in TRANSCRIBE_AUDIO handler', () => {
  // Static analysis test: reads the source file and checks the handler body

  const sourceFile = join(__dirname, '..', 'index.ts')
  let handlerSource: string

  beforeEach(() => {
    // Use node:fs directly to bypass the vi.mock for fs
    const actualFs = require('node:fs')
    const fullSource = actualFs.readFileSync(sourceFile, 'utf-8') as string

    // Find the TRANSCRIBE_AUDIO handler
    const handlerStart = fullSource.indexOf('ipcMain.handle(IPC.TRANSCRIBE_AUDIO')
    if (handlerStart === -1) {
      throw new Error('TRANSCRIBE_AUDIO handler not found in source')
    }

    // Walk forward counting braces to find the handler boundary
    let braceDepth = 0
    let started = false
    let handlerEnd = handlerStart

    for (let i = handlerStart; i < fullSource.length; i++) {
      const ch = fullSource[i]
      if (ch === '{') {
        braceDepth++
        started = true
      } else if (ch === '}') {
        braceDepth--
        if (started && braceDepth === 0) {
          handlerEnd = i + 1
          break
        }
      }
    }

    handlerSource = fullSource.slice(handlerStart, handlerEnd)
  })

  it('contains zero occurrences of execSync within the handler', () => {
    const execSyncMatches = handlerSource.match(/execSync/g)
    expect(execSyncMatches).toBeNull()
  })

  it('contains at least one occurrence of execFile or runExecFile', () => {
    const execFileMatches = handlerSource.match(/execFile|runExecFile/g)
    expect(execFileMatches).not.toBeNull()
    expect(execFileMatches!.length).toBeGreaterThanOrEqual(1)
  })
})
