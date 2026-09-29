/**
 * `GET /auth/git/callback?provider=gitlab|github&code=...&state=...` --
 * FR-04's GitLab/GitHub OAuth exchange completion. Mirrors
 * `auth-browser-login.ts`'s `/auth/callback` shape, but there is no
 * resulting Studio session here: the outcome is a stored git credential
 * (`credential-store.ts`), and the page just tells the person to return to
 * the tab they started from -- there is nothing to redirect them back INTO,
 * since `gitIdentity.authorize` opened this as a new tab via
 * `ion:open-auth-url`, not a navigation away from Studio.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import type { ServerGitConfig } from '../config/server-config'
import { completeGitlabAuthorize } from '../git/identity/sources/exchange-gitlab'
import { completeGithubAuthorize } from '../git/identity/sources/exchange-github'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('auth-git-callback-route', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('auth-git-callback-route', msg, fields)
}

function writeHtml(res: ServerResponse, status: number, message: string): void {
  const body = `<!doctype html><html><body style="font-family: system-ui, sans-serif; padding: 2rem;"><p>${message}</p><p>You can close this tab and return to Ion Studio.</p></body></html>`
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

/** Builds the `GET /auth/git/callback` route handler. */
export function authGitCallbackRoute(getGit: () => ServerGitConfig): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? '/auth/git/callback', 'http://placeholder')
    const provider = url.searchParams.get('provider')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state || (provider !== 'gitlab' && provider !== 'github')) {
      warn('callback refused: missing code/state or unknown provider', { provider })
      writeHtml(res, 400, 'This authorization link is missing required parameters.')
      return
    }

    const git = getGit()
    const origin = git.publicOrigin

    const completion = provider === 'gitlab'
      ? (git.exchange.gitlab ? completeGitlabAuthorize(git.exchange.gitlab, { origin, code, state }) : Promise.resolve({ ok: false as const, reason: 'not_configured' }))
      : (git.exchange.github ? completeGithubAuthorize(git.exchange.github, { origin, code, state }) : Promise.resolve({ ok: false as const, reason: 'not_configured' }))

    completion
      .then((result) => {
        if (!result.ok) {
          warn('callback refused', { provider, reason: result.reason })
          writeHtml(res, 400, `Authorization could not be completed (${result.reason}).`)
          return
        }
        log('callback accepted; credential stored', { provider, subject: result.subject, git_host: result.host })
        writeHtml(res, 200, `Connected to ${result.host}.`)
      })
      .catch((err: unknown) => {
        warn('callback refused: unexpected error', { provider, error: String(err) })
        writeHtml(res, 500, 'An unexpected error occurred completing authorization.')
      })
  }
}
