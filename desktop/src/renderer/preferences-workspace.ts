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
import type { PreferencesState } from "./preferences-types";
import { saveSettings, getAllSettings } from "./preferences-persist";
import { normalizeWorkspacePath } from "../shared/workspace-roots";
import {
  isManagedWorkspacePath,
  normalizeProjectDir,
} from "../shared/project-registry";
import { isAbsolutePath } from "../shared/paths";
import { rDebug } from "./rendererLogger";

type Set = (partial: Partial<PreferencesState>) => void;
type Get = () => PreferencesState;

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
      const primary = normalizeWorkspacePath(primaryDir);
      const entry = normalizeWorkspacePath(dir);
      if (
        !isAbsolutePath(primary) ||
        !isAbsolutePath(entry) ||
        entry === primary
      ) {
        rDebug("workspace", "rejected non-absolute workspace folder entry", {
          primary,
          entry,
        });
        return;
      }
      // A worktree or bench is a checkout inside a Project, never a Project of
      // its own, so it can never become a key again. Keys written before the
      // callers resolved the Project are remapped at startup by
      // main/workspace-folder-migration.ts.
      if (isManagedWorkspacePath(primary)) return;
      const current = get().workspaceFolders;
      const list = current[primary] ?? [];
      if (list.includes(entry)) return;
      set({ workspaceFolders: { ...current, [primary]: [...list, entry] } });
      saveSettings(getAllSettings(get));
    },
    removeWorkspaceFolder: (primaryDir, dir) => {
      const primary = normalizeWorkspacePath(primaryDir);
      const entry = normalizeWorkspacePath(dir);
      const current = get().workspaceFolders;
      const list = current[primary];
      if (!list) return;
      const next = { ...current };
      const filtered = list.filter((d) => d !== entry);
      if (filtered.length > 0) next[primary] = filtered;
      else delete next[primary];
      // Prune the removed root's persisted collapse state too.
      const collapsed = { ...get().gitPanelRepoSectionsCollapsed };
      delete collapsed[entry];
      set({ workspaceFolders: next, gitPanelRepoSectionsCollapsed: collapsed });
      saveSettings(getAllSettings(get));
    },
    setGitPanelRepoSectionCollapsed: (dir, isCollapsed) => {
      const key = normalizeWorkspacePath(dir);
      set({
        gitPanelRepoSectionsCollapsed: {
          ...get().gitPanelRepoSectionsCollapsed,
          [key]: isCollapsed,
        },
      });
      saveSettings(getAllSettings(get));
    },
  };
}

export function createInboxPreferenceActions(
  set: Set,
  get: Get,
): Pick<
  PreferencesState,
  | "setInboxAutoSettleDays"
  | "setInboxAutoSettleOnMerge"
  | "setStudioTabStripVisible"
  | "setGitWatcherIgnoredDirectories"
> {
  return {
    setGitWatcherIgnoredDirectories: (dirs) => {
      set({ gitWatcherIgnoredDirectories: dirs });
      saveSettings(getAllSettings(get));
    },
    setInboxAutoSettleDays: (days) => {
      set({ inboxAutoSettleDays: Math.min(90, Math.max(0, Math.round(days))) });
      saveSettings(getAllSettings(get));
    },
    setInboxAutoSettleOnMerge: (enabled) => {
      set({ inboxAutoSettleOnMerge: enabled });
      saveSettings(getAllSettings(get));
    },
    setStudioTabStripVisible: (visible) => {
      set({ studioTabStripVisible: visible });
      saveSettings(getAllSettings(get));
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
      set({
        projects: { ...current, [key]: { addedManually: true, lastUsedAt: 0 } },
      });
      saveSettings(getAllSettings(get));
    },
    removeProject: (dir) => {
      const key = normalizeProjectDir(dir);
      const current = get().projects;
      if (!(key in current)) return;
      const next = { ...current };
      delete next[key];
      set({ projects: next });
      saveSettings(getAllSettings(get));
    },
    setDefaultProject: (dir) => {
      const key = dir ? normalizeProjectDir(dir) : null;
      const current = get().projects;
      set({
        projects: Object.fromEntries(
          Object.entries(current).map(([path, entry]) => [
            path,
            { ...entry, isDefault: path === key },
          ]),
        ),
      });
      saveSettings(getAllSettings(get));
    },
    setProjectName: (dir, name) => {
      const key = normalizeProjectDir(dir);
      const entry = get().projects[key];
      if (!entry) return;
      const normalized = name?.trim();
      set({
        projects: {
          ...get().projects,
          [key]: {
            ...entry,
            ...(normalized ? { name: normalized } : { name: undefined }),
          },
        },
      });
      saveSettings(getAllSettings(get));
    },
    setProjectProfileOverride: (dir, profileOverride) => {
      const key = normalizeProjectDir(dir);
      const entry = get().projects[key];
      if (!entry) return;
      set({
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
      saveSettings(getAllSettings(get));
    },
  };
}
