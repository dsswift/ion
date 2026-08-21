import { useEffect, useRef } from 'react'
import { resolveViewBindings } from '../shortcuts/shortcut-catalog'
import type { ShortcutHandlers, ShortcutView } from '../shortcuts/shortcut-types'
import { matchesChord, parseChord } from '../shortcuts/chord'
import { usePreferencesStore } from '../preferences'
import { rDebug, rError, rTrace } from '../rendererLogger'

export interface UseCommandShortcutsOptions {
  view: ShortcutView
  handlers: ShortcutHandlers
  /** Studio needs capture because xterm and CodeMirror stop bubbling events. */
  capture?: boolean
  /** Startup keeps product shortcuts inactive until its shell is complete. */
  enabled?: boolean
}

function contextFor(target: EventTarget | null): 'default' | 'terminalFocus' | 'editorFocus' {
  if (!(target instanceof Element)) return 'default'
  if (target.closest('.xterm')) return 'terminalFocus'
  if (target.closest('.cm-editor')) return 'editorFocus'
  return 'default'
}

/**
 * Shared keyboard dispatch. It resolves live persisted overrides per event,
 * consumes only an installed command, and remains deliberately agnostic about
 * whether handlers mutate local Studio layout or forward owner-durable state.
 */
export function useCommandShortcuts({ view, handlers, capture = false, enabled = true }: UseCommandShortcutsOptions): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcutPreferences = usePreferencesStore.getState().keyboardShortcuts
      const overrides = shortcutPreferences[view] ?? {}
      const context = contextFor(event.target)
      const resolution = resolveViewBindings(view, overrides)
      const match = resolution.shortcuts.find((shortcut) => {
        if (!shortcut.enabled) return false
        if (shortcut.entry.when && shortcut.entry.when !== context) return false
        return matchesChord(event, parseChord(shortcut.binding))
      })
      if (!match) return

      const handler = handlersRef.current[match.entry.id]
      if (!handler) {
        rTrace('shortcuts', 'matched shortcut has no handler', {
          view, command: match.entry.id, binding: match.binding, context,
        })
        return
      }

      event.preventDefault()
      event.stopPropagation()
      rDebug('shortcuts', 'dispatching command', {
        view, command: match.entry.id, binding: match.binding, context,
      })
      try {
        const outcome = handler(event)
        if (outcome && typeof (outcome as Promise<void>).then === 'function') {
          void (outcome as Promise<void>)
            .then(() => rDebug('shortcuts', 'command completed', { view, command: match.entry.id }))
            .catch((error) => rError('shortcuts', 'command failed', {
              view, command: match.entry.id, error: String(error),
            }))
        } else {
          rDebug('shortcuts', 'command completed', { view, command: match.entry.id })
        }
      } catch (error) {
        rError('shortcuts', 'command threw', { view, command: match.entry.id, error: String(error) })
      }
    }
    window.addEventListener('keydown', onKeyDown, capture)
    return () => window.removeEventListener('keydown', onKeyDown, capture)
  }, [capture, enabled, view])
}
