/**
 * server-host-api-git-browser-stub -- the Studio renderer's build-time
 * replacement for `server/src/store/host-api-git.ts`.
 *
 * This file is the ONE seam every git/worktree/bench read or mutation in the
 * server package funnels through: real `git` subprocess execution, real
 * `.git` directory probes, real worktree provisioning, real bench assembly.
 * It is reachable from every renderer file that imports the session store
 * for its reactive selectors (spec 17: Studio renders against the server-
 * owned store), because a worktree/bench store slice calls these functions
 * directly rather than only through the studio-wire. The server is the one
 * process with a real filesystem and git binary; git/worktree/bench
 * mutations belong on the server side of the wire like every other
 * FORWARDED_ACTIONS mutation, never run for real inside a sandboxed
 * renderer.
 *
 * Every export below rejects (or, for the few non-Promise exports, throws)
 * with a clear message instead of running real I/O, so an accidental
 * renderer-side call fails loudly rather than crashing the bundle at build
 * time or hanging at runtime. TypeScript checks call sites against the REAL
 * file's types (module resolution for typechecking is untouched; only
 * Vite's bundler redirects here at build time), so this stub is intentionally
 * loosely typed -- it never needs to match the real file's exact signatures
 * for the build to be sound. Wired in via `electron.vite.config.ts`'s
 * renderer plugin, keyed on host-api-git.ts's resolved absolute path so
 * every relative import of it resolves here.
 */

function reject(name: string): Promise<never> {
  return Promise.reject(
    new Error(`${name}() cannot run in the Studio renderer -- git/worktree/bench operations are server-owned; route through a FORWARDED store action instead.`),
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitIsRepo(..._args: any[]): Promise<never> {
  return reject('gitIsRepo')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitChanges(..._args: any[]): Promise<never> {
  return reject('gitChanges')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitOpState(..._args: any[]): Promise<never> {
  return reject('gitOpState')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitRebaseAbort(..._args: any[]): Promise<never> {
  return reject('gitRebaseAbort')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitRebaseContinue(..._args: any[]): Promise<never> {
  return reject('gitRebaseContinue')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fsExists(..._args: any[]): Promise<never> {
  return reject('fsExists')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function worktreesOffered(..._args: any[]): Promise<never> {
  return reject('worktreesOffered')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeAdd(..._args: any[]): Promise<never> {
  return reject('gitWorktreeAdd')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeRegistration(..._args: any[]): Promise<never> {
  return reject('gitWorktreeRegistration')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeSetTitle(..._args: any[]): Promise<never> {
  return reject('gitWorktreeSetTitle')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeSeedTitle(..._args: any[]): Promise<never> {
  return reject('gitWorktreeSeedTitle')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeCloseTitleSeed(..._args: any[]): Promise<never> {
  return reject('gitWorktreeCloseTitleSeed')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeSetStage(..._args: any[]): Promise<never> {
  return reject('gitWorktreeSetStage')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeInventory(..._args: any[]): Promise<never> {
  return reject('gitWorktreeInventory')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeRetirePreview(..._args: any[]): Promise<never> {
  return reject('gitWorktreeRetirePreview')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeReprovision(..._args: any[]): Promise<never> {
  return reject('gitWorktreeReprovision')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeSync(..._args: any[]): Promise<never> {
  return reject('gitWorktreeSync')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeSyncAll(..._args: any[]): Promise<never> {
  return reject('gitWorktreeSyncAll')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeLandAndRetire(..._args: any[]): Promise<never> {
  return reject('gitWorktreeLandAndRetire')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeDiscard(..._args: any[]): Promise<never> {
  return reject('gitWorktreeDiscard')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gitWorktreeAppraise(..._args: any[]): Promise<never> {
  return reject('gitWorktreeAppraise')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyWorktreeOverlap(..._args: any[]): Promise<never> {
  return reject('applyWorktreeOverlap')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchList(..._args: any[]): Promise<never> {
  return reject('benchList')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchAddMember(..._args: any[]): Promise<never> {
  return reject('benchAddMember')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchRemoveMember(..._args: any[]): Promise<never> {
  return reject('benchRemoveMember')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchSetOrder(..._args: any[]): Promise<never> {
  return reject('benchSetOrder')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchUpdateMember(..._args: any[]): Promise<never> {
  return reject('benchUpdateMember')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchUpdateAll(..._args: any[]): Promise<never> {
  return reject('benchUpdateAll')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchAssemble(..._args: any[]): Promise<never> {
  return reject('benchAssemble')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchResolveConflict(..._args: any[]): Promise<never> {
  return reject('benchResolveConflict')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchRerereCount(..._args: any[]): Promise<never> {
  return reject('benchRerereCount')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchRerereForget(..._args: any[]): Promise<never> {
  return reject('benchRerereForget')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchRerereDiscardAll(..._args: any[]): Promise<never> {
  return reject('benchRerereDiscardAll')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchPrepareVerificationAnalysis(..._args: any[]): Promise<never> {
  return reject('benchPrepareVerificationAnalysis')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchDiscardMemberRecordings(..._args: any[]): Promise<never> {
  return reject('benchDiscardMemberRecordings')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchReconcileResolution(..._args: any[]): Promise<never> {
  return reject('benchReconcileResolution')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function benchRefreshStaleness(..._args: any[]): Promise<never> {
  return reject('benchRefreshStaleness')
}
