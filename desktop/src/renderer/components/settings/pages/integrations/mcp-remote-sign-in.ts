/**
 * mcp-remote-sign-in -- authorize an MCP server that runs on another machine,
 * with the browser on this one.
 *
 * The server's own sign-in opens a browser on its machine and catches the
 * redirect on its own loopback port, which is useless to a person sitting at
 * a different computer. So this machine catches the redirect instead: a
 * listener here supplies the redirect URI, the server starts a sign-in the
 * caller finishes (`mcp.login` with `redirectUri`), the page opens here, and
 * the address the browser lands on goes back to the server
 * (`auth.completeSignIn`), which checks it and exchanges the code.
 */
import type { ShellApi } from '../../../../host/shell-api'
import { rInfo, rWarn } from '../../../../rendererLogger'

type SignInShell = Pick<ShellApi, 'oauthCallbackListen' | 'oauthCallbackAwait' | 'oauthCallbackCancel' | 'mcpLogin' | 'authCompleteSignIn'>

export type RemoteSignInResult = { ok: true } | { ok: false; error: string }

export async function signInFromThisMachine(
  shell: SignInShell,
  openUrl: (url: string) => Promise<boolean>,
  name: string,
): Promise<RemoteSignInResult> {
  const { id, redirectUri } = await shell.oauthCallbackListen()
  const abandon = (error: string): RemoteSignInResult => {
    rWarn('settings', 'mcp remote sign-in abandoned', { name, error })
    void shell.oauthCallbackCancel(id)
    return { ok: false, error }
  }
  try {
    const begin = await shell.mcpLogin(name, undefined, { redirectUri })
    if (!begin.ok || !begin.authorizationUrl || !begin.flowId) {
      return abandon(begin.error ?? `The server did not return a sign-in page for "${name}"`)
    }
    rInfo('settings', 'mcp remote sign-in started', { name, flow_id: begin.flowId })
    if (!(await openUrl(begin.authorizationUrl))) {
      return abandon('Could not open the sign-in page in your browser')
    }
    const callbackUrl = await shell.oauthCallbackAwait(id)
    const done = await shell.authCompleteSignIn({ flowId: begin.flowId, callbackUrl })
    if (!done.ok) return { ok: false, error: done.error ?? `The server could not finish the sign-in for "${name}"` }
    rInfo('settings', 'mcp remote sign-in finished', { name, flow_id: begin.flowId })
    return { ok: true }
  } catch (err) {
    void shell.oauthCallbackCancel(id)
    throw err
  }
}
