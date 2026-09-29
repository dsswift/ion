/**
 * The bundle script names its entry points as literal paths, so a source file
 * that is deleted without editing `scripts/build.mjs` breaks `npm run build`
 * and nothing else — typecheck, lint and the unit suite all stay green,
 * because none of them read the script. This pins each named entry to a real
 * file. (The transport crypto worker was removed with the rest of the device
 * transport and its entry was left behind, failing the desktop package build
 * with "Could not resolve .../transport-crypto-worker.ts".)
 *
 * The Studio Server packager names the same outputs a second time, as the
 * files it requires in server/dist, so the two lists are pinned to each other.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoRoot = join(serverRoot, '..')
const buildScript = readFileSync(join(serverRoot, 'scripts', 'build.mjs'), 'utf-8')

describe('scripts/build.mjs', () => {
  it('names only entry points that exist on disk', () => {
    const entries = [...buildScript.matchAll(/entryPoints:\s*\[join\(root,\s*'([^']+)'\)\]/g)].map((m) => m[1])

    expect(entries.length).toBeGreaterThan(0)
    const missing = entries.filter((rel) => !existsSync(join(serverRoot, rel)))
    expect(missing).toEqual([])
  })

  it('emits exactly the dist files the Studio Server packager requires', () => {
    const outfiles = [...buildScript.matchAll(/outfile:\s*join\(root,\s*'([^']+)'\)/g)].map((m) => basename(m[1]))
    const packager = readFileSync(join(repoRoot, 'scripts', 'package-studio-server.sh'), 'utf-8')
    const required = packager.match(/^for f in ([^;]+); do\n\s*\[ -f "server\/dist\/\$f" \]/m)

    expect(required).not.toBeNull()
    expect(required![1].trim().split(/\s+/).sort()).toEqual(outfiles.sort())
  })
})
