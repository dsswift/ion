/**
 * BrowserFindBar — find in page for one browser document.
 *
 * A DOM row in the chrome, above the body hole, so the hole shrinks and the
 * main-process view follows; nothing here has to be layered over the page.
 * The search itself runs in the guest: every keystroke goes to main, and the
 * ordinal and count come back from Chromium's `found-in-page`.
 */
import React, { useEffect, useRef, useState } from 'react'
import { CaretDown, CaretUp, X } from '@phosphor-icons/react'
import { Tooltip } from '../../../components/git/Tooltip'
import { useColors } from '../../../theme'
import { rWarn } from '../../../rendererLogger'
import { host } from '../../../host/host-instance'

export interface FindMatches {
  activeMatchOrdinal: number
  matches: number
}

export function BrowserFindBar({
  conversationId,
  instanceId,
  matches,
  /** Bumped by the Mod+F shortcut while the bar is already open, to refocus it. */
  focusNonce,
  onClose,
}: {
  conversationId: string
  instanceId: string
  matches: FindMatches | null
  focusNonce: number
  onClose(): void
}): React.JSX.Element {
  const colors = useColors()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusNonce])

  const find = (text: string, forward: boolean, findNext: boolean): void => {
    const request = text ? { text, forward, findNext } : { stop: true as const }
    void host.shell.studioBrowserFind(conversationId, instanceId, request)
      .catch((err) => rWarn('studio.browser', 'find request failed', { instance_id: instanceId, error: String(err) }))
  }

  // Closing ends the search in the guest, which clears the highlight and
  // hands focus back to the page.
  useEffect(() => () => {
    void host.shell.studioBrowserFind(conversationId, instanceId, { stop: true })
      .catch((err) => rWarn('studio.browser', 'find stop failed', { instance_id: instanceId, error: String(err) }))
  }, [conversationId, instanceId])

  const count = query ? (matches ? `${matches.activeMatchOrdinal}/${matches.matches}` : '…') : ''
  const iconButton: React.CSSProperties = { border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 2 }

  return (
    <div
      role="search"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        fontSize: 11,
        fontFamily: 'system-ui, sans-serif',
        color: colors.textSecondary,
        background: colors.surfacePrimary,
        borderBottom: `1px solid ${colors.containerBorder}`,
        flexShrink: 0,
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          find(e.target.value, true, false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') find(query, !e.shiftKey, true)
          if (e.key === 'Escape') onClose()
        }}
        placeholder="Find in page"
        aria-label="Find in page"
        spellCheck={false}
        style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '2px 8px', borderRadius: 6, border: `1px solid ${colors.containerBorder}`, background: colors.inputPillBg, color: colors.textPrimary, outline: 'none' }}
      />
      <span aria-label="Find matches" style={{ minWidth: 40, textAlign: 'right', color: matches && query && matches.matches === 0 ? colors.warningFg : colors.textTertiary }}>{count}</span>
      <Tooltip text="Previous match"><button style={iconButton} onClick={() => find(query, false, true)} aria-label="Previous match" disabled={!query}><CaretUp size={12} /></button></Tooltip>
      <Tooltip text="Next match"><button style={iconButton} onClick={() => find(query, true, true)} aria-label="Next match" disabled={!query}><CaretDown size={12} /></button></Tooltip>
      <Tooltip text="Close find"><button style={iconButton} onClick={onClose} aria-label="Close find"><X size={12} /></button></Tooltip>
    </div>
  )
}
