import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Confirms the TS SDK's init handshake reports the extension's own version,
// read from extension.json, the same way engine/internal/extension/host_lifecycle.go
// does at load time. Companion to the Go SDK's build-stamped Version var
// (sdk/go/build_identity.go) and the engine's applyHandshakeVersion
// (engine/internal/extension/host_transpile.go), which prefers this
// handshake value over its own manifest read.

const { lineHandlers } = vi.hoisted(() => ({
  lineHandlers: [] as Array<(line: string) => void>,
}))

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    on: (event: string, handler: (line: string) => void) => {
      if (event === 'line') lineHandlers.push(handler)
    },
  })),
}))

afterEach(() => {
  lineHandlers.length = 0
  vi.restoreAllMocks()
  vi.resetModules()
})

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function initAndCapture(extensionDir: string): Promise<Record<string, unknown>> {
  const writes: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write)

  const runtime = await import('../../../../engine/extensions/sdk/ion-sdk/runtime')
  runtime.createIon()
  await nextTurn()

  const line = lineHandlers.at(-1)
  expect(line).toBeDefined()
  line!(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'init',
    params: { extensionDir, model: '', workingDirectory: '' },
  }))
  await nextTurn()

  const response = writes.map((w) => JSON.parse(w)).find((frame) => frame.id === 1)
  expect(response).toBeDefined()
  return response.result
}

describe('TypeScript SDK init handshake version', () => {
  it('reports the version declared in extension.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-sdk-version-'))
    try {
      writeFileSync(join(dir, 'extension.json'), JSON.stringify({ name: 'demo', version: '3.4.5' }))
      const result = await initAndCapture(dir)
      expect(result.version).toBe('3.4.5')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports an empty version when extension.json declares none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-sdk-version-'))
    try {
      writeFileSync(join(dir, 'extension.json'), JSON.stringify({ name: 'demo' }))
      const result = await initAndCapture(dir)
      expect(result.version).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports an empty version when extension.json is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-sdk-version-'))
    try {
      const result = await initAndCapture(dir)
      expect(result.version).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
