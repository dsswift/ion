/**
 * PairingLinkPanel — mints a pairing link as it opens and shows it once. A
 * second desktop pastes it into Add Environment. The link is a bearer
 * secret. Without admin, the link pairs one of the person's own devices
 * (`pairing-access.ts`).
 */
import React, { useEffect, useState } from 'react'
import { Copy } from '@phosphor-icons/react'
import { useSettingsEnvironment } from '../../settings-servers'
import { Button, ErrorText, Muted, SidePanel, Stack, TextArea } from '../../kit'
import { copyText, formatFromNow } from './access-parts'
import type { PairingAccess } from './pairing-access'
import { rInfo, rWarn } from '../../../../rendererLogger'

export function PairingLinkPanel({ access, onClose }: { access: PairingAccess; onClose(): void }): React.JSX.Element {
  const env = useSettingsEnvironment()
  const [minted, setMinted] = useState<{ url: string; expiresAt: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mint = (): void => {
    setBusy(true); setError(null)
    access.mint(env.id, 'another device').then((link) => { setMinted({ url: link.url, expiresAt: link.expiresAt }); rInfo('devices-section', 'pairing link minted', { environment_id: env.id, access: access.kind }) }).catch((err: unknown) => {
      rWarn('devices-section', 'mint failed', { environment_id: env.id, access: access.kind, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => setBusy(false))
  }
  // Mint once per opening; the panel mounts when it opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(mint, [])
  return (
    <SidePanel
      open
      title="Pairing link"
      subtitle={access.kind === 'own' ? `Lets another of your devices pair with ${env.label} as you.` : `Lets another desktop pair with ${env.label}.`}
      onClose={onClose}
      footer={<>
        <Button disabled={busy} onClick={mint}>Mint another</Button>
        <Button variant="primary" icon={Copy} disabled={!minted} onClick={() => { if (minted) copyText('devices-section', minted.url) }}>Copy</Button>
      </>}
    >
      <Stack>
        {busy && !minted && <Muted>Minting…</Muted>}
        <ErrorText>{error}</ErrorText>
        {minted && <>
          <Muted>Paste this into Add Environment → Pairing link on the other device. Treat it as a password; it expires {formatFromNow(minted.expiresAt)}.</Muted>
          <TextArea mono readOnly rows={4} value={minted.url} aria-label="Pairing link" />
        </>}
      </Stack>
    </SidePanel>
  )
}
