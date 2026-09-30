/**
 * BrowserPromptBar — one page request the operator must answer.
 *
 * A permission (location, camera, notifications, …), an HTTP login, or trust
 * in a certificate the browser refused. Each is a DOM row in the chrome, in
 * the same place and style as the preview network shield's confirm bar, so
 * the body hole shrinks under it and the main-process view follows.
 *
 * Main holds the page's request open until `onAnswer` fires with the same
 * promptId. Answering exactly once is the whole contract: a request nobody
 * answers leaves the page waiting, and a login answered twice is refused.
 */
import React, { useState } from 'react'
import { useColors } from '../../../theme'
import type { BrowserPermission, StudioBrowserPrompt, StudioBrowserPromptAnswer } from '@ion/shared/studio-browser-types'

export function permissionLabel(permission: BrowserPermission, mediaTypes: Array<'video' | 'audio'>): string {
  switch (permission) {
    case 'geolocation': return 'know your location'
    case 'notifications': return 'show notifications'
    case 'media': {
      const wantsVideo = mediaTypes.includes('video')
      const wantsAudio = mediaTypes.includes('audio')
      if (wantsVideo && wantsAudio) return 'use your camera and microphone'
      if (wantsVideo) return 'use your camera'
      if (wantsAudio) return 'use your microphone'
      return 'use your camera or microphone'
    }
    case 'midi': return 'use your MIDI devices'
    case 'midiSysex': return 'control your MIDI devices'
    case 'clipboard-read': return 'read your clipboard'
    case 'display-capture': return 'share your screen'
    case 'idle-detection': return 'know when you are away'
    case 'pointerLock': return 'capture your mouse pointer'
    case 'keyboardLock': return 'capture your keyboard'
  }
}

export function BrowserPromptBar({ prompt, onAnswer }: {
  prompt: StudioBrowserPrompt
  onAnswer(answer: StudioBrowserPromptAnswer): void
}): React.JSX.Element {
  const colors = useColors()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const primary: React.CSSProperties = { border: `1px solid ${colors.containerBorder}`, borderRadius: 4, background: 'transparent', color: colors.accent, cursor: 'pointer', fontSize: 10, padding: '1px 8px' }
  const secondary: React.CSSProperties = { border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', fontSize: 10 }
  const field: React.CSSProperties = { fontSize: 11, padding: '2px 6px', borderRadius: 4, border: `1px solid ${colors.containerBorder}`, background: colors.inputPillBg, color: colors.textPrimary, outline: 'none', width: 120 }

  let body: React.ReactNode
  switch (prompt.kind) {
    case 'permission':
      body = (
        <>
          <span><strong>{prompt.origin}</strong> wants to {permissionLabel(prompt.permission, prompt.mediaTypes)}.</span>
          <button style={primary} onClick={() => onAnswer({ promptId: prompt.promptId, kind: 'permission', granted: true })}>Allow</button>
          <button style={secondary} onClick={() => onAnswer({ promptId: prompt.promptId, kind: 'permission', granted: false })}>Block</button>
        </>
      )
      break
    case 'auth': {
      const submit = (): void => onAnswer({ promptId: prompt.promptId, kind: 'auth', username, password })
      body = (
        <>
          <span>{prompt.isProxy ? 'The proxy' : <strong>{prompt.host}</strong>} asks for a username and password{prompt.realm ? <> ({prompt.realm})</> : null}.</span>
          <input aria-label="Username" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" style={field} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
          <input aria-label="Password" placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" style={field} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
          <button style={primary} onClick={submit}>Sign in</button>
          <button style={secondary} onClick={() => onAnswer({ promptId: prompt.promptId, kind: 'auth', cancel: true })}>Cancel</button>
        </>
      )
      break
    }
    case 'certificate':
      body = (
        <>
          <span>The certificate for <strong>{prompt.host}</strong> is not trusted ({prompt.error}{prompt.issuer ? <>, issued by {prompt.issuer}</> : null}).</span>
          <button style={primary} onClick={() => onAnswer({ promptId: prompt.promptId, kind: 'certificate', proceed: false })}>Back to safety</button>
          <button style={{ ...secondary, color: colors.warningFg }} onClick={() => onAnswer({ promptId: prompt.promptId, kind: 'certificate', proceed: true })}>Proceed once</button>
        </>
      )
      break
  }

  return (
    <div
      role="alertdialog"
      aria-label={`Browser ${prompt.kind} request`}
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        padding: '5px 10px',
        fontSize: 11,
        fontFamily: 'system-ui, sans-serif',
        color: colors.textSecondary,
        background: colors.surfacePrimary,
        borderBottom: `1px solid ${colors.containerBorder}`,
        flexShrink: 0,
      }}
    >
      {body}
    </div>
  )
}
