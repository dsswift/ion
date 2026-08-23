import { describe, expect, it } from 'vitest'
import { homedir } from 'os'

describe('Vitest home isolation', () => {
  it('keeps durable state away from the operator home', () => {
    expect(process.env.ION_REAL_HOME).toBeTruthy()
    expect(process.env.ION_VITEST_HOME).toBeTruthy()
    expect(process.env.HOME).toBe(process.env.ION_VITEST_HOME)
    expect(process.env.USERPROFILE).toBe(process.env.ION_VITEST_HOME)
    expect(homedir()).toBe(process.env.ION_VITEST_HOME)
    expect(homedir()).not.toBe(process.env.ION_REAL_HOME)
  })
})
