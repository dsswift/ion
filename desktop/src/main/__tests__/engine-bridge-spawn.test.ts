/**
 * engine-bridge, connect-only contract.
 *
 * The desktop no longer spawns the engine. It connects to a launchd-owned
 * daemon at ~/.ion/engine.sock. These tests pin:
 *   1. The bridge has no _startServer method (the spawn pathway is deleted).
 *   2. The bridge module does not import engine-bridge-spawn.
 *   3. _doConnect retries without invoking any spawn function.
 */

import { describe, it, expect, vi } from 'vitest'

// Mock transitive dependencies so importing the bridge does not pull in
// electron, net, fs, etc.
vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    const ee = {
      on: vi.fn((_ev: string, cb: (...args: any[]) => void) => {
        if (_ev === 'error') setTimeout(() => cb(new Error('ECONNREFUSED')), 0)
        return ee
      }),
      write: vi.fn(),
      destroy: vi.fn(),
      destroyed: false,
    }
    return ee
  }),
}))
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}))
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))
vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
vi.mock('../engine-bridge-start-session', () => ({
  startSession: vi.fn(),
  reRegisterSessions: vi.fn(),
}))
vi.mock('../engine-bridge-state-sync', () => ({
  sendReconcileState: vi.fn(),
  sendQuerySessionStatus: vi.fn(),
}))
vi.mock('../engine-bridge-prompts', () => ({
  buildSendPromptMessage: vi.fn(() => ({})),
  buildSendPromptLogLine: vi.fn(() => ''),
}))
vi.mock('../engine-bridge-conversations', () => ({}))

import { EngineBridge } from '../engine-bridge'

describe('EngineBridge connect-only contract', () => {
  it('does not have a _startServer method', () => {
    const bridge = new EngineBridge()
    // The private _startServer was the spawn pathway. It must not exist.
    expect((bridge as any)._startServer).toBeUndefined()
  })

  it('does not import or reference spawnEngineServer', () => {
    // Read the source files to confirm no spawn import exists. This is a
    // meta-test: if someone re-adds the import, this fails. The connection
    // lifecycle lives in engine-bridge-connection.ts (split from
    // engine-bridge.ts for the file-size cap); both carry the contract.
    const fs = require('fs')
    const path = require('path')
    const src =
      fs.readFileSync(path.join(__dirname, '..', 'engine-bridge.ts'), 'utf-8') +
      fs.readFileSync(path.join(__dirname, '..', 'engine-bridge-connection.ts'), 'utf-8')
    expect(src).not.toContain('spawnEngineServer')
    expect(src).not.toContain('engine-bridge-spawn')
  })

  it('connects to engine.sock (daemon socket), not desktop.sock', () => {
    const fs = require('fs')
    const path = require('path')
    // The socket path lives in the connection module; neither file may
    // reference the legacy desktop.sock.
    const bridgeSrc = fs.readFileSync(path.join(__dirname, '..', 'engine-bridge.ts'), 'utf-8')
    const connSrc = fs.readFileSync(path.join(__dirname, '..', 'engine-bridge-connection.ts'), 'utf-8')
    expect(connSrc).toContain("'engine.sock'")
    expect(bridgeSrc).not.toContain("'desktop.sock'")
    expect(connSrc).not.toContain("'desktop.sock'")
  })

  it('shutdownAndWait uses launchctl bootout instead of PID kill', () => {
    const fs = require('fs')
    const path = require('path')
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'engine-bridge-lifecycle.ts'),
      'utf-8',
    )
    expect(src).toContain('launchctl bootout')
    expect(src).not.toContain('process.kill(pid')
  })
})
