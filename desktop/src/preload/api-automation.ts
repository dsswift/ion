/**
 * Automation IPC bridge. Split from api-request.ts so the automation surface is
 * a cohesive module and neither file grows past the repo cap. Typed
 * `satisfies Partial<IonAPI>` so its signatures can never drift from the single
 * canonical declaration in ionapi-automation.ts.
 */
import type { IonAPI } from "./ionapi";

export const automationApi = {
} satisfies Partial<IonAPI>;
