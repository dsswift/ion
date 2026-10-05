/**
 * Builders for `ion://` links, and the `https` form a Studio server serves.
 *
 * One builder per route, so a link a client copies is always one the
 * server's parser (`server/src/deeplink/parse.ts`) accepts; the parser's
 * tests round-trip every builder here.
 *
 * The `https` form is `<server origin>/open/<route>?<same query>`. It opens
 * the browser build of Studio, which rebuilds the `ion://` URL from it with
 * `ionUrlFromOpenPath` and opens it the same way any other client does.
 */

export const ION_SCHEME = 'ion'
/** Path prefix of the `https` form. */
export const OPEN_PATH_PREFIX = '/open/'

function build(route: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value)
  }
  const qs = query.toString()
  return `${ION_SCHEME}://${route}${qs ? `?${qs}` : ''}`
}

/** Open a conversation. */
export function conversationLink(conversationId: string): string {
  return build('conversation', { id: conversationId })
}

/** Open a settings page or section by its id in the settings taxonomy. */
export function settingsLink(panel: string): string {
  return build('settings', { panel })
}

/** Open a file. `path` is absolute or relative to `dir`, and must stay inside it. */
export function fileLink(dir: string, path: string): string {
  return build('file', { dir, path })
}

/**
 * A file link for an absolute path. `root` (a conversation's working
 * directory) is the link's dir when the file is inside it, so the link reads
 * as a project path; otherwise the file's own directory is used. Either way
 * the path stays inside dir, which the server requires.
 */
export function fileLinkForPath(filePath: string, root?: string | null): string {
  const base = root ? root.replace(/\/+$/, '') : ''
  if (base && filePath.startsWith(`${base}/`)) return fileLink(base, filePath)
  const slash = filePath.lastIndexOf('/')
  return fileLink(slash > 0 ? filePath.slice(0, slash) : '/', filePath)
}

/** Start a conversation in `dir` with `text` (submitted unless `submit` is false). */
export function promptLink(dir: string, text: string, submit = true): string {
  return build('prompt', { dir, text, submit: submit ? undefined : 'false' })
}

/** Run an extension's registered link route. */
export function extLink(routeId: string, opts: { args?: string; conversationId?: string; dir?: string } = {}): string {
  return build(`ext/${encodeURIComponent(routeId)}`, { args: opts.args, conversation: opts.conversationId, dir: opts.dir })
}

/**
 * The `https` form of an `ion://` URL, served by the Studio server at
 * `origin`. Returns null for anything that is not an `ion://` URL.
 */
export function httpsLink(ionUrl: string, origin: string): string | null {
  const prefix = `${ION_SCHEME}://`
  if (!ionUrl.startsWith(prefix)) return null
  const rest = ionUrl.slice(prefix.length)
  return `${origin.replace(/\/+$/, '')}${OPEN_PATH_PREFIX}${rest}`
}

/**
 * Rebuild the `ion://` URL from a browser location's path and query, or null
 * when the path is not an `/open/<route>` link.
 */
export function ionUrlFromOpenPath(pathname: string, search: string): string | null {
  if (!pathname.startsWith(OPEN_PATH_PREFIX)) return null
  const route = pathname.slice(OPEN_PATH_PREFIX.length)
  if (!route) return null
  return `${ION_SCHEME}://${route}${search}`
}
