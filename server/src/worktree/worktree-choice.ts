/**
 * The remembered worktree choice for a project: which branch a worktree
 * conversation is cut from, and whether that worktree is ephemeral.
 *
 * The branch is the `worktreeBranchDefaults[repoPath]` setting. The ephemeral
 * answer is `worktreeEphemeral` on the project's registry entry. Both are
 * personal settings of the person the call acts for. When a project has no
 * remembered ephemeral answer, `.ion/worktree.json` `ephemeralDefault` decides.
 */
import { normalizeProjectDir } from "@ion/shared/project-registry";
import { broadcast } from "../broadcast";
import {
  effectiveSubject,
  readEffectiveSettings,
  writeEffectiveSettings,
} from "../persistence/effective-settings";
import { log as _log, warn as _warn } from "../logger";
import { readEphemeralPolicy } from "./ephemeral-policy";

const TAG = "worktree.choice";
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields);
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields);
}

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The project's remembered ephemeral answer, or undefined when none is saved. */
export function rememberedWorktreeEphemeral(repoPath: string): boolean | undefined {
  const projects = readEffectiveSettings().projects;
  if (!isRecord(projects)) return undefined;
  const entry = projects[normalizeProjectDir(repoPath)];
  if (!isRecord(entry)) return undefined;
  return typeof entry.worktreeEphemeral === "boolean" ? entry.worktreeEphemeral : undefined;
}

export interface WorktreeEphemeralDefault {
  /** What a worktree conversation that does not say gets. */
  ephemeral: boolean;
  /** `project` when the user saved it for this project, else the manifest or the built-in default. */
  source: "project" | "manifest";
}

/** What a worktree conversation cut in `repoPath` is when its request does not say. */
export function worktreeEphemeralDefault(repoPath: string): WorktreeEphemeralDefault {
  const remembered = rememberedWorktreeEphemeral(repoPath);
  if (remembered !== undefined) return { ephemeral: remembered, source: "project" };
  return { ephemeral: readEphemeralPolicy(repoPath).ephemeralDefault, source: "manifest" };
}

/**
 * Save `sourceBranch`, and `ephemeral` when given, as this project's worktree
 * choice. The branch is saved for any repository. The ephemeral answer needs a
 * registered project to live on and is skipped, with a log line, otherwise.
 * Every changed key is announced to this person's clients.
 */
export function rememberWorktreeChoice(
  repoPath: string,
  sourceBranch: string,
  ephemeral: boolean | undefined,
): void {
  const subject = effectiveSubject();
  const disk = readEffectiveSettings(subject);
  const branchDefaults = isRecord(disk.worktreeBranchDefaults) ? disk.worktreeBranchDefaults : {};
  const patch: RawRecord = {
    worktreeBranchDefaults: { ...branchDefaults, [repoPath]: sourceBranch },
  };
  if (ephemeral !== undefined) {
    const projects = isRecord(disk.projects) ? disk.projects : {};
    const key = normalizeProjectDir(repoPath);
    const entry = projects[key];
    if (isRecord(entry)) {
      patch.projects = { ...projects, [key]: { ...entry, worktreeEphemeral: ephemeral } };
    } else {
      warn("ephemeral choice not remembered: the directory is not a registered project", {
        repo_path: repoPath,
      });
    }
  }
  writeEffectiveSettings(patch, subject);
  for (const [key, value] of Object.entries(patch)) broadcast("ion:settings-changed", key, value, subject);
  log("worktree choice remembered", {
    repo_path: repoPath,
    source_branch: sourceBranch,
    ephemeral: ephemeral ?? "unchanged",
    keys: Object.keys(patch),
  });
}
