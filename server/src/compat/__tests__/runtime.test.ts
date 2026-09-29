/** The live version report: engine half from `health` and `list_sessions`, server formats first, the engine minimum judged, and an unreachable engine reported as null rather than guessed. */
import { describe, expect, it } from 'vitest'
import { buildVersionReport, hostApp, readEngineRuntime, setCompatContext, type EngineRequester } from '../runtime'

const engineFormat = { id: 'conversation-file', owner: 'engine' as const, version: '2', rule: 'host-storage' as const, meaning: 'm' }

function engine(answers: Record<string, { ok: boolean; data?: unknown; error?: string }>): EngineRequester {
  return {
    request: async <T,>(cmd: string) => (answers[cmd] ?? { ok: false, error: 'unknown' }) as { ok: boolean; error?: string; data?: T },
  }
}

describe('compat runtime', () => {
  it('reads the engine version, formats, and the count of sessions with an active run', async () => {
    const rt = await readEngineRuntime(engine({
      health: { ok: true, data: { version: '1.2.3', compat: [engineFormat] } },
      list_sessions: { ok: true, data: [{ hasActiveRun: true }, { hasActiveRun: false }] },
    }))
    expect(rt).toEqual({ version: '1.2.3', formats: [engineFormat], runningConversations: 1 })
  })

  it('reports an unreachable engine as null, never zero', async () => {
    const rejecting: EngineRequester = { request: async () => { throw new Error('socket closed') } }
    expect(await readEngineRuntime(rejecting)).toEqual({ version: null, formats: [], runningConversations: null })
  })

  it('builds /versionz with server formats first and judges the engine minimum', async () => {
    setCompatContext({ serverVersion: '0.9.0', engineMinVersion: '1.5.0' })
    const report = await buildVersionReport(engine({
      health: { ok: true, data: { version: 'desktop-v1.4.9-3-gabc', compat: [engineFormat] } },
      list_sessions: { ok: true, data: [] },
    }), { ION_HOST_APP_VERSION: '1.101.0' })
    expect(report.serverVersion).toBe('0.9.0')
    expect(report.engineVersion).toBe('desktop-v1.4.9-3-gabc')
    expect(report.engineMinVersion).toBe('1.5.0')
    expect(report.engineMeetsMin).toBe(false)
    expect(report.hostApp).toEqual({ name: 'desktop', version: '1.101.0' })
    expect(report.formats[0].owner).toBe('server')
    expect(report.formats.at(-1)).toEqual(engineFormat)
  })

  it('has no host app when the server runs standalone', () => {
    expect(hostApp({})).toBeNull()
    expect(hostApp({ ION_HOST_APP_VERSION: '  ' })).toBeNull()
  })
})
