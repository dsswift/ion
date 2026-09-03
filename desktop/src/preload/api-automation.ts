/**
 * Automation IPC bridge. Split from api-request.ts so the automation surface is
 * a cohesive module and neither file grows past the repo cap. Typed
 * `satisfies Partial<IonAPI>` so its signatures can never drift from the single
 * canonical declaration in ionapi-automation.ts.
 */
import { ipcRenderer } from "electron";
import { IPC } from "../shared/types";
import type { IonAPI } from "./ionapi";
import type {
  AutomationAction,
  AutomationRuntimeEvent,
} from "../shared/types-automation";

export const automationApi = {
  automationListing: (projectPath) =>
    ipcRenderer.invoke(IPC.AUTOMATION_LISTING, projectPath),
  automationUpsert: (definition) =>
    ipcRenderer.invoke(IPC.AUTOMATION_UPSERT, definition),
  automationDelete: (id) => ipcRenderer.invoke(IPC.AUTOMATION_DELETE, id),
  automationDuplicate: (id, projectPath) =>
    ipcRenderer.invoke(IPC.AUTOMATION_DUPLICATE, { id, projectPath }),
  automationHistory: () => ipcRenderer.invoke(IPC.AUTOMATION_HISTORY),
  automationProjectIds: (projectPath) =>
    ipcRenderer.invoke(IPC.AUTOMATION_PROJECT_IDS, projectPath),
  setProjectAutomationEnabled: (projectPath, id, enabled) =>
    ipcRenderer.invoke(IPC.AUTOMATION_PROJECT_ENABLED, {
      projectPath,
      id,
      enabled,
    }),
  triggerPlanImplemented: (payload) =>
    ipcRenderer.invoke(IPC.AUTOMATION_PLAN_IMPLEMENTED, payload),
  onAutomationEvent: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      event: AutomationRuntimeEvent,
    ) => callback(event);
    ipcRenderer.on(IPC.AUTOMATION_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC.AUTOMATION_EVENT, handler);
  },
  onAutomationCommand: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      command: { id: string; action: AutomationAction },
    ) => callback(command);
    ipcRenderer.on(IPC.AUTOMATION_COMMAND, handler);
    return () => ipcRenderer.removeListener(IPC.AUTOMATION_COMMAND, handler);
  },
  resolveAutomationCommand: (id, result) =>
    ipcRenderer.send(IPC.AUTOMATION_COMMAND_RESULT, { id, ...result }),
} satisfies Partial<IonAPI>;
