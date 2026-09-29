/**
 * Bridged `host.shell` verbs, gitidentity domain: every one is served by a
 * `studio_action` or `studio_event` on every host (`browser-shell-bridge.ts`),
 * so the Electron preload no longer carries it. Moved verbatim from the
 * preload's `ionapi-git-identity.ts` (spec 12: `IonAPI` shrinks toward the natives and the
 * host relay, `ShellApi` keeps the full surface).
 */
import type { GitIdentitySummary } from "@ion/shared/types-git-identity";

export interface BridgedGitIdentityShell {
  gitIdentityList(): Promise<GitIdentitySummary[]>;
  gitIdentityMintSshKey(host: string): Promise<{ publicKey: string }>;
  gitIdentitySetSshKey(host: string, privateKey: string): Promise<{ publicKey: string }>;
  gitIdentitySetToken(host: string, token: string, username?: string): Promise<void>;
  gitIdentityRemove(host: string): Promise<{ removed: boolean }>;
  /** Broadcasts the GitLab/GitHub authorize URL via ion:open-auth-url for an attached client to open; the exchange completes at the server's /auth/git/callback route. */
  gitIdentityAuthorize(host: string): Promise<void>;
}
