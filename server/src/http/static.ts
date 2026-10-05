/**
 * `GET /*` static route for the browser build (manifest child 11, spec
 * "Static route" requirement). Behind `server.json.web.enabled`: when true,
 * serves `server/web/` (the precompressed renderer bundle child 18 builds)
 * with `.br`/`.gz` sibling negotiation and asset-hash-aware caching; when
 * false, `/` refuses with `{ "error": "web_disabled" }`.
 *
 * Wired into `startHealth`'s `notFound` fallback (`http/health.ts`) rather
 * than a second `http.Server`, matching `auth-config.ts`/`auth-pair.ts`'s
 * existing pattern of reusing the same TCP/local-socket listeners -- the only
 * difference is this route answers every unmatched path instead of one exact
 * one, since a static bundle has many asset paths under `/`.
 */
import { existsSync, statSync, createReadStream } from 'fs'
import { dirname, extname, join, normalize, sep } from 'path'
import { fileURLToPath } from 'url'
import type { IncomingMessage, ServerResponse } from 'http'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('static-route', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('static-route', msg, fields)
}

/**
 * The web bundle, resolved two directories above THIS module's own file.
 * esbuild's ESM output preserves one real `import.meta.url` per bundle (the
 * bundle file itself), so the answer depends on which file runs:
 *
 * - from source, `src/http/static.ts`: `src/http/../../web`, i.e. `server/web`,
 *   where `npm -w desktop run build:web` writes it;
 * - from the bundle, `server/dist/main.js`: `dist/../../web`, one level above
 *   `server/`. The server image copies the bundle there (`/app/web` beside
 *   `/app/server`). A bundle run from a checkout finds no web directory there
 *   and logs that it is missing.
 */
function defaultWebDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** Filenames with an 8+ hex-char content hash segment get the immutable long-lived cache header (manifest requirement). */
const HASHED_ASSET_RE = /\.[0-9a-f]{8,}\./i

function contentTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * A content-hashed asset is immutable forever; everything else -- above all
 * `index.html` -- must never be stored.
 *
 * `no-cache` was not strong enough. It permits a cache to STORE the response
 * and merely requires revalidation, which a CDN configured to cache HTML
 * happily ignores. The consequence is specific and severe for a hashed-asset
 * build: the entry document names the exact bundle filenames for its own
 * build, so a stale `index.html` hands every browser an older client than the
 * server is running. That was observed live -- the edge served an
 * `index.html` pointing at one bundle while the origin served another, so
 * every web client ran old code and every fix looked like it had regressed.
 *
 * `no-store` is the directive that says do not keep a copy at all. It costs
 * nothing here: the entry document is small, and the hashed assets it names
 * still carry the immutable header that makes repeat loads free.
 */
function cacheControlFor(path: string): string {
  return HASHED_ASSET_RE.test(path)
    ? 'public, max-age=31536000, immutable'
    : 'no-store, no-cache, must-revalidate'
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** True for a regular file that exists and is readable-as-a-file (not a directory). */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Resolves `urlPath` (already stripped of query string) to an absolute path
 * inside `webDir`, or null when the request maps outside `webDir` (path
 * traversal) or `urlPath` is the root/a directory (served as `index.html`).
 */
function resolveRequestedPath(webDir: string, urlPath: string, indexFile: string): string | null {
  const decoded = decodeURIComponent(urlPath)
  const relative = decoded === '/' || decoded === '' ? indexFile : decoded.replace(/^\/+/, '')
  const resolved = normalize(join(webDir, relative))
  if (resolved !== webDir && !resolved.startsWith(webDir + sep)) {
    warn('static request resolved outside web dir; refusing', { url_path: urlPath })
    return null
  }
  return resolved
}

/**
 * Streams `file` (or its `.br`/`.gz` sibling, whichever `Accept-Encoding`
 * allows and exists) to `res` with the appropriate `Content-Type`,
 * `Content-Encoding`, and `Cache-Control`.
 */
function serveFile(req: IncomingMessage, res: ServerResponse, file: string): void {
  const acceptEncoding = req.headers['accept-encoding'] ?? ''
  const contentType = contentTypeFor(file)
  const cacheControl = cacheControlFor(file)

  if (typeof acceptEncoding === 'string' && acceptEncoding.includes('br') && isFile(`${file}.br`)) {
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Encoding': 'br', 'Cache-Control': cacheControl, Vary: 'Accept-Encoding' })
    createReadStream(`${file}.br`).pipe(res)
    return
  }
  if (typeof acceptEncoding === 'string' && acceptEncoding.includes('gzip') && isFile(`${file}.gz`)) {
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Encoding': 'gzip', 'Cache-Control': cacheControl, Vary: 'Accept-Encoding' })
    createReadStream(`${file}.gz`).pipe(res)
    return
  }
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl })
  createReadStream(file).pipe(res)
}

export interface StaticRouteOptions {
  /** `server.json.web.enabled`. */
  enabled: boolean
  /** Overrides `defaultWebDir()`. Test seam. */
  webDir?: string
  /** The page `/` and an unresolved path are served. Default `index.html`. */
  indexFile?: string
}

/**
 * Builds the `notFound` fallback handler for `startHealth` (manifest child
 * 11 static route). Never throws -- every branch either serves a file or
 * writes a JSON error response.
 */
export function staticRoute(opts: StaticRouteOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const webDir = opts.webDir ?? defaultWebDir()
  const indexFile = opts.indexFile ?? 'index.html'
  let loggedMissing = false

  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!opts.enabled) {
      writeJson(res, 404, { error: 'web_disabled' })
      return
    }

    if (!existsSync(webDir)) {
      if (!loggedMissing) {
        warn('web.enabled is true but the web bundle directory does not exist on disk', { web_dir: webDir })
        loggedMissing = true
      }
      writeJson(res, 404, { error: 'web_missing' })
      return
    }

    const urlPath = (req.url ?? '/').split('?')[0] ?? '/'
    const resolved = resolveRequestedPath(webDir, urlPath, indexFile)
    if (!resolved) {
      writeJson(res, 404, { error: 'not_found' })
      return
    }

    if (isFile(resolved)) {
      serveFile(req, res, resolved)
      return
    }

    // SPA fallback: an unresolved deep-link path (client-side routing) is
    // served index.html when it exists, matching every other static SPA
    // host's default behavior. A genuinely missing bundle (index.html itself
    // absent) falls through to the 404 below.
    const indexPath = join(webDir, indexFile)
    if (isFile(indexPath)) {
      log('static request fell back to index.html (SPA route)', { url_path: urlPath })
      serveFile(req, res, indexPath)
      return
    }

    writeJson(res, 404, { error: 'not_found' })
  }
}
