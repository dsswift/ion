/**
 * The built-in Studio browser tool set.
 *
 * A thin composition module: each family lives in its own file, and this is the
 * single list the tool-gate responder advertises and executes from. Declaring
 * and executing from ONE array is deliberate — an advertised tool that cannot
 * run is worse than a missing one, because the model discovers it only by
 * failing.
 *
 * `browser_run_code_unsafe` is intentionally absent. Upstream it evaluates
 * arbitrary JavaScript in the Playwright server process; in Ion that process is
 * the desktop main process, so it would be an RCE surface reachable from a
 * model. `browser_evaluate` covers the legitimate need inside the page sandbox.
 */
import type { StudioBrowserTool } from './tool-contracts'
import { navigationTools } from './tools-navigation'
import { interactionTools } from './tools-interaction'
import { inspectionTools } from './tools-inspection'
import { diagnosticTools } from './tools-diagnostics'

export type { BrowserToolContext, BrowserToolResult, StudioBrowserTool } from './tool-contracts'

export const STUDIO_PLAYWRIGHT_TOOLS: StudioBrowserTool[] = [
  ...navigationTools,
  ...interactionTools,
  ...inspectionTools,
  ...diagnosticTools,
]

/** Tool lookup by name, used by the responder to execute exactly what it advertised. */
export function studioBrowserTool(name: string): StudioBrowserTool | undefined {
  return STUDIO_PLAYWRIGHT_TOOLS.find((tool) => tool.name === name)
}
