/**
 * The project's ephemeral-worktree policy, read from the base repo's committed
 * `.ion/worktree.json`:
 *
 *   { "worktree": { "ephemeralDefault": false, "ephemeralMayDiscard": false } }
 *
 * - `ephemeralDefault`: whether a worktree cut for a conversation is ephemeral
 *   when the request does not say. Off by default.
 * - `ephemeralMayDiscard`: whether closing an ephemeral worktree's conversation
 *   may remove it while it holds unlanded work. Off by default, and then that
 *   work is never discarded. When on, removal goes through Retire's discard,
 *   which anchors the work under `refs/ion/discarded/` first.
 *
 * Absent, unreadable, or mistyped values fall back to the defaults, and each
 * fallback is logged, so a typo can never grant discard.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { log as _log, warn as _warn } from "../logger";
import { MANIFEST_RELATIVE_PATH } from "./provision-manifest";

const TAG = "worktree.ephemeral";
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields);
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields);
}

export interface EphemeralPolicy {
  ephemeralDefault: boolean;
  ephemeralMayDiscard: boolean;
}

export const DEFAULT_EPHEMERAL_POLICY: EphemeralPolicy = {
  ephemeralDefault: false,
  ephemeralMayDiscard: false,
};

export function readEphemeralPolicy(repoPath: string): EphemeralPolicy {
  const file = join(repoPath, MANIFEST_RELATIVE_PATH);
  if (!existsSync(file)) return DEFAULT_EPHEMERAL_POLICY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    warn("manifest is not valid JSON; ephemeral policy uses defaults", {
      path: file,
      error: String(err),
    });
    return DEFAULT_EPHEMERAL_POLICY;
  }
  const wt = (parsed as { worktree?: Record<string, unknown> } | null)
    ?.worktree;
  const policy: EphemeralPolicy = {
    ephemeralDefault: readFlag(file, wt, "ephemeralDefault"),
    ephemeralMayDiscard: readFlag(file, wt, "ephemeralMayDiscard"),
  };
  log("ephemeral policy read", {
    path: file,
    ephemeral_default: policy.ephemeralDefault,
    ephemeral_may_discard: policy.ephemeralMayDiscard,
  });
  return policy;
}

function readFlag(
  file: string,
  wt: Record<string, unknown> | undefined,
  key: keyof EphemeralPolicy,
): boolean {
  const value = wt?.[key];
  if (value === undefined) return DEFAULT_EPHEMERAL_POLICY[key];
  if (typeof value === "boolean") return value;
  warn("manifest ephemeral field is not a boolean; using the default", {
    path: file,
    field: key,
    value: String(value),
  });
  return DEFAULT_EPHEMERAL_POLICY[key];
}
