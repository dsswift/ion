import { describe, expect, it } from 'vitest'
import { autoSettleChangeCanSettle, isAutoSettlePreview } from './auto-settle-change'

describe('autoSettleChangeCanSettle', () => {
  it('asks before turning auto-settle on', () => {
    expect(autoSettleChangeCanSettle(0, 3)).toBe(true)
  })

  it('asks before shortening the window', () => {
    expect(autoSettleChangeCanSettle(30, 3)).toBe(true)
  })

  it('never asks when nothing can be settled by the change', () => {
    expect(autoSettleChangeCanSettle(3, 0)).toBe(false) // turning it off
    expect(autoSettleChangeCanSettle(3, 30)).toBe(false) // lengthening
    expect(autoSettleChangeCanSettle(3, 3)).toBe(false) // unchanged
    expect(autoSettleChangeCanSettle(0, 0)).toBe(false)
  })
})

describe('isAutoSettlePreview', () => {
  it('accepts the server shape and refuses anything else', () => {
    expect(isAutoSettlePreview({ count: 2, titles: ['a', 'b'] })).toBe(true)
    expect(isAutoSettlePreview({ count: '2', titles: [] })).toBe(false)
    expect(isAutoSettlePreview(null)).toBe(false)
  })
})
