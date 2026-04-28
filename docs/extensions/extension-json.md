---
title: extension.json Reference
description: Per-extension manifest for the Ion Engine extension system.
sidebar_position: 6
---

# `extension.json`

`extension.json` is an optional manifest sibling to your extension's entry point. It declares per-extension build and load configuration that the engine honors when loading the extension. Most extensions don't need one.

## When you need it

| Scenario | Need a manifest? |
|---|---|
| Single-file TypeScript extension, no npm deps | No |
| TypeScript extension with pure-JS npm deps (chokidar, lodash, ...) | No -- a `package.json` alone is enough; the engine runs `npm install` automatically. |
| Extension that imports a native module (`.node` file like `keytar`, `better-sqlite3`) | **Yes**, declare it in `external`. |
| Extension that wants a non-default display name in logs | Optional |
| Pin a minimum engine version | Optional (reserved; not yet enforced) |

## File location

Place `extension.json` next to your entry point:

```
my-extension/
  index.ts
  extension.json     ← optional manifest
  package.json       ← optional npm deps
  agents/
  ...
```

## Schema

```json
{
  "$schema": "https://ion.example.com/schemas/extension.json",
  "name": "jarvis",
  "external": ["keytar"],
  "engineVersion": ">=0.5.0"
}
```

The engine **rejects unknown top-level keys** to keep the surface predictable. If you add a field that isn't in this reference, the load will fail with a clear error.

### Fields

#### `name` (optional, string)

Display name for the extension. Used in logs and event source attribution. Defaults to the parent directory name.

```json
{ "name": "jarvis" }
```

#### `external` (optional, string array)

Package names that should **not** be bundled by esbuild. Each entry becomes a `--external:<name>` flag at build time and is expected to resolve at runtime from `<extDir>/node_modules`.

Use for:

- **Native modules** -- `.node` binaries that esbuild cannot inline. Examples: `keytar`, `better-sqlite3`, `node-canvas`, `serialport`.
- **Packages you explicitly want unbundled** -- e.g. very large modules that you'd rather load on demand, or modules whose ESM/CJS shape esbuild can't infer.

```json
{ "external": ["keytar", "better-sqlite3"] }
```

The engine sets `NODE_PATH=<extDir>/node_modules` on the extension subprocess and bundles into `<extDir>/.ion-build/ext-<timestamp>.mjs`, so Node's ESM resolver walks up to find the user-installed copy of each external package.

#### `engineVersion` (optional, string)

Reserved for future use. Will support a semver range (e.g. `">=0.5.0"`) that the engine compares against its own version on load. Currently parsed but not enforced.

## Worked examples

### Pure-JS deps only — no manifest needed

If your extension uses pure-JavaScript npm packages (chokidar, lodash, axios, ...), create a `package.json` with the deps listed and skip `extension.json` entirely:

```json
// package.json
{
  "name": "my-watcher",
  "version": "0.1.0",
  "dependencies": {
    "chokidar": "^3.6.0"
  }
}
```

```ts
// index.ts
import chokidar from 'chokidar'
import { createIon } from '../sdk/ion-sdk'

const ion = createIon()
const watcher = chokidar.watch('./config')
watcher.on('change', () => { /* ... */ })
```

The engine sees `package.json`, runs `npm install --omit=dev` automatically before transpiling, and esbuild bundles `chokidar` into the output. No manifest required.

### Native module — `keytar` for keychain access

Native modules can't be bundled. Declare them in `external` so esbuild emits a runtime `import` instead:

```json
// extension.json
{
  "name": "jarvis-secrets",
  "external": ["keytar"]
}
```

```json
// package.json
{
  "name": "jarvis-secrets",
  "version": "0.1.0",
  "dependencies": {
    "keytar": "^7.9.0"
  }
}
```

```ts
// index.ts
import keytar from 'keytar'
import { createIon } from '../sdk/ion-sdk'

const ion = createIon()
const token = await keytar.getPassword('jarvis', 'anthropic-api')
```

The engine runs `npm install` (which compiles keytar's native binding for the running Node version), bundles `index.ts` with `--external:keytar`, and runs the bundle with `NODE_PATH=<extDir>/node_modules` so the runtime `import keytar` resolves to the installed package.

## How `npm install` is invoked

When the engine loads an extension and finds a `package.json` in the extension directory, it runs:

```
npm install --omit=dev --no-fund --no-audit --no-progress
```

The install is **idempotent**: the engine checks the modification times of `package.json`, `package-lock.json` (or `npm-shrinkwrap.json`), and `node_modules/.package-lock.json`. If `node_modules` is at least as new as `package.json`, the install is skipped on subsequent loads.

A 120-second timeout protects against hung installs (network issues, registry outages). Failures are surfaced as load errors with the npm stderr appended to the message.

## Build artifacts

The transpiled bundle lands in `<extDir>/.ion-build/ext-<timestamp>.mjs`. The engine creates `.ion-build/.gitignore` automatically so the directory never makes it into version control. You can safely delete `.ion-build/` at any time -- the engine recreates it on the next load.

## Pitfalls

- **Native module ABI mismatches.** `keytar`, `better-sqlite3`, and other native modules ship platform-specific binaries. They must be installed under the same Node major version the engine spawns extensions with (currently Node 20). If `npm install` succeeds but the runtime import fails, check the binding's Node version compatibility.
- **`package.json` alone is not enough for native modules.** Without `external` in `extension.json`, esbuild tries to bundle the native binding and silently emits a broken bundle. Symptoms: extension subprocess exits immediately with no stdout. Add the package to `external` and the runtime import will resolve correctly.
- **`node_modules` size.** The engine does not deduplicate across extensions. If you have many extensions sharing the same heavy dep, each one installs its own copy. Future versions may add a shared cache; for now, prefer pure-JS alternatives where reasonable.
- **`package-lock.json` is recommended.** The engine uses lockfile mtime as part of its idempotency check. Without one, `node_modules/.package-lock.json` (which npm writes after install) is used as the stamp, but a missing top-level lockfile means every change to `package.json` triggers a re-install.

## Related

- [Extension Anatomy](anatomy.md) -- directory layout and load lifecycle.
- [TypeScript SDK Reference](sdk-typescript.md)
- [Configuration overview](../configuration/index.md)
