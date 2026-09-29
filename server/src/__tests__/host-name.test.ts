import { describe, expect, it } from 'vitest'
import { hostname } from 'os'
import { hostName, HOST_NAME_ENV } from '../host-name'

describe('hostName', () => {
  it('reports ION_HOST_NAME, so a restarted pod is the same host', () => {
    expect(hostName({ [HOST_NAME_ENV]: 'orion-beta--example.apps.example.org' })).toBe('orion-beta--example.apps.example.org')
  })

  it('falls back to the OS hostname without .local when unset or blank', () => {
    const os = hostname().replace(/\.local$/, '')
    expect(hostName({})).toBe(os)
    expect(hostName({ [HOST_NAME_ENV]: '  ' })).toBe(os)
  })
})
