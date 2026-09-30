#!/usr/bin/env node
/**
 * host-surface-audit — the whole `host.shell` surface, classified.
 *
 * Ion Studio Server moved the desktop's main-process store into `@ion/server`,
 * which made the renderer bundle run in two places: inside Electron, where
 * `host.shell` is the preload bridge to the local machine, and inside a plain
 * browser tab, where there is no preload and every call must either cross the
 * studio wire or be refused.
 *
 * Whether each verb got that treatment was tracked by hand, in a capability
 * list and a bridge table that nothing compared against the code. They drifted,
 * and the drift is invisible: an over-claimed capability opens a gate in front
 * of a call that cannot work, and an ungated call throws on click. Both look
 * exactly like a feature that was never finished.
 *
 * So this reads the code instead of a list. It answers, for every verb the
 * preload exposes:
 *
 *   - does the renderer call it, and where
 *   - is it bridged to a `studio_action`, and does the server register one
 *   - what capability (if any) guards its call sites
 *   - does a browser client hold that capability
 *
 * and classifies the result. `BROKEN_*` rows are defects: a browser reaching
 * that call gets a thrown refusal. Run with `--json` for the raw rows, or with
 * no argument for a markdown table; counts go to stderr either way.
 *
 * The output is NOT committed. It is a point-in-time classification derived
 * entirely from tracked source, so a checked-in copy is stale on the next
 * commit that adds a verb or moves a gate — the same lie-to-the-future this
 * script exists to catch, one level up. `audit-out/` is gitignored if you want
 * to keep a run around:
 *
 *   node scripts/host-surface-audit.mjs > audit-out/host-surface.md
 *
 * What IS durable lives in two places: this file, which explains the
 * classification, and `host-surface-no-gaps.test.ts`, which fails the build on
 * any `BROKEN_*` row. Neither can go stale, because both are read by a run.
 *
 * The gating column is file-scoped: a call site counts as guarded when its own
 * file checks a capability. That is how the real gates are written (a hoisted
 * `const graphDirect = …`, or an early return well above the call), and a
 * line-window scan produced false results in both directions. It can still
 * over-credit a file that guards one call and not its neighbour, so
 * `BROKEN_*` rows are the reliable output and `GATED` rows are a claim to
 * confirm by reading.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const DESKTOP = join(ROOT, 'desktop', 'src')
const SERVER = join(ROOT, 'server', 'src')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue
      walk(p, out)
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(p)
    }
  }
  return out
}

/** Comments carry verb names in prose; scanning them invents call sites that do not exist. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// ── The `host.shell` surface ───────────────────────────────────────────────
// The preload (natives and the host relay) plus the bridged shell interfaces
// (`renderer/host/shell-api*.ts`), which carry every verb the Studio server
// serves over the wire. Together they are `ShellApi`.
const preloadVerbs = new Set()
const surfaceFiles = [
  ...walk(join(DESKTOP, 'preload')),
  ...walk(join(DESKTOP, 'renderer', 'host')).filter((f) => /shell-api[^/]*\.ts$/.test(f)),
]
for (const file of surfaceFiles) {
  const src = stripComments(readFileSync(file, 'utf8'))
  for (const m of src.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\s*[:(]/gm)) preloadVerbs.add(m[1])
}

// ── What the browser bridge carries, and to which server action ────────────
// Both halves of the table: `browser-shell-bridge.ts` holds SHELL_INVOKE,
// `browser-shell-subscribe.ts` holds SHELL_SUBSCRIBE. Reading only the first
// classes every `on*` listener as unbridged.
const bridgeSrc = ['browser-shell-bridge.ts', 'browser-shell-subscribe.ts']
  .map((f) => readFileSync(join(DESKTOP, 'renderer', 'host', f), 'utf8'))
  .join('\n')
const bridged = new Map()
for (const m of stripComments(bridgeSrc).matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*):\s*\{([^}]*)\}/gm)) {
  const action = /action:\s*'([^']+)'/.exec(m[2])?.[1]
  const channel = /channel:\s*'([^']+)'/.exec(m[2])?.[1]
  bridged.set(m[1], { action: action ?? null, channel: channel ?? null })
}

// ── What the server actually registers ─────────────────────────────────────
const serverActions = new Set()
for (const file of walk(SERVER)) {
  const src = stripComments(readFileSync(file, 'utf8'))
  // Action names carry one or more dot segments (`git.status`, `worktree.overlap.apply`).
  for (const m of src.matchAll(/^\s{2,4}'([a-z][a-zA-Z]*(?:\.[a-zA-Z]+)+)'\s*:/gm)) serverActions.add(m[1])
  for (const m of src.matchAll(/^\s{2,4}([a-z][a-zA-Z]*):\s*\{[^}]*handler/gm)) serverActions.add(m[1])
}

// ── What a browser client claims it can do ─────────────────────────────────
const browserHostSrc = readFileSync(join(DESKTOP, 'renderer', 'host', 'BrowserStudioHost.ts'), 'utf8')
const browserCaps = new Set()
const capBlock = /const CAPABILITIES: Capability\[\] = \[([\s\S]*?)\]/.exec(browserHostSrc)?.[1] ?? ''
for (const m of stripComments(capBlock).matchAll(/'([a-zA-Z]+)'/g)) browserCaps.add(m[1])
const claimBlock = /BRIDGED_CAPABILITIES: readonly string\[\] = \[([\s\S]*?)\]/.exec(bridgeSrc)?.[1] ?? ''
for (const m of stripComments(claimBlock).matchAll(/'([a-zA-Z]+)'/g)) browserCaps.add(m[1])

// ── Where the renderer calls each verb, and what its file gates on ─────────
const callSites = new Map()
/** Uses inside a host implementation: the seam's own two halves, not renderer call sites. */
const hostImplUses = new Map()
const fileGates = new Map()
/**
 * The two host implementations are excluded from the call-site scan. Every
 * `this.shell.x` inside `ElectronStudioHost` IS the Electron half of a host
 * seam, reached only when `window.ion` exists — counting them as renderer call
 * sites reports the seam itself as an unguarded gap, which is backwards.
 */
const HOST_IMPLS = /host[/\\](ElectronStudioHost|BrowserStudioHost)\.ts$/

for (const file of walk(join(DESKTOP, 'renderer'))) {
  const src = stripComments(readFileSync(file, 'utf8'))
  const gates = new Set()
  // Both quote styles: the renderer is not consistent, and a scan that sees
  // only one of them silently reports a guarded call site as unguarded.
  for (const m of src.matchAll(/capabilities\(\)\s*\.\s*includes\(\s*['"]([a-zA-Z]+)['"]/g)) gates.add(m[1])
  fileGates.set(file, gates)
  const isHostImpl = HOST_IMPLS.test(file)
  // `.preload.` as well as `.shell.`: ElectronStudioHost reaches the raw
  // bridge through `this.preload` now that `this.shell` is the wire-routed
  // proxy. Scanning only `.shell.` would report the seam's own Electron half
  // as a verb nothing calls -- an invitation to delete working code.
  const verbPattern = isHostImpl ? /\.(?:shell|preload)\s*\.\s*([a-zA-Z][a-zA-Z0-9]*)/g : /\.shell\s*\.\s*([a-zA-Z][a-zA-Z0-9]*)/g
  for (const m of src.matchAll(verbPattern)) {
    if (!preloadVerbs.has(m[1])) continue
    const bucket = isHostImpl ? hostImplUses : callSites
    if (!bucket.has(m[1])) bucket.set(m[1], [])
    bucket.get(m[1]).push(file)
  }
}

/**
 * Host plumbing: `BrowserStudioHost` implements these itself rather than
 * routing them anywhere, so "unbridged" is the correct state, not a gap.
 */
const PLUMBING = /^(host[A-Z]|onHost|logWrite$|platform$|on$|off$|onEvent$|openExternal$)/

/**
 * Guards that do not live in the calling file.
 *
 * Two real patterns defeat a file-scoped gate scan: a surface gated once at
 * the choke point that renders it (the Visualizer tab, the browser tab), and
 * a whole renderer entry that the web bundle never loads (the
 * worktree-overlap window's one native context read). A third used to: a
 * bridge forked by host at boot rather than guarded at the call (the mirror
 * syncs, now bridged).
 *
 * Each entry therefore names the ANCHOR that makes the claim true, and the
 * anchor is re-verified on every run. This is deliberately not an allowlist:
 * delete the choke-point gate and the anchor stops matching, and the verb
 * returns to the broken list on the next run rather than staying silently
 * exempt. That is the failure mode this whole script exists to catch, so it
 * must not be reintroduced by the script's own exemptions.
 */
const RESOLVED_ELSEWHERE = {
  choke: {
    reason: 'gated once at the choke point that renders this surface',
    verbs: [
      'studioBrowserViewEnsure', 'studioBrowserViewNavigate', 'studioBrowserViewAction',
      'studioBrowserViewBounds', 'studioBrowserViewClose', 'onStudioBrowserViewState',
      'studioBrowserSetNetworkShield', 'studioBrowserSetSessionMode', 'studioPreviewAllowNetwork',
      'studioBrowserFind', 'onStudioBrowserFindResult', 'studioBrowserSetZoom', 'onStudioBrowserShortcut',
      'onStudioBrowserPrompt', 'studioBrowserPromptAnswer',
    ],
    anchors: [
      ['desktop/src/renderer/studio/surface/SurfacePanel.tsx', "includes('browser')"],
    ],
  },
  otherEntry: {
    reason: 'lives in a renderer entry the web bundle never loads',
    // The overlap window's one native read: which repository it was opened
    // for. Everything it does with that context is a bridged verb.
    verbs: ['getWorktreeOverlapContext'],
    anchors: [['desktop/src/renderer/web-main.tsx', '!worktree-overlap']],
  },
}

const resolvedBy = new Map()
const anchorFailures = []
for (const [key, group] of Object.entries(RESOLVED_ELSEWHERE)) {
  let ok = true
  for (const [file, pattern] of group.anchors) {
    const negate = pattern.startsWith('!')
    const needle = negate ? pattern.slice(1) : pattern
    let src = ''
    try { src = readFileSync(join(ROOT, file), 'utf8') } catch { ok = false; anchorFailures.push(`${key}: ${file} is gone`); continue }
    const found = src.includes(needle)
    if (negate ? found : !found) {
      ok = false
      anchorFailures.push(`${key}: ${file} no longer ${negate ? 'excludes' : 'contains'} ${needle}`)
    }
  }
  if (ok) for (const v of group.verbs) resolvedBy.set(v, `${key}: ${group.reason}`)
}

const rows = []
for (const verb of [...preloadVerbs].sort()) {
  const sites = [...new Set(callSites.get(verb) ?? [])]
  const bridge = bridged.get(verb)
  const gates = new Set()
  for (const f of sites) for (const g of fileGates.get(f) ?? []) gates.add(g)
  const gateList = [...gates]
  // A gate only protects a browser when the browser LACKS the capability.
  const effectiveGate = gateList.filter((g) => !browserCaps.has(g))

  const implSites = [...new Set(hostImplUses.get(verb) ?? [])]
  let cls
  // A verb reached only through a host implementation is that seam's Electron
  // half. Calling it UNUSED would invite deleting working code.
  if (sites.length === 0 && implSites.length > 0) cls = 'HOST_PLUMBING'
  else if (sites.length === 0) cls = 'UNUSED'
  else if (PLUMBING.test(verb)) cls = 'HOST_PLUMBING'
  else if (bridge) cls = bridge.action && !serverActions.has(bridge.action) ? 'BROKEN_NO_SERVER_ACTION' : 'BRIDGED'
  else if (effectiveGate.length > 0) cls = 'GATED'
  else if (resolvedBy.has(verb)) cls = 'RESOLVED_ELSEWHERE'
  else if (gateList.length > 0) cls = 'BROKEN_OVERCLAIMED_GATE'
  else cls = 'BROKEN_UNGATED'

  rows.push({
    verb,
    class: cls,
    bridgedTo: bridge?.action ?? bridge?.channel ?? '',
    gates: gateList.join(' ') || (resolvedBy.get(verb) ?? ''),
    browserHasGate: gateList.filter((g) => browserCaps.has(g)).join(' '),
    sites: (sites.length > 0 ? sites : implSites).map((f) => relative(ROOT, f)),
  })
}

const order = ['BROKEN_UNGATED', 'BROKEN_OVERCLAIMED_GATE', 'BROKEN_NO_SERVER_ACTION', 'GATED', 'RESOLVED_ELSEWHERE', 'BRIDGED', 'HOST_PLUMBING', 'UNUSED']
rows.sort((a, b) => order.indexOf(a.class) - order.indexOf(b.class) || a.verb.localeCompare(b.verb))

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ browserCaps: [...browserCaps].sort(), rows }, null, 2) + '\n')
} else {
  const counts = {}
  for (const r of rows) counts[r.class] = (counts[r.class] ?? 0) + 1
  const out = []
  out.push('| Verb | Class | Bridged to | Gates in call-site files | Gate the browser already holds | Call sites |')
  out.push('|---|---|---|---|---|---|')
  for (const r of rows) {
    out.push(`| \`${r.verb}\` | ${r.class} | ${r.bridgedTo || '—'} | ${r.gates || '—'} | ${r.browserHasGate || '—'} | ${r.sites.join('<br>') || '—'} |`)
  }
  process.stdout.write(out.join('\n') + '\n\n')
  if (anchorFailures.length > 0) process.stderr.write('ANCHOR FAILURES (exemptions no longer hold):\n  ' + anchorFailures.join('\n  ') + '\n')
  process.stderr.write(Object.entries(counts).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n')
}
