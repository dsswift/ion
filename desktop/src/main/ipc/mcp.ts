/**
 * ipc/mcp.ts — IPC surface for MCP server administration.
 *
 * Every handler validates its renderer input before forwarding, then returns a
 * discriminated result rather than throwing across the bridge: an Electron IPC
 * rejection reaches the renderer as an opaque "Error invoking remote method",
 * which would strip the engine's specific refusal (enterprise policy, a bad
 * transport combination, a provider's OAuth error) — exactly the text the
 * operator needs.
 */

import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log, warn as _warn } from '../logger'
import { addServer, listServers, loginServer, logoutServer, removeServer, type McpServerRow } from '../mcp-admin'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('mcp_ipc', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('mcp_ipc', msg, fields)
}

/**
 * A server name must be a non-empty single-line string without the MCP
 * tool-name separator. The engine validates this too — this is the near-side
 * guard so a malformed name never reaches the wire.
 */
function isValidServerName(name: unknown): name is string {
  if (typeof name !== 'string') return false
  if (name.trim() === '' || name !== name.trim()) return false
  if (/[\s\0]/.test(name)) return false
  if (name.includes('__')) return false
  return true
}

/** Validate an optional string map (headers, env). */
function isValidStringMap(value: unknown): value is Record<string, string> | undefined {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.entries(value).every(([k, v]) => typeof k === 'string' && k !== '' && typeof v === 'string')
}

function isValidStringArray(value: unknown): value is string[] | undefined {
  if (value === undefined) return true
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerMcpIpc(): void {
  ipcMain.handle(IPC.MCP_LIST, async (): Promise<{ ok: boolean; servers?: McpServerRow[]; error?: string }> => {
    try {
      const servers = await listServers()
      return { ok: true, servers }
    } catch (err) {
      warn('mcp_list failed', { error: errorMessage(err) })
      return { ok: false, error: errorMessage(err) }
    }
  })

  ipcMain.handle(
    IPC.MCP_ADD,
    async (
      _event,
      payload: unknown,
    ): Promise<{ ok: boolean; error?: string }> => {
      if (typeof payload !== 'object' || payload === null) {
        return { ok: false, error: 'mcp_add requires a payload object' }
      }
      const { name, transport, url, command, args, headers, env } = payload as Record<string, unknown>

      if (!isValidServerName(name)) {
        log('mcp_add: rejecting invalid server name')
        return { ok: false, error: 'Server name must be non-empty, contain no whitespace, and not include "__"' }
      }
      if (transport !== undefined && typeof transport !== 'string') {
        return { ok: false, error: 'transport must be a string' }
      }
      if (url !== undefined && typeof url !== 'string') {
        return { ok: false, error: 'url must be a string' }
      }
      if (command !== undefined && typeof command !== 'string') {
        return { ok: false, error: 'command must be a string' }
      }
      if (!isValidStringArray(args)) {
        return { ok: false, error: 'args must be an array of strings' }
      }
      if (!isValidStringMap(headers)) {
        return { ok: false, error: 'headers must be a map of string to string' }
      }
      if (!isValidStringMap(env)) {
        return { ok: false, error: 'env must be a map of string to string' }
      }

      try {
        await addServer({
          name,
          transport: transport as string | undefined,
          url: url as string | undefined,
          command: command as string | undefined,
          args: args as string[] | undefined,
          headers: headers as Record<string, string> | undefined,
          env: env as Record<string, string> | undefined,
        })
        return { ok: true }
      } catch (err) {
        warn('mcp_add failed', { name, error: errorMessage(err) })
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(IPC.MCP_REMOVE, async (_event, name: unknown): Promise<{ ok: boolean; error?: string }> => {
    if (!isValidServerName(name)) {
      return { ok: false, error: 'Invalid server name' }
    }
    try {
      await removeServer(name)
      return { ok: true }
    } catch (err) {
      warn('mcp_remove failed', { name, error: errorMessage(err) })
      return { ok: false, error: errorMessage(err) }
    }
  })

  ipcMain.handle(
    IPC.MCP_LOGIN,
    async (_event, payload: unknown): Promise<{ ok: boolean; authorizationUrl?: string; error?: string }> => {
      const { name, scope } =
        typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : { name: payload, scope: undefined }

      if (!isValidServerName(name)) {
        return { ok: false, error: 'Invalid server name' }
      }
      if (scope !== undefined && typeof scope !== 'string') {
        return { ok: false, error: 'scope must be a string' }
      }
      try {
        const { authorizationUrl } = await loginServer(name, scope as string | undefined)
        return { ok: true, authorizationUrl }
      } catch (err) {
        warn('mcp_login failed', { name, error: errorMessage(err) })
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(IPC.MCP_LOGOUT, async (_event, name: unknown): Promise<{ ok: boolean; error?: string }> => {
    if (!isValidServerName(name)) {
      return { ok: false, error: 'Invalid server name' }
    }
    try {
      await logoutServer(name)
      return { ok: true }
    } catch (err) {
      warn('mcp_logout failed', { name, error: errorMessage(err) })
      return { ok: false, error: errorMessage(err) }
    }
  })

  log('registered MCP administration IPC handlers')
}
