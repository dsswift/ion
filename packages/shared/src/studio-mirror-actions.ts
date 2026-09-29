/**
 * studio-mirror-actions — re-export shim.
 *
 * The classification tables (`FORWARDED_ACTIONS`, `MIRROR_LOCAL_ACTIONS`) and
 * `validForwardedAction` moved to `studio-wire/actions.ts` (manifest contract
 * C3/C4, Ion Studio Server program child 07), which is also where the
 * `studio_action` scope registry (`ACTIONS`) now lives — one source of truth
 * for both the mirror-store classification and the Studio wire's scope
 * enforcement. This file stays so existing `@ion/shared/studio-mirror-actions`
 * imports (the desktop mirror store, `main/ipc/studio.ts`, the server store
 * slices) keep working unchanged.
 */
export {
  FORWARDED_ACTIONS,
  MIRROR_LOCAL_ACTIONS,
  validForwardedAction,
  type ForwardedActionSpec,
} from './studio-wire/actions'
