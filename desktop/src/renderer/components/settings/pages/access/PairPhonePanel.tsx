/**
 * PairPhonePanel — the side panel that pairs a phone with this server.
 *
 * It offers the same pairing two ways at once, because a phone can take
 * either: a QR code of a pairing link (scan it), and the eight-character
 * code (type it after finding the server nearby). Both end in the same
 * exchange and the same kind of pairing a desktop gets.
 *
 * Without admin on the server (`pairing-access.ts`), it pairs one of the
 * person's own devices: the link comes from the non-admin action and there
 * is no code to type, because only an admin may open discovery.
 *
 * The panel lives as long as the pairing link does. It closes itself when a
 * new device appears in the server's pairings, or when the link expires. If
 * it had to make the server discoverable to show a code, it turns that off
 * again on the way out, however it goes.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CLIENTS_CHANGED_CHANNEL, DISCOVERY_CHANNEL } from '@ion/shared/types-environment-admin'
import { environmentClient, onEnvironmentEvent } from '../../environment/environment-client'
import { qrSvgDataUrl } from '../../environment/pairing-qr'
import { Button, ErrorText, Muted, SidePanel, Stack } from '../../kit'
import { CodeText, remaining } from './access-parts'
import type { PairingAccess } from './pairing-access'
import { rInfo, rWarn } from '../../../../rendererLogger'

/** How long the server stays discoverable when the panel has to open that window itself. */
const DISCOVERY_MINUTES = 15

export type PairPhoneOutcome = 'paired' | 'expired' | 'cancelled'

interface Offer {
  url: string
  expiresAt: number
  /** The eight-character code, or null when the server would not give one (sealed discovery, or a refusal). */
  code: string | null
}

/** The live eight-character code, making the server discoverable first when that is what it takes. Null when discovery is sealed. */
async function obtainCode(environmentId: string, openedWindow: { current: boolean }): Promise<string | null> {
  const status = await environmentClient.discoveryStatus(environmentId)
  if (status.mode === 'sealed') {
    rInfo('pair-phone', 'discovery is sealed; offering the QR code alone', { environment_id: environmentId })
    return null
  }
  if (status.mode === 'window' && status.code) {
    rInfo('pair-phone', 'reusing the open discovery window code', { environment_id: environmentId })
    return status.code
  }
  if (status.mode === 'persistent') {
    rInfo('pair-phone', 'minting a code on an always-discoverable environment', { environment_id: environmentId })
    return (await environmentClient.discoveryMintCode(environmentId)).code
  }
  rInfo('pair-phone', 'opening a discovery window for the phone', { environment_id: environmentId, minutes: DISCOVERY_MINUTES })
  const opened = await environmentClient.discoveryOpen(environmentId, DISCOVERY_MINUTES)
  openedWindow.current = true
  return opened.code
}

export function PairPhonePanel({ environmentId, environmentLabel, access, onClose }: { environmentId: string; environmentLabel: string; access: PairingAccess; onClose: (outcome: PairPhoneOutcome) => void }): React.JSX.Element {
  const [offer, setOffer] = useState<Offer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const openedWindow = useRef(false)
  const finished = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const finish = useCallback((outcome: PairPhoneOutcome): void => {
    if (finished.current) return
    finished.current = true
    rInfo('pair-phone', 'panel closing', { environment_id: environmentId, outcome, closes_window: openedWindow.current })
    if (openedWindow.current) {
      environmentClient.discoveryClose(environmentId).catch((err: unknown) => rWarn('pair-phone', 'closing the discovery window failed', { environment_id: environmentId, error: String(err) }))
    }
    onCloseRef.current(outcome)
  }, [environmentId])

  useEffect(() => {
    let cancelled = false
    let known: Set<string> | null = null

    const relist = (): void => {
      access.pairedIds(environmentId).then((ids) => {
        if (cancelled || !known) return
        const arrived = ids.find((id) => !known!.has(id))
        if (!arrived) return
        rInfo('pair-phone', 'a new pairing appeared', { environment_id: environmentId, access: access.kind })
        finish('paired')
      }).catch((err: unknown) => rWarn('pair-phone', 're-listing pairings failed', { environment_id: environmentId, error: String(err) }))
    }

    const start = async (): Promise<void> => {
      // The pairings that exist before anything is offered: anything beyond them is the phone.
      known = new Set(await access.pairedIds(environmentId))
      const link = await access.mint(environmentId, 'Phone')
      let code: string | null = null
      if (access.offersCode) {
        try {
          code = await obtainCode(environmentId, openedWindow)
        } catch (err) {
          // The QR code pairs on its own, so a refused code is not a reason to offer nothing.
          rWarn('pair-phone', 'no code available; offering the QR code alone', { environment_id: environmentId, error: String(err) })
        }
      } else {
        rInfo('pair-phone', 'pairing own device without admin; offering the QR code alone', { environment_id: environmentId })
      }
      if (cancelled) return
      rInfo('pair-phone', 'pairing offered', { environment_id: environmentId, access: access.kind, has_code: code !== null, expires_at: link.expiresAt })
      setOffer({ url: link.url, expiresAt: link.expiresAt, code })
    }

    start().catch((err: unknown) => {
      if (cancelled) return
      rWarn('pair-phone', 'offering a pairing failed', { environment_id: environmentId, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    })
    // The server says when its paired clients change, which is the moment
    // this pairing completes however the phone got there (code, link, or QR).
    // A code used from an open window is also replaced, announced on discovery.
    const offClients = onEnvironmentEvent(environmentId, CLIENTS_CHANGED_CHANNEL, relist)
    const offDiscovery = onEnvironmentEvent(environmentId, DISCOVERY_CHANNEL, relist)
    return () => {
      cancelled = true
      offClients()
      offDiscovery()
      // Unmounted without finishing (the dialog closed): a discovery window
      // this panel opened must not stay open behind the person's back.
      //
      // Reading the ref AT CLEANUP TIME is the point: the window is opened
      // asynchronously after this effect ran, so the value captured when it
      // ran is always false. The rule assumes a ref holds a rendered node,
      // and this one holds a boolean.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (openedWindow.current && !finished.current) {
        finished.current = true
        rInfo('pair-phone', 'panel unmounted; closing the discovery window it opened', { environment_id: environmentId })
        environmentClient.discoveryClose(environmentId).catch((err: unknown) => rWarn('pair-phone', 'closing the discovery window failed', { environment_id: environmentId, error: String(err) }))
      }
    }
  }, [environmentId, access, finish])

  const expiresAt = offer?.expiresAt ?? null
  useEffect(() => {
    if (expiresAt === null) return
    const tick = setInterval(() => {
      const at = Date.now()
      setNow(at)
      if (at >= expiresAt) finish('expired')
    }, 1000)
    return () => clearInterval(tick)
  }, [expiresAt, finish])

  return (
    <SidePanel
      open
      title="Pair a phone"
      subtitle={`Pairs a phone with ${environmentLabel}. This closes when the phone is paired.`}
      onClose={() => finish('cancelled')}
      footer={<Button onClick={() => finish('cancelled')}>Cancel</Button>}
    >
      <div data-testid="pair-phone-panel">
        <ErrorText>{error}</ErrorText>
        {!offer && !error && <Muted>Preparing…</Muted>}
        {offer && (
          <Stack>
            <img data-testid="pair-phone-qr" src={qrSvgDataUrl(offer.url)} alt="QR code of the pairing link" width={148} height={148} style={{ borderRadius: 6, alignSelf: 'center' }} />
            <Muted>Scan this with the phone. Treat it as a password.</Muted>
            {offer.code
              ? <Stack gap={4}>
                  <Muted>Or find {environmentLabel} on the phone and type this code:</Muted>
                  <CodeText large testId="pair-phone-code">{offer.code}</CodeText>
                </Stack>
              : <Muted>{access.offersCode ? 'This server has no code to type right now, so scan the QR code.' : 'The phone will act as you on this server. Scan the QR code to pair it.'}</Muted>}
            <span data-testid="pair-phone-expiry"><Muted>Expires in {remaining(offer.expiresAt, now)}. This closes when the phone is paired.</Muted></span>
          </Stack>
        )}
      </div>
    </SidePanel>
  )
}
