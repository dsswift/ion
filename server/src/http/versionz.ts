/**
 * `GET /versionz` — what this running Studio server and its engine speak:
 * versions, the engine minimum, the host app, and every Format Version.
 * Nothing in it is secret, so like `/healthz` it needs no credential; `ion
 * studio status` reads it on the host, and `ion fleet` compares hosts with it.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import { buildVersionReport, type EngineRequester } from '../compat/runtime'
import { warn as _warn } from '../logger'

export function versionzRoute(engine: EngineRequester): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    buildVersionReport(engine).then((report) => {
      const body = JSON.stringify(report)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    }).catch((err: unknown) => {
      _warn('versionz', 'version report failed', { error: String(err) })
      const body = JSON.stringify({ error: 'version_report_failed' })
      res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    })
  }
}
