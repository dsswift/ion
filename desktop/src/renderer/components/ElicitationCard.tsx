import React from 'react'
import { motion } from 'framer-motion'
import { Question, CheckCircle, XCircle } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import type { ElicitationRequest } from '../../shared/types'

interface Props {
  tabId: string
  elicitation: ElicitationRequest
  queueLength?: number
}

// A schema entry whose key reads like a freeform label we should show as the
// card's title line rather than a key:value row.
const TITLE_KEYS = ['action', 'title', 'summary']

/**
 * Render the elicitation schema as a compact key:value preview. The schema is
 * harness-defined (opaque), so we render it generically: scalar values inline,
 * objects/arrays JSON-stringified and truncated. This mirrors PermissionCard's
 * formatInput so an extension author gets a predictable rendering without the
 * client needing to understand the schema.
 */
function formatSchema(schema?: Record<string, unknown>): { title: string | null; rows: string | null } {
  if (!schema) return { title: null, rows: null }
  const entries = Object.entries(schema)
  if (entries.length === 0) return { title: null, rows: null }

  let title: string | null = null
  const parts: string[] = []
  for (const [key, value] of entries) {
    const val = typeof value === 'string' ? value : JSON.stringify(value)
    if (title === null && TITLE_KEYS.includes(key.toLowerCase()) && typeof value === 'string') {
      title = val
      continue
    }
    const truncated = val.length > 120 ? val.substring(0, 117) + '...' : val
    parts.push(`${key}: ${truncated}`)
  }
  return { title, rows: parts.length > 0 ? parts.join('\n') : null }
}

/**
 * Generic approval card for an extension `ctx.elicit()` request. The engine
 * fans `engine_elicitation_request` to every client and blocks until one
 * answers; this card lets the user approve (response `{}`, cancelled false) or
 * cancel (cancelled true), sending an `elicitation_response` command back.
 *
 * `mode` selects intent — `"approval"` is the only mode rendered today
 * (Approve / Cancel). Unknown modes fall back to the same Approve / Cancel
 * pair so an extension is never wedged on a mode the client doesn't special-
 * case; the engine owns the elicit transport, the client owns the rendering.
 */
export function ElicitationCard({ tabId, elicitation, queueLength = 1 }: Props) {
  const respondElicitation = useSessionStore((s) => s.respondElicitation)
  const colors = useColors()
  const [responded, setResponded] = React.useState(false)

  // Reset the responded guard when the displayed request changes (queue advancing).
  React.useEffect(() => {
    setResponded(false)
  }, [elicitation.requestId])

  const respond = (kind: 'accept' | 'decline' | 'cancel') => {
    if (responded) return // Prevent double-send
    setResponded(true)
    respondElicitation(
      tabId,
      elicitation.requestId,
      kind === 'accept' ? {} : undefined,
      kind === 'cancel',
      kind === 'decline',
    )
  }

  const { title, rows } = formatSchema(elicitation.schema)
  const heading = elicitation.mode === 'approval' ? 'Approval Requested' : 'Input Requested'

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.97 }}
      transition={{ duration: 0.2 }}
      className="mx-4 mt-2 mb-2"
    >
      <div
        style={{
          background: colors.containerBg,
          border: `1px solid ${colors.permissionBorder}`,
          borderRadius: 12,
          boxShadow: colors.permissionShadow,
        }}
        className="overflow-hidden"
      >
        {/* Header */}
        <div
          className="flex items-center gap-1.5 px-3 py-1.5"
          style={{
            background: colors.permissionHeaderBg,
            borderBottom: `1px solid ${colors.permissionHeaderBorder}`,
          }}
        >
          <Question size={12} style={{ color: colors.statusPermission }} />
          <span className="text-[11px] font-semibold" style={{ color: colors.statusPermission }}>
            {heading}
          </span>
        </div>

        <div className="px-3 py-2.5">
          {title && (
            <div className="text-[12px] font-medium mb-1.5" style={{ color: colors.textPrimary }}>
              {title}
            </div>
          )}

          {rows && (
            <pre
              className="text-[10px] leading-[1.4] px-2 py-1.5 rounded-md overflow-x-auto whitespace-pre-wrap break-all mb-2"
              style={{
                background: colors.codeBg,
                color: colors.textSecondary,
                maxHeight: 80,
              }}
            >
              {rows}
            </pre>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => respond('accept')}
              disabled={responded}
              className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
              style={{
                background: colors.permissionAllowBg,
                color: colors.statusComplete,
                border: `1px solid ${colors.permissionAllowBorder}`,
              }}
              onMouseEnter={(e) => {
                if (!responded) e.currentTarget.style.background = colors.permissionAllowHoverBg
              }}
              onMouseLeave={(e) => {
                if (!responded) e.currentTarget.style.background = colors.permissionAllowBg
              }}
            >
              <CheckCircle size={13} /> Approve
            </button>

            <button
              onClick={() => respond('decline')}
              disabled={responded}
              className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
              style={{
                background: colors.containerBg,
                color: colors.textSecondary,
                border: `1px solid ${colors.permissionDenyBorder}`,
              }}
            >
              <XCircle size={13} /> Decline
            </button>

            <button
              onClick={() => respond('cancel')}
              disabled={responded}
              className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
              style={{
                background: colors.permissionDenyBg,
                color: colors.statusError,
                border: `1px solid ${colors.permissionDenyBorder}`,
              }}
              onMouseEnter={(e) => {
                if (!responded) e.currentTarget.style.background = colors.permissionDenyHoverBg
              }}
              onMouseLeave={(e) => {
                if (!responded) e.currentTarget.style.background = colors.permissionDenyBg
              }}
            >
              <XCircle size={13} /> Cancel
            </button>

            {queueLength > 1 && (
              <span
                className="text-[10px] px-2 py-0.5 rounded-full"
                style={{
                  background: colors.accentLight,
                  color: colors.accent,
                }}
              >
                +{queueLength - 1} more
              </span>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
}
