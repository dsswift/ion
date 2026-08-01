import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Click-outside / Escape dismissal for a portalled menu, with confirm dialogs
 * exempted.
 *
 * ── The defect this hook exists to prevent ──────────────────────────────────
 * Every popover menu in the overlay dismisses itself on a `mousedown` that
 * lands outside its own root element. A `ConfirmDialog` raised BY one of those
 * menus is rendered as a SIBLING of the menu root, not a descendant of it, so
 * `menuRoot.contains(target)` is false for a click on the dialog's own confirm
 * button. `mousedown` fires before `click`, so the sequence was:
 *
 *   1. operator presses the confirm button
 *   2. the menu's mousedown handler sees an "outside" click and calls onClose()
 *   3. the parent unmounts the menu, and the dialog with it
 *   4. `click` never dispatches, so onConfirm never runs
 *
 * The confirm button was therefore inert on every menu that raised a dialog
 * this way — the action silently did nothing, with no error to read, because
 * the IPC was never reached. Retire was the reported case; land-failure
 * acknowledgement and hard-reset had the identical shape.
 *
 * Two components had already worked around it locally by threading a
 * `confirmDialogRef` into their own handler. That fix does not compose: it has
 * to be repeated, by hand, in every menu that ever grows a dialog, and its
 * absence is invisible until an operator reports a dead button. This hook makes
 * the exemption structural instead: `ConfirmDialog` marks itself with
 * `data-ion-confirm`, and any menu using this hook is immune by construction.
 *
 * @param refs      Elements that count as "inside" (menu root, submenus).
 * @param onOutside Called on a mousedown outside all of them.
 * @param onEscape  Called on Escape. Defaults to `onOutside`'s behaviour being
 *                  unrelated, so it is passed explicitly by callers that need
 *                  to collapse submenu state first.
 */
export function useOutsideDismiss(
  refs: Array<RefObject<HTMLElement | null>>,
  onOutside: () => void,
  onEscape?: () => void,
): void {
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (!target) return
      // A confirm dialog raised by this menu is a sibling, not a child. Treat
      // it as inside: dismissing the menu would unmount the dialog before its
      // click could land.
      if (typeof target.closest === 'function' && target.closest('[data-ion-confirm]')) return
      for (const ref of refs) {
        if (ref.current && ref.current.contains(target)) return
      }
      onOutside()
    }
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (onEscape) onEscape()
      else onOutside()
    }
    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('keydown', handleKey)
    }
    // `refs` is a fresh array literal on every render at most call sites, so it
    // is deliberately not a dependency: the ref OBJECTS are stable and the
    // handler reads `.current` at event time, which is what makes that safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onOutside, onEscape])
}
