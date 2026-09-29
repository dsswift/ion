// packaged-require-probe.js — child process for check-packaged-requires.js.
//
// Loads each requested bare specifier exactly as the packaged main process
// would: resolved from the bundle's own location inside the extracted asar,
// with nothing above that tree on the lookup path. Runs under the Electron
// binary as Node (ELECTRON_RUN_AS_NODE) in production so native addons load
// against the ABI they were rebuilt for; the unit tests run it under plain
// Node with pure-JS fixtures.
//
// `electron` itself is provided by the runtime, never by the asar, and under
// ELECTRON_RUN_AS_NODE `require("electron")` yields the binary path rather
// than the API. A stub that answers every property with a no-op stands in, so
// a library that touches `electron.app` at module scope loads instead of
// failing for a reason the real app would never see.
//
// Lookup is bounded to `rootDir`: Node would otherwise walk up past the
// extracted tree and could find a module in whatever node_modules happens to
// sit above the temp dir, which the packaged app never has.
//
// Input: argv[2] is a JSON object { rootDir, anchor, specifiers }. Output: one
// JSON array of { specifier, error? } on stdout.
const Module = require('node:module')

const [, , rawInput] = process.argv
const { rootDir, anchor, specifiers } = JSON.parse(rawInput)

const noop = () => undefined
const electronStub = new Proxy(
  {},
  {
    get: (_target, prop) => {
      if (prop === '__esModule') return false
      if (prop === 'default') return electronStub
      return new Proxy(noop, {
        get: (_fn, inner) => (inner === 'then' ? undefined : noop),
        apply: () => undefined,
      })
    },
  },
)

const originalLoad = Module._load
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron' || request.startsWith('electron/')) return electronStub
  return originalLoad.call(this, request, ...rest)
}

const originalNodeModulePaths = Module._nodeModulePaths
Module._nodeModulePaths = function boundedPaths(from) {
  return originalNodeModulePaths.call(this, from).filter((p) => p.startsWith(rootDir))
}

const requireFromBundle = Module.createRequire(anchor)
const results = specifiers.map((specifier) => {
  try {
    requireFromBundle(specifier)
    return { specifier }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { specifier, error: message.split('\n')[0] }
  }
})
process.stdout.write(JSON.stringify(results))
