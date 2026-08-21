/**
 * remote-projection-global — the window-global name through which the OWNER
 * renderer publishes its canonical remote-snapshot projection.
 *
 * Both processes need this string and neither may hardcode its own copy: the
 * renderer assigns the global (stores/remote-projection-push.ts) and the main
 * process's fallback poll reads it inside an executeJavaScript string
 * (main/remote/snapshot-renderer-poll.ts). Two hand-written copies of one
 * name is the same drift trap that produced the flapping iOS Inbox — a
 * rename on one side would make the fallback silently return an empty payload
 * on every tick, which reads as "renderer not mounted" rather than as a bug.
 *
 * Lives in shared/ (not renderer/ or main/) because the main process must not
 * import renderer modules: remote-projection-push.ts pulls in the session
 * store, zustand, and the whole preferences graph.
 */

/**
 * Name of the window property holding a zero-argument function that returns
 * the current RemoteTabStatesPayload. Set by the overlay renderer only; the
 * Studio mirror never publishes it (the owner is the single answerer for
 * snapshot state).
 */
export const PROJECTION_GLOBAL = '__Ion_REMOTE_PROJECTION__'
