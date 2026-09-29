/**
 * server-host-api-project-browser-stub — the Studio renderer's build-time
 * replacement for `server/src/store/host-api-project.ts`, which reads the
 * filesystem and cannot load in a sandboxed renderer.
 *
 * `runQuickTool` is a FORWARDED action, so the renderer never resolves a
 * project tool itself; the owning server does.
 */
export function resolveProjectQuickTool(..._args: unknown[]): Promise<null> {
  return Promise.resolve(null);
}
