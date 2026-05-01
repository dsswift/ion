// Cross-process type registry. Re-exports the domain-split modules so existing
// `import { X } from '../shared/types'` paths keep working unchanged.
//
// Domain modules:
//   - types-events.ts       CLI stream events, normalized events, content blocks
//   - types-session.ts      Tabs, messages, attachments, run options, git, worktree, fs, remote
//   - types-engine.ts       Native engine runtime types and engine event union
//   - types-persistence.ts  On-disk tab state shapes
//   - types-ipc.ts          IPC channel name registry

export * from './types-events'
export * from './types-session'
export * from './types-engine'
export * from './types-persistence'
export * from './types-ipc'
