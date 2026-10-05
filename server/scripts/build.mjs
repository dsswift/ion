#!/usr/bin/env node
// Bundles the server entry point with esbuild. `@ion/shared` ships only as
// TypeScript source (`packages/shared/package.json` exports map points at
// `.ts` files), so it must be bundled in rather than left as an external
// runtime import — a plain `node dist/main.js` cannot resolve `.ts`
// specifiers. Every pure-JavaScript dependency is bundled in the same way,
// so dist/ needs no node_modules of its own: the desktop ships it under
// app.asar.unpacked with nothing beside it but node-pty, and a packaged
// copy that reached for `ws` or `zustand` as an external import died on
// first launch with ERR_MODULE_NOT_FOUND. Only the native addon and ws's
// optional native accelerators stay external.
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const EXTERNAL = [
  // The one native addon. Its `.node` binary cannot be bundled; the runtime
  // must find a real node_modules/node-pty beside the bundle (the desktop
  // ships it unpacked next to dist/, the container installs it).
  'node-pty',
  // ws's optional native accelerators, required inside try/catch by ws
  // itself. Left external so that guarded require stays a runtime miss
  // rather than an esbuild resolution failure; ws falls back to JS.
  'bufferutil',
  'utf-8-validate',
  // No `electron` here on purpose. The server is a plain Node process in
  // every deployment (the desktop spawns it with ELECTRON_RUN_AS_NODE, the
  // container runs node directly), so a bare require('electron') left
  // external does not "defer to Electron" -- it throws at first use. Image
  // work uses pure-JS codecs (pngjs, jpeg-js) that bundle like anything
  // else; a new Electron reference fails this build, which is the point.
]

const sharedOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  tsconfig: join(root, 'tsconfig.json'),
  external: EXTERNAL,
  banner: {
    js: "import { createRequire as __ionCreateRequire } from 'module'; const require = __ionCreateRequire(import.meta.url);",
  },
  // `.mp3` is pulled in transitively by session-store-helpers.ts, which the
  // server inherited along with the rest of the moved store. Playing that
  // notification sound requires a DOM `Audio` constructor, which never
  // exists in this headless process (the code already gates on
  // `typeof Audio !== 'function'` and no-ops) -- the asset itself is
  // unreachable here, so it resolves to an empty module rather than a real
  // bundled asset.
  loader: { '.mp3': 'empty' },
  logLevel: 'info',
}

await build({
  ...sharedOptions,
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(root, 'dist/main.js'),
})

// Headless pairing CLI (`node dist/pair.js`): mints a pairing link over the
// server's own local socket so a server with no Studio client attached can
// still admit its first paired desktop. Its own entry so `node dist/pair.js`
// never boots the server.
await build({
  ...sharedOptions,
  entryPoints: [join(root, 'src/cli/pair.ts')],
  outfile: join(root, 'dist/pair.js'),
})

// Format Versions CLI (`node dist/compat.js`): prints this build's server
// formats. Packaging saves its output as compat.json beside VERSION, so an
// installed or not-yet-deployed build reports what it speaks without booting.
await build({
  ...sharedOptions,
  entryPoints: [join(root, 'src/cli/compat.ts')],
  outfile: join(root, 'dist/compat.js'),
})

// Paired devices CLI (`node dist/clients.js`): prints the owner's paired
// devices and which are connected now, over the local socket. `ion studio
// status` runs it so a fleet sees a host's devices.
await build({
  ...sharedOptions,
  entryPoints: [join(root, 'src/cli/clients.ts')],
  outfile: join(root, 'dist/clients.js'),
})

// The Fleet Hub (`node dist/hub.js`): the service servers report to. Its own
// entry so a hub never boots a Studio Server, and never needs an engine.
await build({
  ...sharedOptions,
  entryPoints: [join(root, 'src/hub/main.ts')],
  outfile: join(root, 'dist/hub.js'),
})

// dist/ is served from locations with no package.json above it (the
// desktop's app.asar.unpacked). Without this, Node has to sniff main.js for
// module syntax and warns MODULE_TYPELESS_PACKAGE_JSON on every boot.
// The version rides along so main.ts can report it from the packaged
// layout, where `server/package.json` is not shipped.
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
writeFileSync(join(root, 'dist/package.json'), JSON.stringify({ type: 'module', version }, null, 2) + '\n')
