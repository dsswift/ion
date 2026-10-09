/**
 * HubAddServer — what a person carries to a server to put it on this hub:
 * the hub's web address and an enrollment token made for the occasion, each
 * with its own copy button. The two are pasted into the server's Fleet hubs
 * panel, often on another device.
 */
import React, { useState } from 'react'
import { Check, Copy } from '@phosphor-icons/react'
import type { HubEnrollmentToken } from '@ion/shared/fleet-hub'
import { useColors } from '../theme'
import { Button, KIT } from '../components/settings/kit'
import { rWarn } from '../rendererLogger'

type Copied = 'address' | 'token' | null

export interface HubAddServerProps {
  /** The address this page was opened at, which is the one a server dials. */
  hubUrl: string
  issued: HubEnrollmentToken
  onClose(): void
}

export function HubAddServer({ hubUrl, issued, onClose }: HubAddServerProps): React.JSX.Element {
  const colors = useColors()
  const [copied, setCopied] = useState<Copied>(null)
  const copy = (what: Exclude<Copied, null>, text: string): void => {
    navigator.clipboard.writeText(text)
      .then(() => setCopied(what))
      .catch((err: unknown) => rWarn('hub.add-server', 'copy failed', { what, error: String(err) }))
  }
  const until = new Date(issued.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const value = (what: Exclude<Copied, null>, label: string, text: string): React.JSX.Element => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: KIT.fontTiny, color: colors.textTertiary }}>{label}</div>
        <div data-add-server={what} style={{ fontFamily: KIT.mono, fontSize: KIT.fontSmall, color: colors.textPrimary, wordBreak: 'break-all', userSelect: 'all' }}>{text}</div>
      </div>
      <Button icon={copied === what ? Check : Copy} aria-label={`Copy the ${label.toLowerCase()}`} onClick={() => copy(what, text)}>{copied === what ? 'Copied' : 'Copy'}</Button>
    </div>
  )
  return (
    <section aria-label="Add a server" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: KIT.groupRadius, border: `1px solid ${colors.containerBorder}`, background: colors.surfacePrimary }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, fontSize: KIT.font, fontWeight: 600 }}>Add a server</div>
        <Button onClick={onClose}>Done</Button>
      </div>
      {value('address', 'Hub address', hubUrl)}
      {value('token', 'Enrollment token', issued.token)}
      <div style={{ fontSize: KIT.fontSmall, color: colors.textTertiary, lineHeight: 1.45 }}>
        On the server, open Fleet hubs and paste both. The token lets one server join and stops working at {until}.
      </div>
    </section>
  )
}
