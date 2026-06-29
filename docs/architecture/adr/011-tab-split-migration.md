---
title: "ADR-011: Data-Preserving Tab-Split Migration"
description: Legacy multiplexed conversation tabs are split into N standalone tabs on disk using a backup-migrate-verify-rollback pattern. No history is lost.
sidebar_position: 11
---

# ADR-011: Data-Preserving Tab-Split Migration

## Status

Accepted

## Date

2026-06-19

## Context

Before ADR-009, extension-hosted tabs could host N conversation instances,
each with its own session id, scrollback, and status. This was persisted
to disk (`tabs.json`) as a single tab entry with an array of instance
objects, each containing its own message history and conversation ids.

After ADR-009, every conversation is its own top-level tab. A legacy
persisted tab with N instances must become N standalone tabs. This is a
structural change to the on-disk format: the one-to-many parent-children
shape becomes N flat entries.

The migration must satisfy three properties:

1. **No data loss.** Every instance's message history, session ids, and
   metadata survive the migration.
2. **Idempotent.** Running the migration twice produces the same result as
   running it once. Partial migrations (e.g. from a crash mid-run) do not
   corrupt state.
3. **Rollback safe.** If the migration produces an unexpected result, the
   pre-migration state can be restored.

This is the same class of migration as the earlier conversation-tree
unification migration (which split `.jsonl` files into `.tree.jsonl` and
`.llm.jsonl` pairs). That migration established the backup-migrate-verify
pattern; this ADR follows it.

## Decision

### Backup-migrate-verify-rollback

The migration runs as an offline step before the renderer loads:

1. **Backup.** Write the current `tabs.json` to a timestamped
   `tabs.json.pre-split.<timestamp>` file before any mutation. The
   timestamp makes each run's backup unique; backups are retained, not
   overwritten.
2. **Migrate.** Scan the tab list for any tab that carries a
   `conversationPane` with more than one instance. For each such tab,
   emit one new standalone tab per instance, copying the instance's
   fields (messages, session ids, metadata) into the new tab's state.
   Replace the original multi-instance tab in the list with the first
   emitted tab; insert the remaining tabs immediately after.
3. **Verify.** Assert that the output tab list contains at least as many
   tabs as the input, and that no output tab carries a multi-instance
   `conversationPane`.
4. **Rollback.** A verify failure leaves the original file untouched (no
   write happens). A write failure mid-flight restores the file from the
   timestamped backup. Either way the app starts with the pre-migration
   state; the user sees no data loss.

### Idempotency

Idempotency is enforced by a schema-version stamp: once the file is
written at `SPLIT_SCHEMA_VERSION` (3), a subsequent run sees
`schemaVersion >= 3` and short-circuits to a no-op. A tab whose
`conversationPane` already has exactly one instance also passes the scan
without modification.

### Instance ordering

When a multi-instance tab splits, instances are emitted in the order they
appear in the persisted array. Each emitted tab inherits all parent
fields (via an object spread), carries exactly one cloned instance, takes
the instance label as its `customTitle`, and derives its tab-level
`conversationId` from that instance's most recent `conversationId` (the
parent's shared `conversationId` was never correct for more than one
instance). The persisted tab record has no `id` field — runtime tab ids
are assigned fresh on restoration — so there is no on-disk id to
"inherit"; active-tab continuity is handled at the runtime layer, not by
the on-disk split.

## Rationale

**No silent data loss is acceptable.** Conversation history is the user's
primary artifact. A migration that discards any instance's messages to
simplify the implementation is not acceptable, even for edge cases.

**Offline migration is safer than lazy migration.** Lazy migration
(converting a multi-instance tab the first time it is opened) leaves
the store in a mixed state: some tabs are new-format, others are old.
Offline migration normalizes the entire state before any tab is opened,
so the renderer always sees a uniform new format.

**Backup-first follows the established pattern.** The conversation-tree
split migration set this precedent. Reusing the pattern keeps the
migration strategy consistent and makes rollback behavior predictable.

## Consequences

- The migration runner (`desktop/src/main/tab-migration-split-runner.ts`,
  `runTabSplitMigration`, invoked from the main process before the renderer
  loads — see `ipc/settings.ts`) checks for multi-instance tabs and splits
  them; the transform itself lives in `tab-migration-split.ts`
  (`migrateTabStateToSplit`). The renderer hook
  `useTabRestoration-engine.ts` holds only a defensive last-line guard that
  re-splits any multi-instance tab that somehow reaches the renderer.
- The timestamped backup file `tabs.json.pre-split.<timestamp>` is written
  on each migration run and retained (not deleted after success), making
  it available for manual inspection.
- After migration, no renderer code path needs to handle tabs with more
  than one conversation instance in steady state. If a multi-instance tab
  does reach the renderer (e.g. the on-disk migration was skipped on a
  `no-file`/`not-unified` path), the defensive guard splits it in the
  renderer too rather than dropping the extra instances — no history is
  lost even where no on-disk backup exists.
- The migration is transparent to users. Tabs open normally; each
  previously-shared parent tab becomes multiple visible tabs.
