/**
 * engine-bridge-spawn — engine child process environment tests
 *
 * A GUI-launched macOS app inherits the launchd-truncated PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin). Before this fix, spawnEngineServer
 * passed the raw process.env to the engine child, so the engine — and
 * every agent Bash tool / MCP server / extension subprocess it spawns —
 * could not see Homebrew/nvm/asdf binaries or anything on the user's
 * real PATH.
 *
 * spawnEngineServer now spawns the engine with getCliEnv(), which
 * resolves the full login-shell PATH (already used by the desktop's own
 * terminal and ipc/bash) and overlays the engine's ION_SOCKET_PATH /
 * ION_PID_PATH vars.
 *
 * These tests pin:
 *   - The spawned child's env.PATH equals the resolved login-shell PATH
 *     (NOT the truncated process.env.PATH). This goes red on the
 *     pre-fix code, which passed process.env verbatim.
 *   - The engine's socket/pid env vars are still overlaid onto the env.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const RESOLVED_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ pid: 4242 })),
  execSync: vi.fn(() => ''),
}))
// Make the first binary candidate "exist" so spawn is reached.
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}))
vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
// getCliEnv resolves the login-shell PATH; mock it to a deterministic value
// and assert spawnEngineServer threads its output (plus the overlaid extras)
// into the child env.
vi.mock('../cli-env', () => ({
  getCliEnv: vi.fn((extra?: Record<string, string>) => ({
    ...process.env,
    PATH: RESOLVED_PATH,
    ...extra,
  })),
}))

import { spawn } from 'child_process'
import { spawnEngineServer } from '../engine-bridge-spawn'
import { getCliEnv } from '../cli-env'

describe('spawnEngineServer environment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('spawns the engine with the resolved login-shell PATH, not process.env', () => {
    spawnEngineServer('/tmp/sock', '/tmp/pid')

    expect(spawn).toHaveBeenCalledTimes(1)
    const spawnArgs = vi.mocked(spawn).mock.calls[0]
    const opts = spawnArgs[2] as { env?: Record<string, string> }
    expect(opts.env?.PATH).toBe(RESOLVED_PATH)
  })

  it('overlays the engine socket/pid vars onto the resolved env', () => {
    spawnEngineServer('/tmp/my.sock', '/tmp/my.pid')

    const opts = vi.mocked(spawn).mock.calls[0][2] as {
      env?: Record<string, string>
    }
    expect(opts.env?.ION_SOCKET_PATH).toBe('/tmp/my.sock')
    expect(opts.env?.ION_PID_PATH).toBe('/tmp/my.pid')
  })

  it('passes the socket/pid vars to getCliEnv as the overlay', () => {
    spawnEngineServer('/tmp/s.sock', '/tmp/p.pid')

    expect(getCliEnv).toHaveBeenCalledWith({
      ION_SOCKET_PATH: '/tmp/s.sock',
      ION_PID_PATH: '/tmp/p.pid',
    })
  })
})
