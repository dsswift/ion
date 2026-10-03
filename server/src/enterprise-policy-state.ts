/**
 * The enterprise policy this server last read from its engine. This module
 * has no Node-only import, so any module may read the policy from here.
 */
import type { EnterprisePolicy } from '@ion/shared/types-engine'

/**
 * Enterprise policy cache (D-004), read from the engine's
 * get_enterprise_policy blob at startup and after every engine reconnect.
 * `allowedModels` filters the model cache (`state.ts`) so the iOS snapshot
 * projection (availableModels) honors the same policy as every other client
 * (D-011 parity).
 */
export const enterprisePolicyCache = {
  policy: null as EnterprisePolicy | null,
  /**
   * The resolved new-conversation defaults policy (pre-D-004 single-policy
   * key). Populated at startup alongside `policy` and refreshed on every
   * sendSync fetch, so synchronous wire emitters can project it without an
   * RPC.
   */
  newConversationDefaults: null as {
    baseDirectory: string;
    engineProfileId: string;
    locked: boolean;
  } | null,
};
