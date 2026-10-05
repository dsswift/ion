/**
 * Workspace-folder preference actions (multi-root explorer + git panel),
 * extracted from preferences.ts to keep it under the file-size cap.
 *
 * The workspaceFolders setting is PER-PROJECT (D3): normalized PROJECT dir
 * → mounted folders. Callers resolve the key with `resolveProjectDir`
 * (shared/project-workspace.ts), so a worktree or bench checkout reads and
 * writes its Project's list rather than one of its own. Removal also prunes
 * the removed root's persisted git-panel collapse state.
 */
import type { PreferencesState } from "@ion/server/preferences-types";
import { persist } from "./preferences-persist";
import { normalizeWorkspacePath } from "@ion/shared/workspace-roots";
import {
  isManagedWorkspacePath,
  normalizeProjectDir,
} from "@ion/shared/project-registry";
import { isAbsolutePath } from "@ion/shared/paths";
import { rDebug } from "./rendererLogger";

type Set = (partial: Partial<PreferencesState>) => void;
type Get = () => PreferencesState;

type WorkspaceFolders = PreferencesState["workspaceFolders"];

/**
 * `folders` with `dir` mounted under the Project `primaryDir`, or `null` when
 * nothing changes. Pure, so the same rule writes the local server's list and
 * another server's (`useWorkspaceFolders`).
 */
export function withWorkspaceFolderAdded(
  folders: WorkspaceFolders,
  primaryDir: string,
  dir: string,
): WorkspaceFolders | null {
  const primary = normalizeWorkspacePath(primaryDir);
  const entry = normalizeWorkspacePath(dir);
  if (!isAbsolutePath(primary) || !isAbsolutePath(entry) || entry === primary) {
    rDebug("workspace", "rejected non-absolute workspace folder entry", {
      primary,
      entry,
    });
    return null;
  }
  // A worktree or bench is a checkout inside a Project, never a Project of
  // its own, so it can never become a key again. Keys written before the
  // callers resolved the Project are remapped at startup by
  // main/workspace-folder-migration.ts.
  if (isManagedWorkspacePath(primary)) return null;
  const list = folders[primary] ?? [];
  if (list.includes(entry)) return null;
  return { ...folders, [primary]: [...list, entry] };
}

/** `folders` without `dir` under the Project `primaryDir`, or `null` when nothing changes. */
export function withWorkspaceFolderRemoved(
  folders: WorkspaceFolders,
  primaryDir: string,
  dir: string,
): WorkspaceFolders | null {
  const primary = normalizeWorkspacePath(primaryDir);
  const entry = normalizeWorkspacePath(dir);
  const list = folders[primary];
  if (!list) return null;
  const next = { ...folders };
  const filtered = list.filter((d) => d !== entry);
  if (filtered.length > 0) next[primary] = filtered;
  else delete next[primary];
  return next;
}

export function createWorkspaceFolderActions(
  set: Set,
  get: Get,
): Pick<
  PreferencesState,
  | "addWorkspaceFolder"
  | "removeWorkspaceFolder"
  | "setGitPanelRepoSectionCollapsed"
> {
  return {
    addWorkspaceFolder: (primaryDir, dir) => {
      const next = withWorkspaceFolderAdded(get().workspaceFolders, primaryDir, dir);
      if (next) persist(set, { workspaceFolders: next });
    },
    removeWorkspaceFolder: (primaryDir, dir) => {
      const next = withWorkspaceFolderRemoved(get().workspaceFolders, primaryDir, dir);
      if (!next) return;
      // Prune the removed root's persisted collapse state too.
      const collapsed = { ...get().gitPanelRepoSectionsCollapsed };
      delete collapsed[normalizeWorkspacePath(dir)];
      persist(set, { workspaceFolders: next, gitPanelRepoSectionsCollapsed: collapsed });
    },
    setGitPanelRepoSectionCollapsed: (dir, isCollapsed) => {
      const key = normalizeWorkspacePath(dir);
      persist(set, {
        gitPanelRepoSectionsCollapsed: {
          ...get().gitPanelRepoSectionsCollapsed,
          [key]: isCollapsed,
        },
      });
    },
  };
}

export function createInboxPreferenceActions(
  set: Set,
  _get: Get,
): Pick<
  PreferencesState,
  | "setInboxAutoSettleDays"
  | "setUsageLimitAutoResume"
  | "setUsageLimitResumePrompt"
  | "setQuotaExpiryAlertHours"
  | "setQuotaExpiryUnusedPercent"
  | "setGitWatcherIgnoredDirectories"
> {
  return {
    setGitWatcherIgnoredDirectories: (dirs) => {
      persist(set, { gitWatcherIgnoredDirectories: dirs });
    },
    setInboxAutoSettleDays: (days) => {
      persist(set, { inboxAutoSettleDays: Math.min(90, Math.max(0, Math.round(days))) });
    },
    setUsageLimitAutoResume: (enabled) => {
      persist(set, { usageLimitAutoResume: enabled });
    },
    setUsageLimitResumePrompt: (prompt) => {
      persist(set, { usageLimitResumePrompt: prompt });
    },
    setQuotaExpiryAlertHours: (hours) => {
      persist(set, { quotaExpiryAlertHours: Math.min(72, Math.max(0, Math.round(hours))) });
    },
    setQuotaExpiryUnusedPercent: (percent) => {
      persist(set, { quotaExpiryUnusedPercent: Math.min(100, Math.max(1, Math.round(percent))) });
    },
  };
}

export function createProjectRegistryActions(
  set: Set,
  get: Get,
): Pick<
  PreferencesState,
  | "addProject"
  | "removeProject"
  | "setDefaultProject"
  | "setProjectName"
  | "setProjectProfileOverride"
  | "setProjectWorktreeEphemeral"
> {
  return {
    addProject: (dir) => {
      const key = normalizeProjectDir(dir);
      if (!isAbsolutePath(key) || isManagedWorkspacePath(key)) {
        rDebug("workspace", "rejected non-absolute project entry", { key });
        return;
      }
      const current = get().projects;
      if (current[key]) return;
      persist(set, {
        projects: { ...current, [key]: { addedManually: true, lastUsedAt: 0 } },
      });
    },
    removeProject: (dir) => {
      const key = normalizeProjectDir(dir);
      const current = get().projects;
      if (!(key in current)) return;
      const next = { ...current };
      delete next[key];
      persist(set, { projects: next });
    },
    setDefaultProject: (dir) => {
      const key = dir ? normalizeProjectDir(dir) : null;
      const current = get().projects;
      persist(set, {
        projects: Object.fromEntries(
          Object.entries(current).map(([path, entry]) => [
            path,
            { ...entry, isDefault: path === key },
          ]),
        ),
      });
    },
    setProjectName: (dir, name) => {
      const key = normalizeProjectDir(dir);
      const entry = get().projects[key];
      if (!entry) return;
      const normalized = name?.trim();
      persist(set, {
        projects: {
          ...get().projects,
          [key]: {
            ...entry,
            ...(normalized ? { name: normalized } : { name: undefined }),
          },
        },
      });
    },
    setProjectProfileOverride: (dir, profileOverride) => {
      const key = normalizeProjectDir(dir);
      const entry = get().projects[key];
      if (!entry) return;
      persist(set, {
        projects: {
          ...get().projects,
          [key]: {
            ...entry,
            ...(profileOverride
              ? { profileOverride }
              : { profileOverride: undefined }),
          },
        },
      });
    },
    setProjectWorktreeEphemeral: (dir, ephemeral) => {
      const key = normalizeProjectDir(dir);
      const entry = get().projects[key];
      if (!entry) return;
      persist(set, {
        projects: {
          ...get().projects,
          [key]: { ...entry, worktreeEphemeral: ephemeral },
        },
      });
    },
  };
}
