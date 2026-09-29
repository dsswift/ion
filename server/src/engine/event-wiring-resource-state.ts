// Resource read and deletion state persistence.

import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { dataDir } from "../paths";
import { resourceIdentity } from "@ion/shared/resource-identity";
import { log as _log } from "../logger";
import { atomicWriteFileSync } from "../utils/atomicWrite";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("main", msg, fields);
}

// ── Resource-state persistence ──────────────────────────────────────────────
//
// The desktop persists which resource identities the user has read or deleted
// so state survives app restarts and producer snapshots. The engine routes live
// deltas but intentionally stores no client state.

function readStatePath(): string {
  return join(dataDir(), "resource-read-state.json");
}
function deletedStatePath(): string {
  return join(dataDir(), "resource-deleted-state.json");
}

/** Resource identities the user has read or deleted. */
const persistedReadIds = new Set<string>();
const persistedDeletedIds = new Set<string>();

function loadPersistedIdentities(
  path: string,
  target: Set<string>,
  label: string,
): void {
  try {
    if (!existsSync(path)) return;
    const data: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(data)) return;
    for (const identity of data) {
      if (typeof identity === "string") target.add(identity);
    }
    log(label + ": loaded from disk", { count: target.size });
  } catch (err) {
    log(label + ": load failed; starting empty", { error: String(err) });
  }
}

let resourceStateActivated = false;

/**
 * Load persisted read/delete state from disk. Deliberately NOT called at
 * module scope: a top-level disk read runs the moment anything imports this
 * file, which breaks any bundle target that cannot run real Node fs/path/os
 * at import time (the Studio renderer imports the session store, which
 * imports this file transitively via the engine slice, purely to compile).
 * `server/src/main.ts` calls this once at server boot, alongside
 * sessionStore.ts's activateServerPersistence().
 */
export function activateResourceStatePersistence(): void {
  if (resourceStateActivated) return;
  resourceStateActivated = true;
  loadPersistedIdentities(
    readStatePath(),
    persistedReadIds,
    "resource_read_state",
  );
  loadPersistedIdentities(
    deletedStatePath(),
    persistedDeletedIds,
    "resource_deleted_state",
  );
}

function persistIdentitySet(
  path: string,
  identities: Set<string>,
  label: string,
): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    atomicWriteFileSync(path, JSON.stringify([...identities]), 0o600);
    log(label + ": persisted", { count: identities.size });
  } catch (err) {
    log(label + ": persist failed", {
      error: String(err),
      count: identities.size,
    });
  }
}

function persistReadState(): void {
  persistIdentitySet(readStatePath(), persistedReadIds, "resource_read_state");
}

/** Mark a resource as read and persist to disk. */
export function markReadPersisted(
  resourceId: string,
  producer?: string,
  kind?: string,
): void {
  persistedReadIds.add(resourceIdentity({ id: resourceId, producer, kind }));
  persistReadState();
}

/** Check whether a resource identity has been read. Used by the snapshot builder.
 *  Raw IDs are checked as a migration fallback for read state written before
 *  producer-qualified identities were available. New writes use the full identity. */
export function isResourceRead(
  resourceId: string,
  producer?: string,
  kind?: string,
): boolean {
  const identity = resourceIdentity({ id: resourceId, producer, kind });
  return (
    persistedReadIds.has(identity) ||
    (identity !== resourceId && persistedReadIds.has(resourceId))
  );
}

export function getPersistedReadIds(): string[] {
  return [...persistedReadIds];
}

export function markDeletedPersisted(
  resourceId: string,
  producer?: string,
  kind?: string,
): void {
  persistedDeletedIds.add(resourceIdentity({ id: resourceId, producer, kind }));
  persistIdentitySet(
    deletedStatePath(),
    persistedDeletedIds,
    "resource_deleted_state",
  );
}

/** Check whether a resource identity was deleted on any client. */
export function isResourceDeleted(
  resourceId: string,
  producer?: string,
  kind?: string,
): boolean {
  return persistedDeletedIds.has(
    resourceIdentity({ id: resourceId, producer, kind }),
  );
}

/** Remove deleted items while retaining the caller's exact item type. */
export function filterDeletedResources<
  T extends Pick<
    import("@ion/shared/types-engine").ResourceItem,
    "id" | "kind" | "producer"
  >,
>(items: T[]): T[] {
  return items.filter(
    (item) => !isResourceDeleted(item.id, item.producer, item.kind),
  );
}

/** Apply the desktop-owned read and delete state to a producer snapshot. */
export function projectPersistedResourceState(
  items: import("@ion/shared/types-engine").ResourceItem[],
): import("@ion/shared/types-engine").ResourceItem[] {
  return filterDeletedResources(items).map((item) =>
    !item.read && isResourceRead(item.id, item.producer, item.kind)
      ? { ...item, read: true }
      : item,
  );
}

/**
 * The read and deleted marks among `identities`, for the resources of a
 * conversation moving to another machine. Raw ids match too, the same
 * migration fallback `isResourceRead` applies.
 */
export function resourceStateFor(identities: readonly string[]): { read: string[]; deleted: string[] } {
  const read = identities.filter((id) => persistedReadIds.has(id));
  const deleted = identities.filter((id) => persistedDeletedIds.has(id));
  log("resource_state: collected for transfer", { count: identities.length, read: read.length, deleted: deleted.length });
  return { read, deleted };
}

/** Adds marks that arrived with a moved conversation, and persists both sets. */
export function mergeResourceState(state: { read: readonly string[]; deleted: readonly string[] }): void {
  if (state.read.length === 0 && state.deleted.length === 0) return;
  for (const id of state.read) persistedReadIds.add(id);
  for (const id of state.deleted) persistedDeletedIds.add(id);
  persistReadState();
  persistIdentitySet(deletedStatePath(), persistedDeletedIds, "resource_deleted_state");
  log("resource_state: merged from transfer", { read: state.read.length, deleted: state.deleted.length });
}
