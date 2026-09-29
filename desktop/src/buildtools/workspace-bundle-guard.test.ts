import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_SOURCE_PACKAGES,
  assertNoWorkspaceSourceLoads,
  findWorkspaceSourceLoads,
} from './workspace-bundle-guard'

describe('workspace-bundle-guard', () => {
  it('names both TypeScript-source workspace packages', () => {
    expect(WORKSPACE_SOURCE_PACKAGES).toEqual(['@ion/server', '@ion/shared'])
  })

  it('finds the exact shape electron-vite emits when a dependency is externalized', () => {
    // Verbatim from the packaged main bundle that crashed on launch: the
    // externalized workspace package survives as a bare CJS require.
    const code = [
      '"use strict";',
      'const launchEnv = require("@ion/server/launch-env");',
      'const state$3 = require("@ion/server/state");',
      'const typesStudio = require("@ion/shared/types-studio");',
      'const electron = require("electron");',
      'const fs = require("fs");',
    ].join('\n')
    expect(findWorkspaceSourceLoads([{ file: 'index.js', code }])).toEqual([
      { file: 'index.js', specifier: '@ion/server/launch-env' },
      { file: 'index.js', specifier: '@ion/server/state' },
      { file: 'index.js', specifier: '@ion/shared/types-studio' },
    ])
  })

  it('finds static and dynamic ESM loads as well as bare package roots', () => {
    const code = [
      "import { a } from '@ion/shared/paths'",
      "const b = await import('@ion/server')",
      'export { a, b }',
    ].join('\n')
    expect(findWorkspaceSourceLoads([{ file: 'splash.js', code }])).toEqual([
      { file: 'splash.js', specifier: '@ion/shared/paths' },
      { file: 'splash.js', specifier: '@ion/server' },
    ])
  })

  it('ignores relative loads, builtins, electron, and unrelated scoped packages', () => {
    const code = [
      'const a = require("./chunks/types-ipc.js");',
      'const b = require("node:fs");',
      'const c = require("electron");',
      'const d = require("@parcel/watcher");',
      'const e = require("@ionic/core");',
      'const f = require("ion-sdk");',
    ].join('\n')
    expect(findWorkspaceSourceLoads([{ file: 'index.js', code }])).toEqual([])
  })

  it('reports every offending load across files with the fix location', () => {
    const files = [
      { file: 'index.js', code: 'require("@ion/server/state")' },
      { file: 'splash.js', code: 'require("@ion/shared/types-ipc")' },
    ]
    expect(() => assertNoWorkspaceSourceLoads(files)).toThrowError(
      /index\.js -> @ion\/server\/state[\s\S]*splash\.js -> @ion\/shared\/types-ipc[\s\S]*externalizeDeps\.exclude/,
    )
  })

  it('passes a fully inlined bundle', () => {
    const code = [
      'const electron = require("electron");',
      'function readState() { return "@ion/server/state is only text here"; }',
    ].join('\n')
    expect(() =>
      assertNoWorkspaceSourceLoads([{ file: 'index.js', code }]),
    ).not.toThrow()
  })

  it('accepts a caller-supplied package list', () => {
    const files = [{ file: 'x.js', code: 'require("@acme/tools/util")' }]
    expect(findWorkspaceSourceLoads(files, ['@acme/tools'])).toEqual([
      { file: 'x.js', specifier: '@acme/tools/util' },
    ])
    expect(findWorkspaceSourceLoads(files)).toEqual([])
  })
})
