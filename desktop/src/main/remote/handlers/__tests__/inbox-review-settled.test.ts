import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeJavaScript } = vi.hoisted(() => ({ executeJavaScript: vi.fn() }))

vi.mock('../../../state', () => ({
  state: { mainWindow: { webContents: { executeJavaScript } } },
}))
vi.mock('../../../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

import { handleTabDelete, handleTabReviewSettled } from '../inbox'

describe('handleTabReviewSettled', () => {
  beforeEach(() => {
    executeJavaScript.mockReset()
    executeJavaScript.mockResolvedValue(true)
  })

  it('routes permanent delete to the owner deletion action', async () => {
    await handleTabDelete({ type: 'desktop_tab_delete', tabId: 'live-tab' })

    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("deleteConversationTab('live-tab')"))
  })

  it('routes settled review to the owner restore action', async () => {
    await handleTabReviewSettled({ type: 'desktop_review_settled_tab', tabId: 'settled-tab' })

    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("restoreSettledHistoryTab('settled-tab')"))
  })
})
