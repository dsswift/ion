// Resource read and deletion state persistence.

import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { resourceIdentity } from "../shared/resource-identity";
import { log as _log } from "./logger";
import { atomicWriteFileSync } from "./utils/atomicWrite";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("main", msg, fields);
}

// ── Resource-state persistence ──────────────────────────────────────────────
//
// The desktop persists which resource identities the user has read or deleted
// so state survives app restarts and producer snapshots. The engine routes live
// deltas but intentionally stores no client state.

const READ_STATE_PATH = join(homedir(), ".ion", "resource-read-state.json");
const DELETED_STATE_PATH = join(
  homedir(),
  ".ion",
  "resource-deleted-state.json",
);

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

loadPersistedIdentities(
  READ_STATE_PATH,
  persistedReadIds,
  "resource_read_state",
);
loadPersistedIdentities(
  DELETED_STATE_PATH,
  persistedDeletedIds,
  "resource_deleted_state",
);

function persistIdentitySet(
  path: string,
  identities: Set<string>,
  label: string,
): void {
  try {
    mkdirSync(join(homedir(), ".ion"), { recursive: true });
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
  persistIdentitySet(READ_STATE_PATH, persistedReadIds, "resource_read_state");
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
    DELETED_STATE_PATH,
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
    import("../shared/types-engine").ResourceItem,
    "id" | "kind" | "producer"
  >,
>(items: T[]): T[] {
  return items.filter(
    (item) => !isResourceDeleted(item.id, item.producer, item.kind),
  );
}

/** Apply the desktop-owned read and delete state to a producer snapshot. */
export function projectPersistedResourceState(
  items: import("../shared/types-engine").ResourceItem[],
): import("../shared/types-engine").ResourceItem[] {
  return filterDeletedResources(items).map((item) =>
    !item.read && isResourceRead(item.id, item.producer, item.kind)
      ? { ...item, read: true }
      : item,
  );
}
