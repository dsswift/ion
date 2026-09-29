/**
 * HostApi, project domain: what the store needs from a project's own
 * committed configuration. Split from `host-api-misc.ts` at the file-size cap.
 */
import type { ProjectQuickTool } from '@ion/shared/project-studio-config'
import { resolveProjectQuickTool as resolveFromConfig } from '../project-studio-config'

/**
 * A Project Quick Tool's command, read from the project's committed
 * `.ion/studio.json` and handed out only while the operator trusts that exact
 * tool list. Null otherwise.
 */
export function resolveProjectQuickTool(directory: string, storeToolId: string): Promise<ProjectQuickTool | null> {
  return resolveFromConfig(directory, storeToolId)
}
