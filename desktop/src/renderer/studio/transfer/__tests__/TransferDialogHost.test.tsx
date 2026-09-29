// @vitest-environment jsdom
/**
 * TransferDialogHost — the dialog outlives whatever opened it.
 *
 * A transfer deletes the copy its opener stands for: the inbox row, the tab
 * pill, the worktree row. When the dialog lived inside the opener, a move
 * off this machine left it as an orphan whose Done button no longer
 * re-rendered anything, and its full-window backdrop took every click. The
 * host owns it instead, so the opener can vanish mid-transfer and Done still
 * closes the dialog.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const layer = document.createElement('div')
vi.mock('../../../components/PopoverLayer', () => ({ usePopoverLayer: () => layer }))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))
vi.mock('../TransferDialog', () => ({
  TransferDialog: ({ tabId, initialMode, onClose }: { tabId: string; initialMode: string; onClose(): void }) => (
    <div data-testid="transfer-dialog" data-tab-id={tabId} data-mode={initialMode}>
      <button onClick={onClose}>Done</button>
    </div>
  ),
}))

import { TransferDialogHost, openTransferDialog } from '../TransferDialogHost'

/** Stands in for a menu inside the row of the conversation being moved. */
function Opener(): React.JSX.Element {
  return <button onClick={() => openTransferDialog({ tabId: 'conv-1', initialMode: 'conversation' })}>Transfer…</button>
}

let hostRoot: Root
let openerRoot: Root
let openerContainer: HTMLDivElement

beforeEach(async () => {
  document.body.appendChild(layer)
  const hostContainer = document.createElement('div')
  openerContainer = document.createElement('div')
  document.body.append(hostContainer, openerContainer)
  hostRoot = createRoot(hostContainer)
  openerRoot = createRoot(openerContainer)
  await act(async () => { hostRoot.render(<TransferDialogHost />) })
  await act(async () => { openerRoot.render(<Opener />) })
})

afterEach(async () => {
  await act(async () => { hostRoot.unmount() })
  document.body.innerHTML = ''
})

const dialog = (): HTMLElement | null => layer.querySelector('[data-testid="transfer-dialog"]')

describe('TransferDialogHost', () => {
  it('keeps the dialog open after its opener unmounts, and Done still closes it', async () => {
    act(() => { openerContainer.querySelector('button')!.click() })
    expect(dialog()?.getAttribute('data-tab-id')).toBe('conv-1')

    // The move deletes the source copy, and the row that opened the dialog with it.
    await act(async () => { openerRoot.unmount() })
    expect(dialog()).not.toBeNull()

    act(() => { dialog()!.querySelector('button')!.click() })
    expect(dialog()).toBeNull()
  })

  it('opens in the mode the opener asked for', async () => {
    act(() => { openTransferDialog({ tabId: 'conv-2', initialMode: 'worktree' }) })
    expect(dialog()?.getAttribute('data-mode')).toBe('worktree')
    act(() => { dialog()!.querySelector('button')!.click() })
    await act(async () => { openerRoot.unmount() })
  })
})
