/**
 * Git identity IPC bridge. Split from api-request.ts for the same reason as
 * api-automation.ts. Typed `satisfies Partial<IonAPI>` so its signatures can
 * never drift from the single canonical declaration in ionapi-git-identity.ts.
 */
import type { IonAPI } from "./ionapi";

export const gitIdentityApi = {
} satisfies Partial<IonAPI>;
