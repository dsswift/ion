/**
 * McpServerRow.tsx — one configured MCP server in the settings list.
 *
 * Connection and authorization are rendered as SEPARATE indicators, because
 * they are independent engine states and the interesting case is the
 * combination: a server that is authenticated but not connected has a stored
 * token the server is refusing, and collapsing the two into one "ok" badge would
 * hide exactly the state the operator has to act on. `lastError` is shown
 * verbatim for the same reason — it is often the only explanation available
 * without reading the engine host's log file.
 */

import React from 'react'
import { Plugs, Warning } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import type { McpServerStatus } from '../../../shared/types-engine-event'

interface McpServerRowProps {
  server: McpServerStatus
  busy: boolean
  onAuthorize: () => void
  onSignOut: () => void
  onRemove: () => void
}

export function McpServerRow({ server, busy, onAuthorize, onSignOut, onRemove }: McpServerRowProps) {
  const colors = useColors()

  const endpoint = server.url || server.command || ''

  const buttonBase: React.CSSProperties = {
    padding: '5px 12px',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500,
    cursor: busy ? 'default' : 'pointer',
    border: 'none',
    outline: 'none',
    opacity: busy ? 0.6 : 1,
  }

  const pill = (label: string, tone: 'ok' | 'idle' | 'warn'): React.ReactElement => {
    const toneColor =
      tone === 'ok' ? colors.statusComplete : tone === 'warn' ? colors.statusWarning : colors.textTertiary
    return (
      <span
        style={{
          fontSize: 11,
          color: toneColor,
          border: `1px solid ${toneColor}`,
          borderRadius: 4,
          padding: '1px 6px',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    )
  }

  return (
    <div
      style={{
        background: colors.surfacePrimary,
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 8,
        padding: '10px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Plugs size={15} color={colors.textSecondary} />
        <span style={{ fontSize: 13, fontWeight: 500, color: colors.textPrimary }}>{server.name}</span>
        {server.transport && (
          <span style={{ fontSize: 11, color: colors.textTertiary }}>{server.transport}</span>
        )}
        <div style={{ flex: 1 }} />
        {pill(server.connected ? 'connected' : 'not connected', server.connected ? 'ok' : 'idle')}
        {pill(server.authenticated ? 'authorized' : 'not authorized', server.authenticated ? 'ok' : 'idle')}
        {server.connected && (server.toolCount ?? 0) > 0 && (
          <span style={{ fontSize: 11, color: colors.textTertiary }}>
            {server.toolCount} {server.toolCount === 1 ? 'tool' : 'tools'}
          </span>
        )}
      </div>

      {endpoint && (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: colors.textTertiary,
            wordBreak: 'break-all',
            fontFamily: 'ui-monospace, monospace',
          }}
        >
          {endpoint}
        </p>
      )}

      {server.lastError && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <Warning size={13} color={colors.statusWarning} style={{ flexShrink: 0, marginTop: 2 }} />
          <p style={{ margin: 0, fontSize: 12, color: colors.statusWarning, wordBreak: 'break-word' }}>
            {server.lastError}
          </p>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          disabled={busy}
          onClick={onAuthorize}
          style={{ ...buttonBase, background: colors.accent, color: colors.textOnAccent }}
        >
          {server.authenticated ? 'Re-authorize' : 'Authorize'}
        </button>
        {server.authenticated && (
          <button
            disabled={busy}
            onClick={onSignOut}
            style={{
              ...buttonBase,
              background: colors.surfaceSecondary,
              color: colors.textSecondary,
              border: `1px solid ${colors.containerBorder}`,
            }}
          >
            Sign out
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button
          disabled={busy}
          onClick={onRemove}
          style={{
            ...buttonBase,
            background: 'transparent',
            color: colors.statusError,
            border: `1px solid ${colors.containerBorder}`,
          }}
        >
          Remove
        </button>
      </div>
    </div>
  )
}
