/**
 * useComposerActions — the rows extensions have added to the composer's `+`
 * menu, through the Studio SDK.
 *
 * The server decides which actions a conversation offers and this hook
 * renders that list: the read `composerActions(tabId)` for first paint, then
 * `onComposerActions` for changes. Nothing is derived here, so a conversation
 * that does not run an extension never sees its rows. Choosing a row
 * sends its slash command through the same submit path a typed command takes,
 * so the prompt pipeline resolves it to the extension that registered it.
 */
import React, { useEffect, useMemo, useState } from 'react'
import type { ComponentType } from 'react'
import type { IconProps } from '@phosphor-icons/react'
import { PuzzlePiece, Newspaper, ChartBar, Lightning, Play, Rocket, Terminal, HandWaving, Gear, MagnifyingGlass, ListChecks, Brain } from '@phosphor-icons/react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { ComposerAction } from '@ion/shared/studio-sdk-contract'
import { host } from '../../host/host-instance'
import { rInfo, rWarn } from '../../rendererLogger'
import type { ComposerPlusMenuItem } from './ComposerPlusMenu'

/** Icons an extension may name. An unknown name gets the extension icon. */
const ACTION_ICONS: Record<string, ComponentType<IconProps>> = {
  Newspaper, ChartBar, Lightning, Play, Rocket, Terminal, HandWaving, Gear, MagnifyingGlass, ListChecks, Brain, PuzzlePiece,
}

function runComposerAction(action: ComposerAction): void {
  const { activeTabId, submit } = useSessionStore.getState()
  if (!activeTabId) {
    rWarn('composer', 'composer action ignored: no active conversation', { action_id: action.id, producer: action.producer })
    return
  }
  rInfo('composer', 'composer action chosen', { action_id: action.id, producer: action.producer, command: action.command })
  void Promise.resolve(submit(activeTabId, action.command)).catch((err: unknown) => {
    rWarn('composer', 'composer action submit failed', { action_id: action.id, error: String(err) })
  })
}

const NO_ACTIONS: ComposerAction[] = []

/** The active conversation's offered actions, as the server last reported them. */
function useOfferedActions(): ComposerAction[] {
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const [offered, setOffered] = useState<{ tabId: string | null; actions: ComposerAction[] }>({ tabId: null, actions: NO_ACTIONS })
  useEffect(() => {
    if (!activeTabId) return
    let live = true
    // A publish that lands before the read resolves is newer than the read.
    let published = false
    const unsubscribe = host.shell.onComposerActions((state) => {
      if (state.tabId !== activeTabId) return
      published = true
      setOffered({ tabId: activeTabId, actions: state.actions })
    })
    void host.shell.composerActions(activeTabId)
      .then((actions) => {
        if (live && !published) setOffered({ tabId: activeTabId, actions })
      })
      .catch((err: unknown) => rWarn('composer', 'composer actions read failed', { tab_id: activeTabId, error: String(err) }))
    return () => { live = false; unsubscribe() }
  }, [activeTabId])
  // A list read for another conversation is never shown in this one.
  return offered.tabId === activeTabId ? offered.actions : NO_ACTIONS
}

export function useComposerActions(): ComposerPlusMenuItem[] {
  const actions = useOfferedActions()
  return useMemo(() => actions.map((action) => {
    const Icon = ACTION_ICONS[action.icon] ?? PuzzlePiece
    return {
      id: `${action.producer}:${action.id}`,
      label: action.label,
      detail: action.producer,
      icon: <Icon size={14} />,
      onSelect: () => runComposerAction(action),
    }
  }), [actions])
}
