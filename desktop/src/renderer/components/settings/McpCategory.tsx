/**
 * McpCategory.tsx — MCP server administration in desktop Settings.
 *
 * A thin consumer of the engine's mcp_* commands: the engine owns config CRUD,
 * OAuth discovery, dynamic client registration, the PKCE exchange, and token
 * storage. This surface adds only what a GUI is good at — showing the current
 * state of every server and driving the browser handoff.
 *
 * View-readiness note: the list is fetched on mount and re-fetched after every
 * mutation, and rows render complete from the first frame. There is no partial
 * state where a count or badge fills in later.
 *
 * Convergence note: the panel also subscribes to the engine_mcp_servers
 * broadcast, which the engine emits on every MCP state transition — including
 * transitions this window did not cause (an `ion mcp login` completed in a
 * terminal, an add from another client). The event is a complete snapshot;
 * the handler REPLACES local state with it, never merges. The mount-time
 * fetch still runs because the broadcast only covers transitions after mount.
 */

import React, { useCallback, useEffect, useState } from 'react'
import { useColors } from '../../theme'
import { SettingSection } from './SettingSection'
import { SettingHeading } from './SettingHeading'
import { McpServerRow } from './McpServerRow'
import { McpAddServerForm } from './McpAddServerForm'
import { rError, rInfo } from '../../rendererLogger'
import type { McpServerStatus } from '../../../shared/types-engine-event'

export function McpCategory() {
  const colors = useColors()
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  /** Server name currently mid-operation, or '' for a global (add) operation. */
  const [busyName, setBusyName] = useState<string | null>(null)
  const [authorizingName, setAuthorizingName] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const result = await window.ion.mcpList()
    if (!result.ok) {
      setErrorMsg(result.error ?? 'Could not load MCP servers')
      return
    }
    setServers(result.servers ?? [])
    setErrorMsg(null)
  }, [])

  useEffect(() => {
    void refresh()
      .catch((err) => {
        rError('settings', 'mcp list failed', { error: String(err) })
        setErrorMsg('Could not load MCP servers')
      })
      .finally(() => setLoading(false))
  }, [refresh])

  // Converge on state transitions this window did not cause. The engine
  // broadcasts engine_mcp_servers on every add/remove/login/logout, from ANY
  // client — an `ion mcp login` completed in a terminal must flip an open
  // Settings panel to "authorized" without a remount. The payload is a
  // complete snapshot: REPLACE local state, never merge. A received snapshot
  // also supersedes any stale local error, since it is fresh authoritative
  // truth about exactly the state the error described.
  useEffect(() => {
    return window.ion.onEngineEvent((_key, event) => {
      if (event.type !== 'engine_mcp_servers') return
      rInfo('settings', 'mcp servers snapshot received', { count: event.mcpServers?.length ?? 0 })
      setServers(event.mcpServers ?? [])
      setErrorMsg(null)
      setLoading(false)
    })
  }, [])

  const handleAdd = useCallback(
    (request: { name: string; url?: string; command?: string; args?: string[] }) => {
      setBusyName('')
      setErrorMsg(null)
      void window.ion
        .mcpAdd(request)
        .then(async (result) => {
          if (!result.ok) {
            setErrorMsg(result.error ?? `Could not add "${request.name}"`)
            return
          }
          rInfo('settings', 'mcp server added', { name: request.name })
          await refresh()
        })
        .catch((err) => {
          rError('settings', 'mcp add failed', { name: request.name, error: String(err) })
          setErrorMsg(`Could not add "${request.name}"`)
        })
        .finally(() => setBusyName(null))
    },
    [refresh],
  )

  const handleAuthorize = useCallback(
    (name: string) => {
      setBusyName(name)
      setAuthorizingName(name)
      setErrorMsg(null)
      // Resolves only after the operator finishes in the browser (or the engine's
      // flow times out), so the pending state is held for the whole round trip.
      void window.ion
        .mcpLogin(name)
        .then(async (result) => {
          if (!result.ok) {
            setErrorMsg(result.error ?? `Authorization for "${name}" did not complete`)
            return
          }
          rInfo('settings', 'mcp server authorized', { name })
          await refresh()
        })
        .catch((err) => {
          rError('settings', 'mcp login failed', { name, error: String(err) })
          setErrorMsg(`Authorization for "${name}" did not complete`)
        })
        .finally(() => {
          setBusyName(null)
          setAuthorizingName(null)
        })
    },
    [refresh],
  )

  const handleSignOut = useCallback(
    (name: string) => {
      setBusyName(name)
      void window.ion
        .mcpLogout(name)
        .then(async (result) => {
          if (!result.ok) {
            setErrorMsg(result.error ?? `Could not sign out of "${name}"`)
            return
          }
          await refresh()
        })
        .catch((err) => {
          rError('settings', 'mcp logout failed', { name, error: String(err) })
          setErrorMsg(`Could not sign out of "${name}"`)
        })
        .finally(() => setBusyName(null))
    },
    [refresh],
  )

  const handleRemove = useCallback(
    (name: string) => {
      setBusyName(name)
      void window.ion
        .mcpRemove(name)
        .then(async (result) => {
          if (!result.ok) {
            setErrorMsg(result.error ?? `Could not remove "${name}"`)
            return
          }
          rInfo('settings', 'mcp server removed', { name })
          await refresh()
        })
        .catch((err) => {
          rError('settings', 'mcp remove failed', { name, error: String(err) })
          setErrorMsg(`Could not remove "${name}"`)
        })
        .finally(() => setBusyName(null))
    },
    [refresh],
  )

  return (
    <>
      <SettingHeading first>MCP Servers</SettingHeading>

      <SettingSection
        label="Configured servers"
        description={
          'Model Context Protocol servers extend conversations with external tools and resources. ' +
          'A server that requires authorization is signed in through your browser; the engine holds the ' +
          'token and refreshes it silently.'
        }
      >
        {loading ? (
          <p style={{ color: colors.textTertiary, fontSize: 13, margin: 0 }}>Loading…</p>
        ) : servers.length === 0 ? (
          <p style={{ color: colors.textTertiary, fontSize: 13, margin: 0 }}>
            No MCP servers configured yet.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {servers.map((server) => (
              <McpServerRow
                key={server.name}
                server={server}
                busy={busyName === server.name}
                onAuthorize={() => handleAuthorize(server.name)}
                onSignOut={() => handleSignOut(server.name)}
                onRemove={() => handleRemove(server.name)}
              />
            ))}
          </div>
        )}

        {authorizingName && (
          <p style={{ color: colors.textTertiary, fontSize: 12, margin: '8px 0 0' }}>
            A browser window has opened — complete sign-in for {authorizingName} there…
          </p>
        )}

        {errorMsg && (
          <p style={{ color: colors.statusError, fontSize: 12, margin: '8px 0 0' }}>{errorMsg}</p>
        )}
      </SettingSection>

      <SettingSection
        label="Add a server"
        description="Servers are written to ~/.ion/engine.json and connect on the next conversation you start."
      >
        <McpAddServerForm busy={busyName === ''} onAdd={handleAdd} />
      </SettingSection>
    </>
  )
}
