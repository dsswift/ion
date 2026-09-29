/**
 * PhoneRelaySection — how this desktop looks and behaves on a paired phone:
 * the name and icon the phone shows, the relay that reaches it off the LAN,
 * and the low-bandwidth switches. Every call and every live update is
 * addressed to the server Settings is editing, so an admin configures any
 * server's relay from here.
 *
 * There is no "Enable Remote Control" switch: a phone is an ordinary client
 * of the Studio wire, and a relay is used because one is configured. Every
 * value reads and writes through `useSettingsPreferences`, the store for the
 * server Settings is editing; these are Environment settings.
 */
import React, { useEffect, useState } from 'react'
import { PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import { IPC } from '@ion/shared/types'
import type { PreferencesState } from '@ion/server/preferences-types'
import { Button, FormGroup, FormRow, Inline, MonoLine, Muted, Stack, ToggleRow } from '../../kit'
import { useSettingsPreferences } from '../../settings-target'
import { useSettingsShell } from '../../settings-shell'
import { DisplayIconPanel, DisplayNamePanel, iconChoice } from './PhoneDisplayPanels'
import { RelayEditPanel, type RelayAuthConfig } from './RelayEditPanel'
import { rDebug, rError } from '../../../../rendererLogger'

export function PhoneRelaySection(): React.JSX.Element {
  return (
    <Stack gap={20}>
      <PhoneDisplayGroup />
      <RelayGroup />
      <LowBandwidthGroup />
    </Stack>
  )
}

function PhoneDisplayGroup(): React.JSX.Element {
  const { on } = useSettingsShell()
  const display = useSettingsPreferences((s) => s.remoteDisplay)
  const [panel, setPanel] = useState<'name' | 'icon' | null>(null)
  // An edit made on a phone is broadcast by that server; apply it at once
  // rather than waiting for the next settings read.
  useEffect(() => on(IPC.REMOTE_DISPLAY_CHANGED, (payload) => {
    const value = payload as PreferencesState['remoteDisplay']
    rDebug('remote.display', 'received broadcast', { custom_name: value?.customName ?? null, custom_icon: value?.customIcon ?? null })
    useSettingsPreferences.setState({ remoteDisplay: value })
  }), [on])
  const icon = iconChoice(display?.customIcon)
  return (
    <>
      <FormGroup title="On the phone" anchor="display" description="How every paired iPhone names and pictures this server.">
        <FormRow label="Name" description={display?.customName ? display.customName : <Muted>OS hostname</Muted>}>
          <Button onClick={() => setPanel('name')}>Edit</Button>
        </FormRow>
        <FormRow label="Icon" description={icon.label}>
          <icon.Icon size={16} aria-label={`Icon: ${icon.label}`} />
          <Button onClick={() => setPanel('icon')}>Change</Button>
        </FormRow>
      </FormGroup>
      {panel === 'name' && <DisplayNamePanel display={display} onClose={() => setPanel(null)} />}
      {panel === 'icon' && <DisplayIconPanel display={display} onClose={() => setPanel(null)} />}
    </>
  )
}

function RelayGroup(): React.JSX.Element {
  const { shell } = useSettingsShell()
  const relayUrl = useSettingsPreferences((s) => s.relayUrl)
  const relayApiKey = useSettingsPreferences((s) => s.relayApiKey)
  const setRelayUrl = useSettingsPreferences((s) => s.setRelayUrl)
  const setRelayApiKey = useSettingsPreferences((s) => s.setRelayApiKey)
  const [editing, setEditing] = useState(false)
  const [authConfig, setAuthConfig] = useState<RelayAuthConfig | null>(null)
  const [signedInUser, setSignedInUser] = useState<string | null>(null)

  // The row shows the server's relay identity without opening the editor.
  useEffect(() => {
    if (!relayUrl || editing) return
    let cancelled = false
    void (async () => {
      try {
        const cfg = await shell.remoteRelayAuthConfig(relayUrl)
        if (cancelled) return
        setAuthConfig(cfg ?? null)
        if (cfg?.oidc) {
          const identity = await shell.entraIdentity()
          if (cancelled) return
          setSignedInUser(identity?.identity?.username ?? null)
        } else {
          setSignedInUser(null)
        }
      } catch (err) {
        if (!cancelled) rError('settings', 'load relay identity failed', { error: String(err) })
      }
    })()
    return () => { cancelled = true }
  }, [relayUrl, editing, shell])

  const identity = relayUrl && authConfig?.oidc ? `Relay identity: ${signedInUser ?? 'not signed in'} · ${authConfig.issuer}` : null
  return (
    <>
      <FormGroup title="Relay" anchor="relay" description="Reaches a paired phone when it is not on this server's network.">
        <FormRow
          label="Relay server"
          description={relayUrl ? <Stack gap={2}><MonoLine>{relayUrl}</MonoLine>{identity && <span>{identity}</span>}</Stack> : 'No relay server configured. LAN only.'}
        >
          {relayUrl
            ? <Inline>
                <Button icon={PencilSimple} onClick={() => setEditing(true)}>Edit</Button>
                <Button variant="danger" icon={Trash} onClick={() => { setRelayUrl(''); setRelayApiKey('') }}>Remove</Button>
              </Inline>
            : <Button icon={Plus} onClick={() => setEditing(true)}>Add relay server</Button>}
        </FormRow>
      </FormGroup>
      {editing && (
        <RelayEditPanel
          relayUrl={relayUrl}
          relayApiKey={relayApiKey}
          onClose={() => setEditing(false)}
          onSave={(next) => { setRelayUrl(next.url); setRelayApiKey(next.apiKey); setEditing(false) }}
        />
      )}
    </>
  )
}

function LowBandwidthGroup(): React.JSX.Element {
  const streamThinkingToRemote = useSettingsPreferences((s) => s.streamThinkingToRemote)
  const setStreamThinkingToRemote = useSettingsPreferences((s) => s.setStreamThinkingToRemote)
  const pushConversationTitles = useSettingsPreferences((s) => s.pushConversationTitles)
  const setPushConversationTitles = useSettingsPreferences((s) => s.setPushConversationTitles)
  return (
    <FormGroup title="Low-bandwidth mode" anchor="low-bandwidth">
      <ToggleRow
        label="Stream reasoning to phone"
        description="Forward the model's live reasoning text to paired devices. Turn off to save bandwidth: the phone still shows that the model thought, and for how long, just not the per-token stream."
        checked={streamThinkingToRemote}
        onChange={setStreamThinkingToRemote}
      />
      <ToggleRow
        label="Conversation titles in notifications"
        description="Name the conversation in each push notification. Push text passes through the relay and Apple in plain text; the title is all it ever carries. Off sends generic text."
        checked={pushConversationTitles}
        onChange={setPushConversationTitles}
      />
    </FormGroup>
  )
}
