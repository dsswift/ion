/**
 * Engine, model/provider, plugin, and MCP IPC bridge, extracted from
 * preload/index.ts to keep that file under the repo file-size cap.
 *
 * `engineApi` is spread into the main `api` object in index.ts. It is typed
 * as `Pick<IonAPI, ...>` rather than its own hand-authored interface so the
 * method signatures here can never drift from the single canonical
 * declaration in ionapi.ts — that file is the only source of truth for the
 * public IonAPI surface.
 */
import { ipcRenderer } from "electron";
import { IPC } from "../shared/types";
import type { IonAPI } from "./ionapi";

export type EngineIpcApi = Pick<
  IonAPI,
  | "engineIsRemote"
  | "engineStart"
  | "engineSetPlanMode"
  | "engineAbort"
  | "engineAbortDispatch"
  | "engineStopBackgroundTask"
  | "engineDialogResponse"
  | "engineCommand"
  | "engineStop"
  | "engineBranchBefore"
  | "engineRewind"
  | "engineGetContextBreakdown"
  | "getPlanBashAllowlist"
  | "setPlanBashAllowlist"
  | "engineRemapSession"
  | "engineBroadcastHistory"
  | "notifyTabFocus"
  | "markResourceRead"
  | "getReadResourceIds"
  | "getPersistedResources"
  | "publishResourceDelete"
  | "resourceGet"
  | "onEngineEvent"
  | "pluginInstall"
  | "pluginList"
  | "pluginRemove"
  | "mcpList"
  | "mcpAdd"
  | "mcpRemove"
  | "mcpLogin"
  | "mcpLogout"
  | "listModels"
  | "resolveModelTier"
  | "listModelTiers"
  | "setModelTier"
  | "removeModelTier"
  | "onModelTiersUpdated"
  | "storeCredential"
  | "refreshModels"
  | "providerLogin"
  | "providerLoginCancel"
  | "providerLoginCode"
  | "providerLogout"
  | "onProviderLoginEvent"
>;

export const engineApi: EngineIpcApi = {
  engineIsRemote: () => ipcRenderer.invoke(IPC.ENGINE_IS_REMOTE),
  engineStart: (key, config) =>
    ipcRenderer.invoke(IPC.ENGINE_START, { key, config }),
  engineSetPlanMode: (key, enabled, planFilePath) =>
    ipcRenderer.send("ion:engine-set-plan-mode", key, enabled, planFilePath),
  engineAbort: (key, scope) =>
    ipcRenderer.invoke(IPC.ENGINE_ABORT, { key, scope }),
  engineAbortDispatch: (key, dispatchId) =>
    ipcRenderer.invoke(IPC.ENGINE_ABORT_DISPATCH, { key, dispatchId }),
  engineStopBackgroundTask: (key, taskId) =>
    ipcRenderer.invoke(IPC.ENGINE_STOP_BACKGROUND_TASK, { key, taskId }),
  engineDialogResponse: (key, dialogId, value) =>
    ipcRenderer.invoke(IPC.ENGINE_DIALOG_RESPONSE, { key, dialogId, value }),
  engineCommand: (key, command, args) =>
    ipcRenderer.invoke(IPC.ENGINE_COMMAND, { key, command, args }),
  engineStop: (key) => ipcRenderer.invoke(IPC.ENGINE_STOP, { key }),
  engineBranchBefore: (key, entryId) =>
    ipcRenderer.invoke(IPC.ENGINE_BRANCH_BEFORE, { key, entryId }),
  engineRewind: (key, target) =>
    ipcRenderer.invoke(IPC.ENGINE_REWIND, { key, ...target }),
  engineGetContextBreakdown: (key) =>
    ipcRenderer.invoke(IPC.ENGINE_GET_CONTEXT_BREAKDOWN, { key }),
  getPlanBashAllowlist: () => ipcRenderer.invoke(IPC.GET_PLAN_BASH_ALLOWLIST),
  setPlanBashAllowlist: (cmds) =>
    ipcRenderer.invoke(IPC.SET_PLAN_BASH_ALLOWLIST, cmds),
  engineRemapSession: (oldKey, newKey) =>
    ipcRenderer.invoke(IPC.ENGINE_REMAP_SESSION, { oldKey, newKey }),
  engineBroadcastHistory: (tabId, instanceId) =>
    ipcRenderer.invoke(IPC.ENGINE_BROADCAST_HISTORY, { tabId, instanceId }),
  notifyTabFocus: (tabId, engineProfileId) =>
    ipcRenderer.send(IPC.NOTIFY_TAB_FOCUS, {
      tabId,
      engineProfileId: engineProfileId ?? null,
    }),
  markResourceRead: (kind, resourceId) =>
    ipcRenderer.send(IPC.MARK_RESOURCE_READ, { kind, resourceId }),
  getReadResourceIds: () => ipcRenderer.invoke(IPC.GET_READ_RESOURCE_IDS),
  getPersistedResources: () =>
    ipcRenderer.invoke(IPC.GET_PERSISTED_RESOURCES),
  publishResourceDelete: (kind, resourceId) =>
    ipcRenderer.send(IPC.DELETE_RESOURCE, { kind, resourceId }),
  resourceGet: (kind, id, opts) =>
    ipcRenderer.invoke(IPC.RESOURCE_GET, { kind, id, ...opts }),
  onEngineEvent: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      key: string,
      event: any,
    ) => callback(key, event);
    ipcRenderer.on(IPC.ENGINE_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC.ENGINE_EVENT, handler);
  },

  // ─── Plugin management ───
  pluginInstall: (source) => ipcRenderer.invoke("plugin:install", source),
  pluginList: () => ipcRenderer.invoke("plugin:list"),
  pluginRemove: (name) => ipcRenderer.invoke("plugin:remove", name),

  // ─── MCP server administration ───
  mcpList: () => ipcRenderer.invoke(IPC.MCP_LIST),
  mcpAdd: (request) => ipcRenderer.invoke(IPC.MCP_ADD, request),
  mcpRemove: (name) => ipcRenderer.invoke(IPC.MCP_REMOVE, name),
  mcpLogin: (name, scope) => ipcRenderer.invoke(IPC.MCP_LOGIN, { name, scope }),
  mcpLogout: (name) => ipcRenderer.invoke(IPC.MCP_LOGOUT, name),

  // ─── Model & provider management ───
  listModels: () => ipcRenderer.invoke(IPC.LIST_MODELS),
  resolveModelTier: (tier: string) =>
    ipcRenderer.invoke(IPC.MODEL_TIER_RESOLVE, { tier }),
  listModelTiers: () => ipcRenderer.invoke(IPC.LIST_MODEL_TIERS),
  setModelTier: (tier) => ipcRenderer.invoke(IPC.SET_MODEL_TIER, tier),
  removeModelTier: (name) => ipcRenderer.invoke(IPC.REMOVE_MODEL_TIER, { name }),
  onModelTiersUpdated: (callback) => {
    ipcRenderer.on(IPC.MODEL_TIERS_UPDATED, callback);
    return () => ipcRenderer.removeListener(IPC.MODEL_TIERS_UPDATED, callback);
  },
  storeCredential: (provider, credential) =>
    ipcRenderer.invoke(IPC.STORE_CREDENTIAL, { provider, credential }),
  refreshModels: (provider) =>
    ipcRenderer.invoke(IPC.REFRESH_MODELS, { provider }),

  // ─── Delegated-CLI provider auth (codex/claude-code/grok/cursor) ───
  providerLogin: (provider) =>
    ipcRenderer.invoke(IPC.PROVIDER_LOGIN, { provider }),
  providerLoginCancel: (provider) =>
    ipcRenderer.invoke(IPC.PROVIDER_LOGIN_CANCEL, { provider }),
  providerLoginCode: (provider, code) =>
    ipcRenderer.invoke(IPC.PROVIDER_LOGIN_CODE, { provider, code }),
  providerLogout: (provider) =>
    ipcRenderer.invoke(IPC.PROVIDER_LOGOUT, { provider }),
  onProviderLoginEvent: (handler) => {
    const listener = (
      _e: unknown,
      update: import("../shared/types-engine-event").ProviderLoginUpdate,
    ) => handler(update);
    ipcRenderer.on(IPC.PROVIDER_LOGIN_EVENT, listener);
    return () => ipcRenderer.removeListener(IPC.PROVIDER_LOGIN_EVENT, listener);
  },
};
