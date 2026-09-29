/**
 * ComposerPlusMenu — the `+` button inside the composer pill and the upward
 * menu it opens. Holds the actions that add something to the prompt: attach a
 * file, take a screenshot, and any extra items the caller supplies (extension
 * Composer Actions).
 *
 * The menu is edge-anchored: `bottom`/`left` come from the trigger rect so it
 * grows upward out of the pill, and `useViewportClamp` keeps it inside the
 * window. It portals into the PopoverLayer, so the root sets
 * `pointerEvents: 'auto'`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Plus, Paperclip, Camera } from '@phosphor-icons/react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { useColors } from '../../theme'
import { usePopoverLayer } from '../PopoverLayer'
import { useViewportClamp } from '../../hooks/useViewportClamp'
import { zoomAnchorEdges } from '../../viewport-zoom'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { Tooltip } from '../git/Tooltip'
import { host } from '../../host/host-instance'
import { rError, rInfo } from '../../rendererLogger'
import { COMPOSER_ATTACH_EVENT, COMPOSER_SCREENSHOT_EVENT } from './composer-events'

/** A caller-supplied row rendered under the built-in items. */
export interface ComposerPlusMenuItem {
  id: string
  label: string
  /** Small trailing text, e.g. the extension that contributed the item. */
  detail?: string
  icon: React.ReactNode
  onSelect: () => void
}

function MenuRow({ item, onDone }: { item: ComposerPlusMenuItem; onDone: () => void }): React.JSX.Element {
  const colors = useColors()
  const state = useInteractiveState()
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={`composer-plus-item-${item.id}`}
      {...state.handlers}
      onClick={() => { item.onSelect(); onDone() }}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] ion-focusable"
      style={{ color: colors.textPrimary, background: interactiveBg(colors, state), textAlign: 'left' }}
    >
      <span className="flex items-center justify-center" style={{ width: 16, color: colors.textSecondary }}>{item.icon}</span>
      <span className="truncate" style={{ flex: 1 }}>{item.label}</span>
      {item.detail && <span className="text-[10px]" style={{ color: colors.textTertiary }}>{item.detail}</span>}
    </button>
  )
}

export function ComposerPlusMenu({ extraItems = [] }: { extraItems?: ComposerPlusMenuItem[] }): React.JSX.Element {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const addAttachments = useSessionStore((s) => s.addAttachments)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerState = useInteractiveState()
  useViewportClamp(menuRef, open)

  // A native file picker and an OS screen capture both need the machine in
  // front of the user. A browser client lacks `nativeShell`, so it is offered
  // neither (it still attaches by paste and by drop).
  const nativeShell = host.capabilities().includes('nativeShell')

  const attachFile = useCallback(() => {
    rInfo('composer', 'attach file requested')
    void host.shell.attachFiles()
      .then((files) => { if (files && files.length > 0) addAttachments(files) })
      .catch((err) => rError('composer', 'attach file failed', { error: String(err) }))
  }, [addAttachments])

  const takeScreenshot = useCallback(() => {
    rInfo('composer', 'screenshot requested')
    void host.shell.takeScreenshot()
      .then((shot) => { if (shot) addAttachments([shot]) })
      .catch((err) => rError('composer', 'screenshot failed', { error: String(err) }))
  }, [addAttachments])

  // Keyboard shortcuts reach the composer as window events (the Studio keymap
  // owns capture; the composer owns the action).
  useEffect(() => {
    if (!nativeShell) return
    window.addEventListener(COMPOSER_ATTACH_EVENT, attachFile)
    window.addEventListener(COMPOSER_SCREENSHOT_EVENT, takeScreenshot)
    return () => {
      window.removeEventListener(COMPOSER_ATTACH_EVENT, attachFile)
      window.removeEventListener(COMPOSER_SCREENSHOT_EVENT, takeScreenshot)
    }
  }, [nativeShell, attachFile, takeScreenshot])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = (): void => {
    if (!open && triggerRef.current) {
      const rect = zoomAnchorEdges(triggerRef.current.getBoundingClientRect())
      setPos({ bottom: rect.fromBottom + 6, left: rect.left })
    }
    setOpen((o) => !o)
  }

  const builtIn: ComposerPlusMenuItem[] = nativeShell
    ? [
      { id: 'attach', label: 'Attach file', icon: <Paperclip size={14} />, onSelect: attachFile },
      { id: 'screenshot', label: 'Take screenshot', icon: <Camera size={14} />, onSelect: takeScreenshot },
    ]
    : []
  const hasAny = builtIn.length > 0 || extraItems.length > 0

  return (
    <>
      <Tooltip text="Add to prompt">
        <button
          ref={triggerRef}
          type="button"
          aria-label="Add to prompt"
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="composer-plus-button"
          disabled={!hasAny}
          {...(hasAny ? triggerState.handlers : {})}
          onClick={toggle}
          className="flex items-center justify-center rounded-full ion-focusable"
          style={{
            width: 24,
            height: 24,
            color: open ? colors.textPrimary : colors.textSecondary,
            background: interactiveBg(colors, { ...triggerState, selected: open }),
            border: `1px solid ${colors.containerBorder}`,
            opacity: hasAny ? 1 : 0.45,
            cursor: hasAny ? 'pointer' : 'default',
          }}
        >
          <Plus size={13} weight="bold" />
        </button>
      </Tooltip>

      {open && popoverLayer && createPortal(
        <motion.div
          ref={menuRef}
          role="menu"
          data-ion-ui
          data-testid="composer-plus-menu"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl py-1"
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            left: pos.left,
            minWidth: 200,
            maxWidth: 300,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
          }}
        >
          {builtIn.map((item) => <MenuRow key={item.id} item={item} onDone={() => setOpen(false)} />)}
          {builtIn.length > 0 && extraItems.length > 0 && (
            <div data-testid="composer-plus-divider" className="mx-2 my-1" style={{ height: 1, background: colors.popoverBorder }} />
          )}
          {extraItems.map((item) => <MenuRow key={item.id} item={item} onDone={() => setOpen(false)} />)}
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
