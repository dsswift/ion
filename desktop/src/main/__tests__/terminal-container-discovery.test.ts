import { describe, expect, it } from 'vitest'
import { parseDockerPorts } from '../terminal-container-discovery'

describe('parseDockerPorts', () => {
  it('returns every unique valid published host port', () => {
    const rows = [
      JSON.stringify({ '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '7071' }], '443/tcp': [{ HostPort: '7443' }] }),
      JSON.stringify({ '80/tcp': [{ HostPort: '7071' }], '8080/tcp': [{ HostPort: '17072' }] }),
    ].join('\n')
    expect(parseDockerPorts(rows)).toEqual([{ hostPort: 7071 }, { hostPort: 7443 }, { hostPort: 17072 }])
  })

  it('ignores malformed and unpublished mappings', () => {
    expect(parseDockerPorts('not json\n{"80/tcp":null}')).toEqual([])
  })
})
