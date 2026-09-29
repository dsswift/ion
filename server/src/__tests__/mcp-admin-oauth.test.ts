/**
 * mcp-admin forwards the OAuth client on add and the patch on update to the
 * engine's mcp_add / mcp_update wire fields, and reads the update outcome back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('../state', () => ({ engineBridge: { request } }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { addServer, updateServer } from '../mcp-admin'

beforeEach(() => {
  request.mockReset()
})

describe('mcp-admin OAuth client', () => {
  it('sends the OAuth client on add as mcpOAuth', async () => {
    request.mockResolvedValue({ ok: true })
    await addServer({ name: 'exchange', url: 'https://api.example.test/mcp', oauth: { clientId: 'client-1' } })
    expect(request).toHaveBeenCalledWith('mcp_add', { mcpName: 'exchange', mcpUrl: 'https://api.example.test/mcp', mcpOAuth: { clientId: 'client-1' } })
  })

  it('sends only the named fields on update and returns the outcome', async () => {
    request.mockResolvedValue({ ok: true, data: { changed: true, credentialsCleared: true } })
    const outcome = await updateServer({ name: 'exchange', oauth: { clientId: 'client-2', clientSecret: '' } })
    expect(request).toHaveBeenCalledWith('mcp_update', { mcpName: 'exchange', mcpOAuth: { clientId: 'client-2', clientSecret: '' } })
    expect(outcome).toEqual({ changed: true, credentialsCleared: true })
  })

  it('sends an explicit empty args list so the engine clears the arguments', async () => {
    request.mockResolvedValue({ ok: true, data: { changed: true, credentialsCleared: false } })
    await updateServer({ name: 'local', args: [] })
    expect(request).toHaveBeenCalledWith('mcp_update', { mcpName: 'local', mcpArgs: [] })
  })

  it('throws the engine refusal', async () => {
    request.mockResolvedValue({ ok: false, error: 'MCP server "ghost" is not configured' })
    await expect(updateServer({ name: 'ghost', url: 'https://a.example.test/mcp' })).rejects.toThrow('not configured')
  })
})
