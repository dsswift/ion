import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeJavaScript } = vi.hoisted(() => ({ executeJavaScript: vi.fn() }))

vi.mock('../../../state', () => ({
  state: { mainWindow: { webContents: { executeJavaScript } } },
}))
vi.mock('../../../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

import { handleTabMarkRead } from '../inbox'

describe('handleTabMarkRead', () => {
  beforeEach(() => {
    executeJavaScript.mockReset()
    executeJavaScript.mockResolvedValue(true)
  })

  it('routes mobile review to the owner read action', async () => {
    await handleTabMarkRead('reviewed-tab')

    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("markTabRead('reviewed-tab')"))
  })
})
