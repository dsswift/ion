import { ipcMain } from "electron";
import { IPC } from "../../shared/types-ipc";
import { isAutomationDefinition } from "../../shared/types-automation";
import { getAutomationRuntime } from "../automation/runtime";
import { resolveAutomationRendererCommand } from "../automation/renderer-command";
import { error as _error, log as _log } from "../logger";

const TAG = "automation.ipc";
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields);
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error(TAG, msg, fields);
}


function isPlanImplementedPayload(
  value: unknown,
): value is Record<string, unknown> & { tabId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.tabId === "string" &&
    payload.tabId.length > 0 &&
    typeof payload.worktreePath === "string" &&
    typeof payload.repoPath === "string" &&
    typeof payload.branchName === "string" &&
    typeof payload.sourceBranch === "string" &&
    typeof payload.planFilePath === "string" &&
    typeof payload.clearContext === "boolean" &&
    payload.source === "renderer"
  );
}

/** Renderer contract for automation listing and persistence. Evaluation remains main-owned. */
export function registerAutomationIpc(): void {
  ipcMain.handle(IPC.AUTOMATION_LISTING, (_event, projectPath?: unknown) => {
    const listing = getAutomationRuntime().listing(
      typeof projectPath === "string" ? projectPath : undefined,
    );
    log("automation definitions listed", { count: listing.entries.length });
    return listing;
  });

  ipcMain.handle(IPC.AUTOMATION_HISTORY, () =>
    getAutomationRuntime().history(),
  );
  ipcMain.handle(IPC.AUTOMATION_PROJECT_IDS, (_event, projectPath: unknown) =>
    typeof projectPath === "string" && projectPath.length > 0
      ? getAutomationRuntime().projectDefinitionIds(projectPath)
      : [],
  );
  ipcMain.handle(IPC.AUTOMATION_PROJECT_ENABLED, (_event, request: unknown) => {
    if (!request || typeof request !== "object")
      return { ok: false, error: "invalid project automation request" };
    const value = request as {
      projectPath?: unknown;
      id?: unknown;
      enabled?: unknown;
    };
    if (
      typeof value.projectPath !== "string" ||
      typeof value.id !== "string" ||
      typeof value.enabled !== "boolean"
    )
      return { ok: false, error: "invalid project automation request" };
    try {
      getAutomationRuntime().setProjectDefinitionEnabled(
        value.projectPath,
        value.id,
        value.enabled,
      );
      return { ok: true };
    } catch (err) {
      error("project automation update failed", { error: String(err) });
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    IPC.AUTOMATION_PLAN_IMPLEMENTED,
    async (_event, payload: unknown) => {
      if (!isPlanImplementedPayload(payload)) {
        error("plan implemented automation trigger rejected invalid payload");
        throw new Error("invalid plan implemented automation payload");
      }
      await getAutomationRuntime().triggerPlanImplemented(
        payload.tabId,
        payload,
      );
      log("plan implemented automation trigger delivered", {
        tab_id: payload.tabId,
        worktree_path: payload.worktreePath,
      });
    },
  );

  ipcMain.on(IPC.AUTOMATION_COMMAND_RESULT, (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      error("automation renderer command result rejected invalid payload");
      return;
    }
    const {
      id,
      ok,
      error: failure,
    } = payload as { id?: unknown; ok?: unknown; error?: unknown };
    if (
      typeof id !== "string" ||
      typeof ok !== "boolean" ||
      (failure !== undefined && typeof failure !== "string")
    ) {
      error("automation renderer command result rejected invalid fields");
      return;
    }
    resolveAutomationRendererCommand(id, { ok, error: failure });
  });

  ipcMain.handle(IPC.AUTOMATION_UPSERT, (_event, definition: unknown) => {
    if (!isAutomationDefinition(definition)) {
      error("automation upsert rejected invalid definition");
      return { ok: false, error: "invalid automation definition" };
    }
    try {
      const saved = getAutomationRuntime().saveUserDefinition(definition);
      log("automation definition saved", { automation_id: saved.id });
      return { ok: true, definition: saved };
    } catch (err) {
      error("automation definition save failed", { error: String(err) });
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(IPC.AUTOMATION_DELETE, (_event, id: unknown) => {
    if (typeof id !== "string" || id.length === 0)
      return { ok: false, error: "invalid automation id" };
    try {
      getAutomationRuntime().deleteUserDefinition(id);
      log("automation definition deleted", { automation_id: id });
      return { ok: true };
    } catch (err) {
      error("automation definition delete failed", { error: String(err) });
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(IPC.AUTOMATION_DUPLICATE, (_event, request: unknown) => {
    if (!request || typeof request !== "object")
      return { ok: false, error: "invalid duplicate request" };
    const value = request as { id?: unknown; projectPath?: unknown };
    if (typeof value.id !== "string" || value.id.length === 0)
      return { ok: false, error: "invalid automation id" };
    try {
      const saved = getAutomationRuntime().duplicateDefinition(
        value.id,
        typeof value.projectPath === "string" ? value.projectPath : undefined,
      );
      log("automation definition duplicated", {
        source_id: value.id,
        automation_id: saved.id,
      });
      return { ok: true, definition: saved };
    } catch (err) {
      error("automation definition duplicate failed", { error: String(err) });
      return { ok: false, error: String(err) };
    }
  });
}
