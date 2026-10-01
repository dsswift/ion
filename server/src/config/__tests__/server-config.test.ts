import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadServerConfig, defaultServerConfig } from '../server-config'
import { writeSecretRef } from '../secret-ref'

let dir: string
let originalEnvKeys: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-server-config-test-'))
  originalEnvKeys = Object.keys(process.env).filter((k) => k.startsWith('ION_SERVER_'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ION_SERVER_') && !originalEnvKeys.includes(key)) delete process.env[key]
  }
})

describe('loadServerConfig: absent file', () => {
  it('returns every documented default', () => {
    const config = loadServerConfig(dir)
    const defaults = defaultServerConfig()
    expect(config.listen).toEqual({ local: true, lan: true, tcp: { host: '0.0.0.0', port: 7331, allowUnsealedPaired: false } })
    expect(config.oidc).toBeNull()
    expect(config.relays).toEqual([])
    expect(config.pairing.defaultScopes).toEqual(defaults.pairing.defaultScopes)
    expect(config.engine).toEqual({ minVersion: '0.0.0' })
    expect(config.web).toEqual({ enabled: false })
    expect(config.policy).toEqual({ authPolicy: 'default', actionInterceptor: 'default', snapshotProjector: 'default' })
    expect(config.logLevel).toBe('DEBUG')
    expect(typeof config.label).toBe('string')
    expect(config.label.length).toBeGreaterThan(0)
    expect(config.homeProject).toBeNull()
  })
})

describe('loadServerConfig: homeProject', () => {
  it('parses a complete config', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({
      homeProject: {
        directory: 'atlas',
        gitRemote: 'git@gitlab.example.com:team/ops.git',
        engineProfile: { name: 'cos2', extensions: ['/data/.ion/extensions/cos2/main'], defaultMode: 'auto' },
      },
    }))
    const config = loadServerConfig(dir)
    expect(config.homeProject).toEqual({
      directory: 'atlas',
      gitRemote: 'git@gitlab.example.com:team/ops.git',
      engineProfile: { name: 'cos2', extensions: ['/data/.ion/extensions/cos2/main'], defaultMode: 'auto' },
    })
  })

  it('defaults engineProfile.defaultMode to auto when omitted', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({
      homeProject: {
        directory: 'atlas',
        gitRemote: 'git@gitlab.example.com:team/ops.git',
        engineProfile: { name: 'cos2', extensions: ['/data/.ion/extensions/cos2/main'] },
      },
    }))
    const config = loadServerConfig(dir)
    expect(config.homeProject?.engineProfile.defaultMode).toBe('auto')
  })

  it.each([
    ['missing directory', { gitRemote: 'git@x', engineProfile: { name: 'cos2', extensions: ['a'] } }],
    ['missing gitRemote', { directory: 'atlas', engineProfile: { name: 'cos2', extensions: ['a'] } }],
    ['missing engineProfile.name', { directory: 'atlas', gitRemote: 'git@x', engineProfile: { extensions: ['a'] } }],
    ['empty engineProfile.extensions', { directory: 'atlas', gitRemote: 'git@x', engineProfile: { name: 'cos2', extensions: [] } }],
  ])('treats an incomplete config (%s) as absent, not a partial value', (_label, homeProject) => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ homeProject }))
    const config = loadServerConfig(dir)
    expect(config.homeProject).toBeNull()
  })
})

describe('loadServerConfig: malformed file', () => {
  it('falls back to defaults on invalid JSON rather than throwing', () => {
    writeFileSync(join(dir, 'server.json'), '{ not json')
    const config = loadServerConfig(dir)
    expect(config.listen.tcp.port).toBe(7331)
  })

  it('falls back to defaults when the root is not an object', () => {
    writeFileSync(join(dir, 'server.json'), '[1,2,3]')
    const config = loadServerConfig(dir)
    expect(config.listen.tcp.port).toBe(7331)
  })
})

describe('loadServerConfig: partial overrides', () => {
  it('applies an explicit label and tcp port while defaulting everything else', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ label: "Josh's Mac", listen: { tcp: { port: 9000 } } }))
    const config = loadServerConfig(dir)
    expect(config.label).toBe("Josh's Mac")
    expect(config.listen.tcp.port).toBe(9000)
    expect(config.listen.tcp.host).toBe('0.0.0.0')
    expect(config.listen.local).toBe(true)
  })

  it('parses a full oidc block', () => {
    writeFileSync(
      join(dir, 'server.json'),
      JSON.stringify({
        oidc: {
          issuer: 'https://login.microsoftonline.com/tenant/v2.0',
          audience: 'api://server',
          scope: 'Studio.Access',
          clientId: 'spa-client-id',
          rolesToScopes: { 'Studio.Admin': ['admin'] },
          defaultScopes: ['conversations:read'],
          allowedSubjects: ['sub-1'],
        },
      }),
    )
    const config = loadServerConfig(dir)
    expect(config.oidc).toEqual({
      issuer: 'https://login.microsoftonline.com/tenant/v2.0',
      audience: 'api://server',
      scope: 'Studio.Access',
      clientId: 'spa-client-id',
      rolesToScopes: { 'Studio.Admin': ['admin'] },
      defaultScopes: ['conversations:read'],
      allowedSubjects: ['sub-1'],
      clientSecret: '',
    })
  })

  it('defaults clientId to an empty string when the oidc block omits it', () => {
    writeFileSync(
      join(dir, 'server.json'),
      JSON.stringify({ oidc: { issuer: 'https://login.microsoftonline.com/tenant/v2.0', audience: 'api://server', scope: 'Studio.Access' } }),
    )
    const config = loadServerConfig(dir)
    expect(config.oidc?.clientId).toBe('')
  })

  it('treats an oidc block missing issuer/audience/scope as absent', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ oidc: { issuer: 'https://issuer.example.com' } }))
    const config = loadServerConfig(dir)
    expect(config.oidc).toBeNull()
  })

  it('drops a non-scope entry from pairing.defaultScopes rather than accepting it', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ pairing: { defaultScopes: ['conversations:read', 'not-a-real-scope'] } }))
    const config = loadServerConfig(dir)
    expect(config.pairing.defaultScopes).toEqual(['conversations:read'])
  })
})

describe('loadServerConfig: relays[].psk secretstore resolution', () => {
  it('resolves a secretstore: reference from an env var', () => {
    process.env.ION_SERVER_RELAY_PSK = 'from-env-var'
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ relays: [{ url: 'wss://relay.example.org', psk: 'secretstore:relay-psk' }] }))
    const config = loadServerConfig(dir)
    expect(config.relays).toEqual([{ url: 'wss://relay.example.org', psk: 'from-env-var' }])
  })

  it('resolves a secretstore: reference from server-secrets.json when no env var is set', () => {
    writeSecretRef(dir, 'relay-psk', 'from-secrets-file')
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ relays: [{ url: 'wss://relay.example.org', psk: 'secretstore:relay-psk' }] }))
    const config = loadServerConfig(dir)
    expect(config.relays).toEqual([{ url: 'wss://relay.example.org', psk: 'from-secrets-file' }])
  })

  it('resolves to an empty string when the reference cannot be resolved at all', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ relays: [{ url: 'wss://relay.example.org', psk: 'secretstore:never-configured' }] }))
    const config = loadServerConfig(dir)
    expect(config.relays).toEqual([{ url: 'wss://relay.example.org', psk: '' }])
  })

  it('passes a literal (non-secretstore:) psk value through unchanged', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ relays: [{ url: 'wss://relay.example.org', psk: '' }] }))
    const config = loadServerConfig(dir)
    expect(config.relays).toEqual([{ url: 'wss://relay.example.org', psk: '' }])
  })
})

describe('loadServerConfig: tenancy.unownedTabs', () => {
  it('defaults to no explicit override -- unownedTabsVisible() derives it live from oidc', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({}))
    const config = loadServerConfig(dir)
    expect(config.tenancy).toEqual({})
  })

  it('honors an explicit visible override even with oidc configured', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({
      oidc: { issuer: 'https://issuer.example.org', audience: 'ion-server', scope: 'api://ion-server/.default' },
      tenancy: { unownedTabs: 'visible' },
    }))
    const config = loadServerConfig(dir)
    expect(config.tenancy).toEqual({ unownedTabs: 'visible' })
  })

  it('drops an invalid unownedTabs value rather than accepting it', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ tenancy: { unownedTabs: 'sometimes' } }))
    const config = loadServerConfig(dir)
    expect(config.tenancy).toEqual({})
  })
})

describe('loadServerConfig: tenancy.mode (FR-02)', () => {
  it('defaults to no explicit mode -- isSharedTenancy() treats absence as isolated', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({}))
    const config = loadServerConfig(dir)
    expect(config.tenancy).toEqual({})
  })

  it('parses an explicit shared mode', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ tenancy: { mode: 'shared' } }))
    const config = loadServerConfig(dir)
    expect(config.tenancy).toEqual({ mode: 'shared' })
  })

  it('parses an explicit isolated mode', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ tenancy: { mode: 'isolated' } }))
    const config = loadServerConfig(dir)
    expect(config.tenancy).toEqual({ mode: 'isolated' })
  })

  it('drops an invalid mode value rather than accepting it', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ tenancy: { mode: 'everyone' } }))
    const config = loadServerConfig(dir)
    expect(config.tenancy).toEqual({})
  })

  it('carries both mode and unownedTabs together', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ tenancy: { mode: 'shared', unownedTabs: 'visible' } }))
    const config = loadServerConfig(dir)
    expect(config.tenancy).toEqual({ mode: 'shared', unownedTabs: 'visible' })
  })
})

describe('loadServerConfig: git', () => {
  it('defaults to no credentials and every exchange disabled', () => {
    const config = loadServerConfig(dir)
    expect(config.git).toEqual({ credentials: [], publicOrigin: '', exchange: { ado: { enabled: false }, gitlab: null, github: null } })
  })

  it('resolves an admin credential entry, keyRef/tokenRef past secretstore:', () => {
    writeSecretRef(dir, 'alice-github-key', 'PRIVATE-KEY-MATERIAL')
    writeFileSync(join(dir, 'server.json'), JSON.stringify({
      git: {
        credentials: [
          { subject: 'oidc:alice', host: 'github.com', kind: 'ssh', keyRef: 'secretstore:alice-github-key', publicKey: 'ssh-ed25519 AAAA...' },
        ],
      },
    }))
    const config = loadServerConfig(dir)
    expect(config.git.credentials).toEqual([
      { subject: 'oidc:alice', host: 'github.com', kind: 'ssh', privateKey: 'PRIVATE-KEY-MATERIAL', publicKey: 'ssh-ed25519 AAAA...', token: undefined, username: undefined },
    ])
  })

  it('drops a credential entry missing subject/host/kind', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ git: { credentials: [{ host: 'github.com' }] } }))
    const config = loadServerConfig(dir)
    expect(config.git.credentials).toEqual([])
  })

  it('strips a trailing slash from publicOrigin', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ git: { publicOrigin: 'https://ion.example.com/' } }))
    const config = loadServerConfig(dir)
    expect(config.git.publicOrigin).toBe('https://ion.example.com')
  })

  it('enables ado exchange when configured', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ git: { exchange: { ado: { enabled: true } } } }))
    const config = loadServerConfig(dir)
    expect(config.git.exchange.ado).toEqual({ enabled: true })
  })

  it('resolves gitlab exchange clientSecretRef past secretstore:', () => {
    writeSecretRef(dir, 'gitlab-secret', 'GITLAB-SECRET')
    writeFileSync(join(dir, 'server.json'), JSON.stringify({
      git: { exchange: { gitlab: { baseUrl: 'https://gitlab.example.com', clientId: 'app-id', clientSecretRef: 'secretstore:gitlab-secret' } } },
    }))
    const config = loadServerConfig(dir)
    expect(config.git.exchange.gitlab).toEqual({ baseUrl: 'https://gitlab.example.com', clientId: 'app-id', clientSecret: 'GITLAB-SECRET' })
  })

  it('treats an incomplete gitlab exchange block as absent', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ git: { exchange: { gitlab: { baseUrl: 'https://gitlab.example.com' } } } }))
    const config = loadServerConfig(dir)
    expect(config.git.exchange.gitlab).toBeNull()
  })

  it('resolves github exchange clientSecretRef past secretstore:', () => {
    writeSecretRef(dir, 'github-secret', 'GITHUB-SECRET')
    writeFileSync(join(dir, 'server.json'), JSON.stringify({
      git: { exchange: { github: { clientId: 'app-id', clientSecretRef: 'secretstore:github-secret' } } },
    }))
    const config = loadServerConfig(dir)
    expect(config.git.exchange.github).toEqual({ clientId: 'app-id', clientSecret: 'GITHUB-SECRET' })
  })
})

describe('loadServerConfig: oidc clientSecret', () => {
  it('resolves clientSecretRef past secretstore:', () => {
    writeSecretRef(dir, 'oidc-secret', 'OIDC-SECRET')
    writeFileSync(join(dir, 'server.json'), JSON.stringify({
      oidc: { issuer: 'https://issuer.example.org', audience: 'ion-server', scope: 'api://ion-server/.default', clientSecretRef: 'secretstore:oidc-secret' },
    }))
    const config = loadServerConfig(dir)
    expect(config.oidc?.clientSecret).toBe('OIDC-SECRET')
  })

  it('defaults to an empty clientSecret when unset', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({
      oidc: { issuer: 'https://issuer.example.org', audience: 'ion-server', scope: 'api://ion-server/.default' },
    }))
    const config = loadServerConfig(dir)
    expect(config.oidc?.clientSecret).toBe('')
  })
})
