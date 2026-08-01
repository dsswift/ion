/**
 * McpAddServerForm.tsx — the "add a server" half of the MCP settings category.
 *
 * Deliberately minimal: name plus endpoint, with transport inferred by the
 * engine (a URL means http, a command means stdio). Headers and environment
 * variables are intentionally NOT exposed here — a server that needs OAuth is
 * handled by the Authorize button, and a pre-shared-token server is the rarer
 * case that `ion mcp add --header` covers. Adding fields nobody uses to the
 * common path would make the common path worse.
 */

import React, { useState } from 'react'
import { useColors } from '../../theme'

type ServerKind = 'remote' | 'local'

interface McpAddServerFormProps {
  busy: boolean
  onAdd: (request: { name: string; url?: string; command?: string; args?: string[] }) => void
}

export function McpAddServerForm({ busy, onAdd }: McpAddServerFormProps) {
  const colors = useColors()
  const [kind, setKind] = useState<ServerKind>('remote')
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)

  const inputStyle: React.CSSProperties = {
    background: colors.surfacePrimary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 13,
    color: colors.textPrimary,
    outline: 'none',
    width: '100%',
  }

  const submit = (): void => {
    const trimmedName = name.trim()
    const trimmedEndpoint = endpoint.trim()

    // Mirrors the engine's own name rule so the operator is corrected here
    // rather than by a round trip: "__" is the MCP tool-name separator, so a
    // name containing it produces tool names the model cannot call back.
    if (trimmedName === '') {
      setValidationError('Enter a name for the server.')
      return
    }
    if (/\s/.test(trimmedName)) {
      setValidationError('The name cannot contain spaces.')
      return
    }
    if (trimmedName.includes('__')) {
      setValidationError('The name cannot contain "__" (it separates server and tool names).')
      return
    }
    if (trimmedEndpoint === '') {
      setValidationError(kind === 'remote' ? 'Enter the server URL.' : 'Enter the command to run.')
      return
    }
    if (kind === 'remote' && !/^https?:\/\//i.test(trimmedEndpoint)) {
      setValidationError('The URL must start with http:// or https://')
      return
    }

    setValidationError(null)
    if (kind === 'remote') {
      onAdd({ name: trimmedName, url: trimmedEndpoint })
    } else {
      // A local server is usually pasted as a full command line, so split it
      // into the executable plus its arguments.
      const parts = trimmedEndpoint.split(/\s+/)
      onAdd({ name: trimmedName, command: parts[0], args: parts.slice(1) })
    }
    setName('')
    setEndpoint('')
  }

  const kindButton = (value: ServerKind, label: string): React.ReactElement => (
    <button
      onClick={() => { setKind(value); setValidationError(null) }}
      style={{
        padding: '4px 10px',
        borderRadius: 6,
        fontSize: 12,
        cursor: 'pointer',
        outline: 'none',
        background: kind === value ? colors.accent : 'transparent',
        color: kind === value ? colors.textOnAccent : colors.textSecondary,
        border: `1px solid ${kind === value ? colors.accent : colors.containerBorder}`,
      }}
    >
      {label}
    </button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        {kindButton('remote', 'Remote (URL)')}
        {kindButton('local', 'Local (command)')}
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (e.g. mobbin)"
        spellCheck={false}
        style={inputStyle}
      />
      <input
        value={endpoint}
        onChange={(e) => setEndpoint(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        placeholder={kind === 'remote' ? 'https://api.example.com/mcp' : 'npx -y @scope/mcp-server'}
        spellCheck={false}
        style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
      />

      {validationError && (
        <p style={{ margin: 0, fontSize: 12, color: colors.statusError }}>{validationError}</p>
      )}

      <div>
        <button
          disabled={busy}
          onClick={submit}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 500,
            cursor: busy ? 'default' : 'pointer',
            border: 'none',
            outline: 'none',
            opacity: busy ? 0.6 : 1,
            background: colors.accent,
            color: colors.textOnAccent,
          }}
        >
          Add server
        </button>
      </div>
    </div>
  )
}
