/**
 * TransferPreflightPanel — the checklist `useTransferPreflight` produces,
 * one row per fact about the destination, each fixable row with its verbs
 * inline, and the destination's running clone or setup job under it.
 */
import React, { useState } from 'react'
import { CheckCircle, Warning, Info, XCircle } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import type { TransferPreflightState, TransferCheck } from './useTransferPreflight'
import { rWarn } from '../../rendererLogger'

function Row({ check }: { check: TransferCheck }): React.JSX.Element {
  const colors = useColors()
  const [busy, setBusy] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const icon = check.state === 'ok' ? <CheckCircle size={14} weight="fill" color={colors.successFg} />
    : check.state === 'blocked' ? <XCircle size={14} weight="fill" color={colors.statusError} />
    : check.state === 'fixable' ? <Warning size={14} weight="fill" color={colors.statusWarning} />
    : <Info size={14} weight="fill" color={colors.textTertiary} />
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0' }}>
      <span style={{ marginTop: 1 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: colors.textPrimary }}>{check.label}</div>
        {check.detail && <div style={{ fontSize: 11, color: colors.textTertiary, overflowWrap: 'anywhere' }}>{check.detail}</div>}
        {fixError && <div style={{ fontSize: 11, color: colors.dangerFg }}>{fixError}</div>}
      </div>
      {check.fixes?.map((fix) => (
        <button
          key={fix.label}
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setFixError(null)
            fix.run().catch((err: unknown) => {
              rWarn('transfer.preflight', 'fix failed', { check: check.id, fix: fix.label, error: String(err) })
              setFixError(err instanceof Error ? err.message : String(err))
            }).finally(() => setBusy(false))
          }}
          style={{ fontSize: 11, color: colors.textPrimary, background: 'transparent', border: `1px solid ${colors.containerBorder}`, borderRadius: 6, padding: '3px 8px', cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
        >
          {busy ? 'Working…' : fix.label}
        </button>
      ))}
    </div>
  )
}

export function TransferPreflightPanel({ state, targetLabel }: { state: TransferPreflightState; targetLabel: string }): React.JSX.Element {
  const colors = useColors()
  if (state.loading && !state.description) return <div style={{ fontSize: 12, color: colors.textTertiary, marginBottom: 12 }}>Checking {targetLabel}…</div>
  if (state.error) return <div style={{ fontSize: 12, color: colors.dangerFg, marginBottom: 12 }}>Could not check {targetLabel}: {state.error}</div>
  // The destination directory is its own field above this panel, which
  // shows the choice and says when it is missing. Its check still gates the
  // button; it just is not said twice.
  const rows = state.checks.filter((check) => check.id !== 'lands')
  if (rows.length === 0) return <div style={{ fontSize: 12, color: colors.textTertiary, marginBottom: 12 }}>Nothing to prepare on {targetLabel}.</div>
  return (
    <div aria-label="Transfer preflight" style={{ marginBottom: 12, borderTop: `1px solid ${colors.containerBorder}`, borderBottom: `1px solid ${colors.containerBorder}` }}>
      {rows.map((check) => <Row key={check.id} check={check} />)}
      {state.activeJob && (
        <div style={{ fontSize: 11, color: colors.textSecondary, padding: '4px 0 8px' }}>
          {state.activeJob.kind === 'clone' ? 'Cloning' : 'Setting up'} on {targetLabel}: {state.activeJob.stage}{state.activeJob.percent !== undefined ? ` ${state.activeJob.percent}%` : ''}
        </div>
      )}
    </div>
  )
}
