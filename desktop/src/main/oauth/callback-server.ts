import { createServer, Server, IncomingMessage, ServerResponse } from 'http'
import { log as _log } from '../logger'

function log(msg: string): void { _log('oauth', msg) }

export interface CallbackResult {
  code: string
  state: string
}

export interface CallbackServer {
  close(): void
  cancelWait(): void
  waitForCode(): Promise<CallbackResult | null>
}

/**
 * Start a local HTTP callback server on the given port for OAuth redirect.
 * Validates the state parameter and extracts the authorization code.
 */
export function startCallbackServer(port: number, expectedState: string): Promise<CallbackServer> {
  let resolveWait: ((result: CallbackResult | null) => void) | undefined
  let settled = false
  const waitPromise = new Promise<CallbackResult | null>((resolve) => {
    resolveWait = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
  })

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || '', `http://localhost:${port}`)
      if (!url.pathname.includes('callback')) {
        res.statusCode = 404
        res.end('Not found')
        return
      }
      const state = url.searchParams.get('state')
      if (state !== expectedState) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/html')
        res.end('<html><body><h2>State mismatch</h2><p>Please try again.</p></body></html>')
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/html')
        res.end('<html><body><h2>Missing authorization code</h2></body></html>')
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html')
      res.end('<html><body><h2>Authentication successful!</h2><p>You can close this window.</p></body></html>')
      resolveWait?.({ code, state })
    } catch {
      res.statusCode = 500
      res.end('Internal error')
    }
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      log(`Callback server listening on port ${port}`)
      resolve({
        close: () => { server.close(); log('Callback server closed') },
        cancelWait: () => resolveWait?.(null),
        waitForCode: () => waitPromise,
      })
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      log(`Callback server error on port ${port}: ${err.code}`)
      resolveWait?.(null)
      resolve({
        close: () => { try { server.close() } catch { /* ignore */ } },
        cancelWait: () => {},
        waitForCode: async () => null,
      })
    })
  })
}
