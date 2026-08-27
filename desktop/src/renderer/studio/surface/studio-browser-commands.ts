/**
 * Studio-side handler for main's browser commands.
 *
 * Main owns the Playwright runtime; the Surface store owns tab descriptors. So
 * every structural request arrives here, is applied to the store, and is
 * acknowledged exactly once.
 *
 * `ensure` answers as soon as the descriptor exists. It does NOT also wait for
 * the guest to register: main already polls its own target registry before
 * attaching Playwright (`waitForTarget` in runtime.ts), and that is the check
 * that must hold, since main is the party that needs the CDP target. Waiting in
 * both places would be two mechanisms for one invariant, and the renderer's
 * copy would be the one that silently drifts.
 */
import { useEffect } from 'react'
import { useSurfaceStore } from './surface-store'
import { rDebug, rWarn } from '../../rendererLogger'
import type { StudioBrowserCommandEnvelope, StudioBrowserCommandResult, StudioBrowserTabInfo } from '../../../shared/studio-browser-types'

/**
 * Open a link the operator cmd-clicked inside a browser guest.
 *
 * A new tab per click, matching the transcript and terminal behaviour: reusing
 * one tab would destroy the page the link came from, which is the page the
 * operator is usually comparing against.
 */
function openClickedGuestLink(url: string): void {
  const store = useSurfaceStore.getState()
  store.openBrowserTab(url, 'browse')
  store.setVisible(true)
  rDebug('studio.browser', 'opened guest link in a new browser tab', { host: hostOf(url) })
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).host
  } catch {
    return ''
  }
}

/** Register the browser command handlers for the lifetime of the window. */
export function useStudioBrowserCommands(): void {
  useEffect(() => registerStudioBrowserCommands(), [])
}

/** Install the handlers. Returns an unsubscribe for window teardown. */
export function registerStudioBrowserCommands(): () => void {
  const stopOpenUrl = window.ion.onStudioBrowserOpenUrl(openClickedGuestLink)
  const stopCommands = window.ion.onStudioBrowserCommand((envelope) => {
    try {
      window.ion.studioBrowserCommandResult(apply(envelope))
    } catch (err) {
      // Never leave main waiting: a thrown handler still owes an answer, and a
      // refusal the model can read beats a timeout it cannot explain.
      rWarn('studio.browser', 'browser command failed', { call_id: envelope.callId, error: String(err) })
      window.ion.studioBrowserCommandResult({ callId: envelope.callId, ok: false, error: String(err) })
    }
  })
  return () => {
    stopOpenUrl()
    stopCommands()
  }
}

function apply(envelope: StudioBrowserCommandEnvelope): StudioBrowserCommandResult {
  const { callId, command } = envelope
  const store = useSurfaceStore.getState()

  // Commands are addressed BY conversation, so a background conversation is
  // served exactly like the visible one. An agent that needs a browser must not
  // depend on the operator looking at its conversation, and must never be
  // retargeted onto whichever conversation happens to be on screen — the
  // conversation id below is the only thing that decides.
  switch (command.kind) {
    case 'status': {
      const tab = store.agentBrowser(command.conversationId)
      return tab
        ? { callId, ok: true, tab }
        : { callId, ok: false, error: 'This conversation has no browser tab yet.' }
    }

    case 'ensure': {
      const tab = store.ensureAgentBrowser(command.conversationId, command.url)
      if (!tab) return { callId, ok: false, error: 'Studio could not open a browser tab for this conversation.' }
      return { callId, ok: true, tab: latest(command.conversationId, tab) }
    }

    case 'reveal': {
      // The only verb that legitimately touches the operator's view, and only
      // ever because something explicitly asked to show this tab.
      const tab = store.agentBrowser(command.conversationId)
      if (!tab) return { callId, ok: false, error: 'This conversation has no browser tab to reveal.' }
      store.activateTab(`browser:${tab.instanceId}`)
      store.setVisible(true)
      return { callId, ok: true, tab }
    }

    case 'close': {
      const tab = store.agentBrowser(command.conversationId)
      if (!tab) return { callId, ok: false, error: 'This conversation has no browser tab to close.' }
      store.closeTab(`browser:${tab.instanceId}`)
      return { callId, ok: true }
    }

    case 'emulate': {
      const tab = store.agentBrowser(command.conversationId)
      if (!tab || tab.instanceId !== command.instanceId) {
        return { callId, ok: false, error: `browser instance ${command.instanceId} is not the agent-linked tab for this conversation` }
      }
      store.setBrowserEmulation(command.conversationId, command.instanceId, command.emulation)
      rDebug('studio.browser', 'browser emulation stored from main', {
        instance_id: command.instanceId,
        emulated: command.emulation !== null,
      })
      return { callId, ok: true, tab: latest(command.conversationId, tab) }
    }
  }
}

/** Re-read the descriptor so the reply carries post-mutation state. */
function latest(conversationId: string, fallback: StudioBrowserTabInfo): StudioBrowserTabInfo {
  return useSurfaceStore.getState().agentBrowser(conversationId) ?? fallback
}
