/**
 * The built-in Studio browser tool set.
 *
 * A thin composition module: each family lives in its own file, and this is the
 * single list the desktop executes from. Declaring and executing from ONE
 * array is still the rule — an advertised tool that cannot run is worse than a
 * missing one, because the model discovers it only by failing — but the array
 * is now assembled from two halves joined by name:
 *
 * - DECLARATIONS (`name`, `description`, `inputSchema`, `planModeSafe`) come
 *   from the server package, `server/src/studio-playwright/tool-declarations.ts`,
 *   because the Ion Studio server is what advertises the set to the engine and
 *   it runs without Electron.
 * - BODIES (`name`, `execute`) come from the four `tools-*.ts` files beside
 *   this one, because only the desktop has a Playwright-driven `BrowserView`
 *   to run them against.
 *
 * The join is checked at module load: a declaration with no body, or a body
 * with no declaration, throws before anything can be advertised. That is the
 * mechanism that keeps "one array" true across two packages.
 *
 * The declarations are imported through `tool-contracts`, not from
 * `tool-declarations` directly, because `tool-contracts` is the one
 * `studio-playwright` path in the desktop's server-import allowlist
 * (`scripts/check-server-parity.sh`).
 *
 * `browser_run_code_unsafe` is intentionally absent. Upstream it evaluates
 * arbitrary JavaScript in the Playwright server process; in Ion that process is
 * the desktop main process, so it would be an RCE surface reachable from a
 * model. `browser_evaluate` covers the legitimate need inside the page sandbox.
 */
import type { StudioBrowserTool, StudioBrowserToolBody } from '@ion/server/studio-playwright/tool-contracts'
import { STUDIO_BROWSER_TOOL_DECLARATIONS } from '@ion/server/studio-playwright/tool-contracts'
import { navigationBodies } from './tools-navigation'
import { interactionBodies } from './tools-interaction'
import { inspectionBodies } from './tools-inspection'
import { diagnosticBodies } from './tools-diagnostics'

export type { BrowserToolContext, BrowserToolResult, StudioBrowserTool, StudioBrowserToolBody } from '@ion/server/studio-playwright/tool-contracts'

/** Every execute body the desktop ships, in the same family order as the declarations. */
export const STUDIO_BROWSER_TOOL_BODIES: StudioBrowserToolBody[] = [
  ...navigationBodies,
  ...interactionBodies,
  ...inspectionBodies,
  ...diagnosticBodies,
]

/** Body lookup by name. */
export function studioBrowserToolBody(name: string): StudioBrowserToolBody | undefined {
  return STUDIO_BROWSER_TOOL_BODIES.find((body) => body.name === name)
}

/**
 * Join declarations to bodies by name, refusing to load on any mismatch.
 *
 * Both directions are checked. A declaration without a body would be
 * advertised and then fail on every call; a body without a declaration would
 * be unreachable dead code that nobody notices. Neither is allowed to ship.
 */
function joinDeclarationsToBodies(): StudioBrowserTool[] {
  const bodiesByName = new Map<string, StudioBrowserToolBody>()
  for (const body of STUDIO_BROWSER_TOOL_BODIES) {
    if (bodiesByName.has(body.name)) {
      throw new Error(`studio-playwright: duplicate execute body for browser tool "${body.name}"`)
    }
    bodiesByName.set(body.name, body)
  }

  const declaredNames = new Set<string>()
  const joined: StudioBrowserTool[] = []
  for (const declaration of STUDIO_BROWSER_TOOL_DECLARATIONS) {
    if (declaredNames.has(declaration.name)) {
      throw new Error(`studio-playwright: duplicate declaration for browser tool "${declaration.name}"`)
    }
    declaredNames.add(declaration.name)
    const body = bodiesByName.get(declaration.name)
    if (!body) {
      throw new Error(
        `studio-playwright: browser tool "${declaration.name}" is declared in ` +
        'server/src/studio-playwright/tool-declarations.ts but has no execute body in desktop/src/main/studio-playwright/tools-*.ts',
      )
    }
    joined.push({ ...declaration, execute: body.execute })
  }

  const orphans = STUDIO_BROWSER_TOOL_BODIES.filter((body) => !declaredNames.has(body.name)).map((body) => body.name)
  if (orphans.length > 0) {
    throw new Error(
      `studio-playwright: execute bodies with no declaration in server/src/studio-playwright/tool-declarations.ts: ${orphans.join(', ')}`,
    )
  }
  return joined
}

export const STUDIO_PLAYWRIGHT_TOOLS: StudioBrowserTool[] = joinDeclarationsToBodies()

/** Tool lookup by name, used by the responder to execute exactly what it advertised. */
export function studioBrowserTool(name: string): StudioBrowserTool | undefined {
  return STUDIO_PLAYWRIGHT_TOOLS.find((tool) => tool.name === name)
}
