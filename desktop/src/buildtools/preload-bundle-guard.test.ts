import { describe, it, expect } from 'vitest'
import {
  assertSelfContainedPreloads,
  findRelativePreloadLoads,
} from './preload-bundle-guard'

describe('preload bundle guard', () => {
  it('accepts a self-contained CJS preload bundle', () => {
    const files = [
      {
        file: 'index.js',
        code: '"use strict";\nconst electron = require("electron");\nelectron.contextBridge.exposeInMainWorld("ionapi", {});\n',
      },
      {
        file: 'splash.js',
        code: '"use strict";\nconst electron = require("electron");\nconst IPC = { STARTUP_GET_STATE: "startup:get-state" };\n',
      },
    ]
    expect(findRelativePreloadLoads(files)).toEqual([])
    expect(() => assertSelfContainedPreloads(files)).not.toThrow()
  })

  it('rejects the split-chunk shape rollup emits for shared preload entries', () => {
    // Verbatim shape of the shipped regression: both entries required a
    // hoisted shared chunk, which a sandboxed preload cannot resolve.
    const files = [
      {
        file: 'index.js',
        code: 'const typesIpc = require("./chunks/types-ipc-Blmucftx.js");',
      },
      {
        file: 'splash.js',
        code: 'const typesIpc = require("./chunks/types-ipc-Blmucftx.js");',
      },
    ]
    expect(findRelativePreloadLoads(files)).toEqual([
      { file: 'index.js', specifier: './chunks/types-ipc-Blmucftx.js' },
      { file: 'splash.js', specifier: './chunks/types-ipc-Blmucftx.js' },
    ])
    expect(() => assertSelfContainedPreloads(files)).toThrow(
      /not self-contained/,
    )
  })

  it('detects ESM static and dynamic relative loads', () => {
    const files = [
      {
        file: 'index.mjs',
        code: 'import { IPC } from "./chunks/types-ipc.mjs";\nconst late = () => import("../shared/late.mjs");',
      },
    ]
    expect(findRelativePreloadLoads(files)).toEqual([
      { file: 'index.mjs', specifier: './chunks/types-ipc.mjs' },
      { file: 'index.mjs', specifier: '../shared/late.mjs' },
    ])
  })

  it('does not flag bare external specifiers', () => {
    const files = [
      {
        file: 'index.js',
        code: 'const electron = require("electron");\nconst path = require("node:path");\nimport { x } from "electron/renderer";',
      },
    ]
    expect(findRelativePreloadLoads(files)).toEqual([])
  })

  it('names every offending file in the failure message', () => {
    expect(() =>
      assertSelfContainedPreloads([
        { file: 'a.js', code: 'require("./chunks/x.js")' },
        { file: 'b.js', code: 'require("./chunks/y.js")' },
      ]),
    ).toThrow(/a\.js -> \.\/chunks\/x\.js[\s\S]*b\.js -> \.\/chunks\/y\.js/)
  })
})
