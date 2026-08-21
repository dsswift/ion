/**
 * Maximum simultaneous session attach requests.
 *
 * The desktop shares one engine daemon. Bounded attach batches let the active
 * session become ready first without flooding the daemon during restore or
 * socket recovery.
 */
export const SESSION_ATTACH_BATCH_SIZE = 5
