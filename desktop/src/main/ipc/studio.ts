/**
 * IPC surface for the Ion Studio window.
 *
 * All handlers validate renderer-supplied input per ipc-validation.ts
 * conventions before any side effect. Settings writes go through a key
 * allowlist so the Studio window can never mutate arbitrary settings.
 */
import { app, dialog, ipcMain } from "electron";
import { writeFile } from "fs/promises";
import { join } from "path";
import { IPC } from "../../shared/types";
import { normalizeStudioLayout } from "../../shared/types-studio";
import { resolveSurfacePlan } from "../surface-launch";
import { validateSurfacePersisted } from "../../shared/studio-surface-persistence";
import { allowPreviewNetwork } from "../webview-policy";
import { log as _log } from "../logger";
import { state, enterprisePolicyCache } from "../state";
import { isValidSessionId } from "../ipc-validation";
import {
  openStudioWindow,
  applyStudioActivationPolicy,
  isStudioWindowOpen,
  setStudioTitleBarOverlay,
} from "../studio-window-manager";
import { showWindow } from "../window-manager";
import { getStudioState, allStudioSummaries } from "../studio-state-cache";
import {
  listThemePacks,
  readPackBundle,
  readThemeAsset,
} from "../studio-theme-packs";
import { getRemoteTabStates } from "../remote/snapshot";
import {
  readSettings,
  writeSettings,
  SETTINGS_DEFAULTS,
} from "../settings-store";
import { validForwardedAction } from "../../shared/studio-mirror-actions";
import { registerStudioWorktreeSyncIpc } from './studio-worktree-sync'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("studio", msg, fields);
}

/**
 * The only settings keys the Studio window may read or write. All are
 * desktop-only: none appear in the iOS projectable allowlist.
 */
const STUDIO_SETTING_KEYS = new Set([
  "studioTheme",
  "studioZoom",
  "studioSeed",
  "studioDockPresence",
  "studioHeat",
  "studioBeacon",
  "studioSound",
  "studioLayout",
  "studioSurface",
]);

/**
 * How long a mirror-initiated action call waits for the owner renderer's reply.
 *
 * Generous on purpose: a forwarded action can open a confirm dialog or run git,
 * so this is a "the owner is gone or wedged" backstop rather than a latency
 * budget. The mirror caller gets a resolved refusal at the deadline instead of a
 * promise that never settles.
 */
const STUDIO_CALL_TIMEOUT_MS = 30_000;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * How long the reply listener lingers past the deadline so a late reply can be
 * logged before the listener is released.
 *
 * The value is not delivered — the caller was already resolved — but the fact
 * that a reply arrived just too late is the signal that STUDIO_CALL_TIMEOUT_MS is
 * too tight for that action, which in the log is otherwise indistinguishable
 * from an owner that never answered at all.
 */
const STUDIO_LATE_REPLY_GRACE_MS = 10_000;

/**
 * Reply envelope for STUDIO_CALL_ACTION.
 *
 * `ok` describes the ROUND TRIP, not the action's own success: `ok: true` means
 * the owner ran the action and `value` is whatever it returned (which may itself
 * be a `{ ok: false }` domain result). `ok: false` means the call never reached
 * a conclusion — rejected, no owner window, or no reply before the deadline.
 * Collapsing the two would make "the worktree refused to retire" and "the owner
 * window is gone" indistinguishable at the call site.
 */
interface StudioActionReply {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Monotonic correlation id source for STUDIO_CALL_ACTION round trips. */
let studioCallSeq = 0;

export function registerStudioIpc(): void {
  registerStudioWorktreeSyncIpc();
  ipcMain.handle(
    IPC.STUDIO_SET_TITLE_BAR_OVERLAY,
    (_event, color: unknown, symbolColor: unknown) => {
      if (
        typeof color !== "string" ||
        typeof symbolColor !== "string" ||
        !HEX_COLOR.test(color) ||
        !HEX_COLOR.test(symbolColor)
      ) {
        log("studio_ipc: title bar overlay rejected", {
          color: typeof color === "string" ? color : typeof color,
          symbol_color: typeof symbolColor === "string" ? symbolColor : typeof symbolColor,
        });
        return false;
      }
      return setStudioTitleBarOverlay(color, symbolColor);
    },
  );

  // D6: explicit per-tab confirm lifts the preview partition's offline
  // block. Validation lives in webview-policy (partition prefix check).
  ipcMain.handle(
    IPC.STUDIO_PREVIEW_ALLOW_NETWORK,
    (_event, partition: unknown) => {
      if (typeof partition !== "string" || partition.length > 128) return false;
      return allowPreviewNetwork(partition);
    },
  );

  ipcMain.on(IPC.STUDIO_OPEN, () => {
    log("studio_ipc: open requested");
    openStudioWindow("ipc");
  });

  // Palette cross-link: the Studio window can summon the overlay glass.
  // Under single-UI exclusivity a studio-mode deployment has no glass to
  // summon — the palette entry is a no-op there (logged, never silent).
  ipcMain.on(IPC.STUDIO_SHOW_OVERLAY, () => {
    if (
      resolveSurfacePlan(readSettings(), enterprisePolicyCache.policy)
        .activeUi !== "overlay"
    ) {
      log("studio_ipc: show-overlay refused — overlay is not the active UI");
      return;
    }
    showWindow("studio palette");
  });

  // Postcard export: renderer composes the PNG (canvas + stats footer);
  // main validates (PNG signature, size cap) and saves via the dialog.
  ipcMain.handle(IPC.STUDIO_EXPORT_IMAGE, async (_event, png: unknown) => {
    if (
      !(png instanceof ArrayBuffer) ||
      png.byteLength === 0 ||
      png.byteLength > 20 * 1024 * 1024
    ) {
      log("studio_ipc: export-image rejected size", {
        bytes: png instanceof ArrayBuffer ? png.byteLength : -1,
      });
      return false;
    }
    const bytes = Buffer.from(png);
    const PNG_SIG = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    if (!bytes.subarray(0, 8).equals(PNG_SIG)) {
      log("studio_ipc: export-image rejected signature");
      return false;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog({
      defaultPath: join(app.getPath("desktop"), `ion-office-${stamp}.png`),
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, bytes);
    log("studio_ipc: postcard exported", {
      path: result.filePath,
      bytes: bytes.length,
    });
    return true;
  });

  // Clip export: renderer records the canvas stream (MediaRecorder webm);
  // main validates (EBML signature, size cap) and saves via the dialog.
  ipcMain.handle(IPC.STUDIO_EXPORT_VIDEO, async (_event, webm: unknown) => {
    if (
      !(webm instanceof ArrayBuffer) ||
      webm.byteLength === 0 ||
      webm.byteLength > 100 * 1024 * 1024
    ) {
      log("studio_ipc: export-video rejected size", {
        bytes: webm instanceof ArrayBuffer ? webm.byteLength : -1,
      });
      return false;
    }
    const bytes = Buffer.from(webm);
    const EBML_SIG = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    if (!bytes.subarray(0, 4).equals(EBML_SIG)) {
      log("studio_ipc: export-video rejected signature");
      return false;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog({
      defaultPath: join(
        app.getPath("desktop"),
        `ion-office-clip-${stamp}.webm`,
      ),
      filters: [{ name: "WebM video", extensions: ["webm"] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, bytes);
    log("studio_ipc: clip exported", {
      path: result.filePath,
      bytes: bytes.length,
    });
    return true;
  });

  // Campus view: live per-tab summaries derived from the all-tabs cache.
  ipcMain.handle(IPC.STUDIO_GET_ALL_STATUS, () => allStudioSummaries());

  // Owner-published tab-metadata sync. The overlay renderer publishes its
  // persisted tabs snapshot after every persist; main caches the latest and
  // pushes it to the Studio window. The Studio pulls the cache once on boot (view
  // readiness), then lives off the pushes.
  let tabsSyncSnapshot: unknown = null;
  let tabsSyncRevision = 0;
  ipcMain.on(IPC.STUDIO_PUBLISH_TABS_SYNC, (_event, snapshot: unknown) => {
    if (snapshot == null || typeof snapshot !== "object") return;
    tabsSyncSnapshot = { ...(snapshot as Record<string, unknown>), revision: ++tabsSyncRevision };
    const win = state.studioWindow;
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.STUDIO_TABS_SYNC, tabsSyncSnapshot);
    }
  });
  ipcMain.handle(IPC.STUDIO_GET_TABS_SYNC, () => tabsSyncSnapshot);

  // Mirror-store action forwarding: the Studio window routes owner-durable store
  // mutations here; validation is derived from FORWARDED_ACTIONS (the single
  // classification source of truth), then the call is relayed to the overlay
  // renderer, which executes it on the owner store and replies with whatever
  // the action returned.
  //
  // Request/response rather than fire-and-forget because a mirror caller does
  // `const result = await store.retireWorktree(…)` and must get the owner's
  // real answer. The call is correlated by a main-minted callId and resolves on
  // the owner's STUDIO_ACTION_RESULT.
  //
  // Why main owns the correlation rather than the renderers doing it directly:
  // main is already the validation choke point for forwarded actions, and it is
  // the only party that knows whether an owner window exists. It also means a
  // dead or slow owner produces a resolved refusal instead of a mirror caller
  // hanging on a promise that can never settle.
  ipcMain.handle(
    IPC.STUDIO_CALL_ACTION,
    async (_event, action: unknown, args: unknown) => {
      if (!validForwardedAction(action, args)) {
        log("studio_ipc: call-action rejected", {
          action: String(action).slice(0, 64),
        });
        return { ok: false, error: "action not permitted" };
      }
      const main = state.mainWindow;
      if (!main || main.isDestroyed()) {
        log("studio_ipc: call-action dropped, no owner window", { action });
        return { ok: false, error: "no owner window" };
      }
      const callId = `studio-call-${++studioCallSeq}`;
      // Pin the owner's webContents id at dispatch time. The reply is accepted
      // only from THIS sender: STUDIO_ACTION_RESULT is an ipcMain.on listener, so
      // any renderer holding the preload bridge can send on it, and the callId is
      // a predictable counter. Without the check a non-owner window could settle
      // a pending call with a forged value — and the mirror would treat it as the
      // owner's real return, so a fabricated `{ ok: true }` would read as a
      // succeeded retire. Every other input on this channel is validated
      // (validForwardedAction gates action + args); sender identity is the last
      // one, and it is the only input that decides WHOSE answer this is.
      const ownerSenderId = main.webContents.id;
      log("studio_ipc: calling action on owner", {
        action,
        call_id: callId,
        arg_count: (args as unknown[]).length,
      });

      return await new Promise<StudioActionReply>((resolve) => {
        // Set once the call concludes (reply or timeout) so a late reply is
        // logged rather than silently dropped — see the post-settle branch below.
        let settled = false;
        // A single-shot listener keyed by callId AND sender. Removed on reply and
        // on timeout, so no path leaves a listener behind.
        const onReply = (
          event: Electron.IpcMainEvent,
          replyId: unknown,
          payload: unknown,
        ): void => {
          if (replyId !== callId) return;
          if (event.sender.id !== ownerSenderId) {
            // A reply for a live callId from something other than the owner
            // window. Refuse it and keep waiting for the real one.
            log(
              "studio_ipc: call-action reply rejected, sender is not the owner window",
              {
                action,
                call_id: callId,
                sender_id: event.sender.id,
                owner_id: ownerSenderId,
              },
            );
            return;
          }
          if (settled) {
            // Arrived after the deadline already resolved the caller. The value
            // cannot be delivered, but the near-miss must be visible: it means
            // STUDIO_CALL_TIMEOUT_MS is too tight for this action, which is
            // otherwise indistinguishable from a wedged owner in the log.
            log(
              "studio_ipc: call-action reply arrived after timeout, dropped",
              {
                action,
                call_id: callId,
                timeout_ms: STUDIO_CALL_TIMEOUT_MS,
              },
            );
            return;
          }
          settled = true;
          cleanup();
          log("studio_ipc: call-action replied", { action, call_id: callId });
          resolve({ ok: true, value: payload });
        };
        const timer = setTimeout(() => {
          settled = true;
          // The listener stays registered briefly so a late reply can be logged
          // by the branch above; removeListener happens there or on teardown.
          clearTimeout(timer);
          // Not a silent drop: the owner may be mid-dialog or wedged, and the
          // mirror caller must be told rather than left pending forever.
          log("studio_ipc: call-action timed out waiting for owner", {
            action,
            call_id: callId,
            timeout_ms: STUDIO_CALL_TIMEOUT_MS,
          });
          resolve({ ok: false, error: "owner did not reply" });
          // Bounded grace window for the late-reply log, then release the
          // listener. Without this the handler would leak one listener per
          // timed-out call for the life of the process.
          setTimeout(
            () => ipcMain.removeListener(IPC.STUDIO_ACTION_RESULT, onReply),
            STUDIO_LATE_REPLY_GRACE_MS,
          );
        }, STUDIO_CALL_TIMEOUT_MS);
        function cleanup(): void {
          clearTimeout(timer);
          ipcMain.removeListener(IPC.STUDIO_ACTION_RESULT, onReply);
        }
        ipcMain.on(IPC.STUDIO_ACTION_RESULT, onReply);
        main!.webContents.send(IPC.STUDIO_EXEC_ACTION, action, args, callId);
      });
    },
  );

  // State backfill for the Studio window renderer: called on window open and consumed
  // together with studio:active-tab pushes on tab switches. `tabId` optional —
  // absent means "the current active tab".
  ipcMain.handle(IPC.STUDIO_GET_STATE, (_event, tabId?: string) => {
    if (
      tabId != null &&
      (typeof tabId !== "string" || !isValidSessionId(tabId))
    ) {
      log("studio_ipc: get-state rejected invalid tabId", {
        tab_id: String(tabId).slice(0, 64),
      });
      return null;
    }
    const target = tabId ?? state.studioActiveTabId;
    if (!target) {
      log("studio_ipc: get-state with no active tab");
      return { activeTabId: null, activeProfileId: null, state: null };
    }
    return {
      activeTabId: target,
      activeProfileId: state.studioActiveProfileId,
      state: getStudioState(target),
    };
  });

  ipcMain.handle(IPC.STUDIO_GET_SETTINGS, () => {
    try {
      const raw = readSettings();
      const out: Record<string, unknown> = {};
      for (const key of STUDIO_SETTING_KEYS) {
        out[key] =
          raw[key] ?? (SETTINGS_DEFAULTS as Record<string, unknown>)[key];
      }
      // Derived, read-only: launcher visibility = Studio is the active UI.
      out.studioEnabled =
        resolveSurfacePlan(raw, enterprisePolicyCache.policy).activeUi ===
        "studio";
      return out;
    } catch (err) {
      log("studio_ipc: get-settings failed", { error: String(err) });
      const out: Record<string, unknown> = {};
      for (const key of STUDIO_SETTING_KEYS) {
        out[key] = (SETTINGS_DEFAULTS as Record<string, unknown>)[key];
      }
      out.studioEnabled = false; // safe: no readable settings = beta not enabled
      return out;
    }
  });

  ipcMain.handle(
    IPC.STUDIO_SET_SETTING,
    (_event, key: unknown, value: unknown) => {
      if (typeof key !== "string" || !STUDIO_SETTING_KEYS.has(key)) {
        log("studio_ipc: set-setting rejected key", {
          key: String(key).slice(0, 64),
        });
        return false;
      }
      // Per-key shape validation.
      if (key === "studioSeed") {
        if (typeof value !== "string" || value.length > 256) return false;
      } else if (
        key === "studioDockPresence" ||
        key === "studioHeat" ||
        key === "studioBeacon" ||
        key === "studioSound"
      ) {
        if (typeof value !== "boolean") return false;
      } else if (key === "studioZoom") {
        // 0 = fit-to-window mode; 1..6 = manual zoom.
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 6
        )
          return false;
      } else if (key === "studioLayout") {
        // Reject anything that does not round-trip through the shared
        // normalizer unchanged: shape, view union, and numeric bounds all
        // live in ONE place (shared/types-studio.ts) so the renderer's
        // restore path and this validator can never disagree.
        if (value == null || typeof value !== "object") return false;
        const normalized = normalizeStudioLayout(value);
        const keys = Object.keys(normalized) as (keyof typeof normalized)[];
        const candidate = value as Record<string, unknown>;
        if (Object.keys(candidate).length !== keys.length) return false;
        for (const k of keys) {
          if (candidate[k] !== normalized[k]) return false;
        }
      } else if (key === "studioSurface") {
        // Same one-implementation rule as studioLayout: the shared parser is
        // the validator (renderer re-validates with the identical function).
        if (!validateSurfacePersisted(value)) return false;
      } else if (key === "studioTheme") {
        if (typeof value !== "string" || !/^[a-z0-9-]{1,64}$/.test(value))
          return false;
      }
      try {
        const settings = readSettings();
        settings[key] = value;
        writeSettings(settings);
        // Dock presence applies live: toggling it while the Studio window is open must
        // immediately grant/revoke the Dock icon, not wait for a reopen.
        if (key === "studioDockPresence")
          applyStudioActivationPolicy(isStudioWindowOpen());
        log("studio_ipc: setting saved", { key });
        return true;
      } catch (err) {
        log("studio_ipc: set-setting write failed", {
          key,
          error: String(err),
        });
        return false;
      }
    },
  );

  // ── Conversation picker ──

  // Tab list for the Studio window toolbar picker (a pinned Studio can switch
  // conversations without opening the desktop overlay).
  ipcMain.handle(IPC.STUDIO_LIST_TABS, async () => {
    try {
      const snapshot = await getRemoteTabStates();
      // Desktop tab groups (custom/manual). Auto-grouped or ungrouped tabs
      // fall back to their directory basename as the category, mirroring the
      // desktop's automatic grouping.
      const settings = readSettings();
      const groups: Array<{ id: string; label: string; order: number }> =
        Array.isArray(settings.tabGroups)
          ? settings.tabGroups.map((g: any) => ({
              id: String(g.id),
              label: String(g.label),
              order: Number(g.order) || 0,
            }))
          : [];
      const groupById = new Map(groups.map((g) => [g.id, g]));
      const tabs = snapshot.tabs
        .filter((t) => !t.isTerminalOnly)
        .map((t) => {
          const dir =
            (t.workingDirectory || "").split("/").filter(Boolean).pop() ?? "";
          const group = t.groupId ? groupById.get(t.groupId) : undefined;
          return {
            tabId: t.id,
            title: t.customTitle || t.title,
            status: t.status,
            directory: dir,
            extension: t.engineProfileId ?? "",
            group: group?.label ?? dir,
            groupOrder: group?.order ?? 1000,
          };
        });
      log("studio_ipc: listed tabs", {
        count: tabs.length,
        groups: groups.length,
      });
      return tabs;
    } catch (err) {
      log("studio_ipc: list-tabs failed", { error: String(err) });
      return [];
    }
  });

  // Picker selection: forward to the main renderer's tab slice so the
  // desktop and the Studio window stay on the same conversation (the resulting
  // active-tab notification re-targets the Studio window).
  ipcMain.on(IPC.STUDIO_FOCUS_TAB, (_event, tabId: unknown) => {
    if (typeof tabId !== "string" || !isValidSessionId(tabId)) {
      log("studio_ipc: focus-tab rejected", {
        tab_id: String(tabId).slice(0, 64),
      });
      return;
    }
    log("studio_ipc: focus-tab", { tab_id: tabId });
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send(IPC.STUDIO_FOCUS_TAB, tabId);
    }
  });

  // Click-to-inspect: forward an agent selection to the main renderer,
  // which switches to the tab and opens that agent's dispatch detail. The
  // overlay auto-shows first — a click from a pinned Studio while the desktop
  // is hidden must surface the panel it opens, not populate a hidden window.
  ipcMain.on(
    IPC.STUDIO_FOCUS_AGENT,
    (_event, tabId: unknown, agentName: unknown) => {
      if (typeof tabId !== "string" || !isValidSessionId(tabId)) return;
      if (
        typeof agentName !== "string" ||
        agentName.length === 0 ||
        agentName.length > 128
      )
        return;
      log("studio_ipc: focus-agent", { tab_id: tabId, agent: agentName });
      showWindow("studio agent click");
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send(
          IPC.STUDIO_FOCUS_AGENT,
          tabId,
          agentName,
        );
      }
    },
  );

  // ── Theme packs ──

  ipcMain.handle(IPC.STUDIO_LIST_THEMES, () => listThemePacks());

  ipcMain.handle(IPC.STUDIO_READ_THEME_BUNDLE, (_event, packId: unknown) => {
    if (typeof packId !== "string") return null;
    return readPackBundle(packId);
  });

  ipcMain.handle(
    IPC.STUDIO_READ_THEME_ASSET,
    (_event, packId: unknown, relPath: unknown) => {
      if (typeof packId !== "string" || typeof relPath !== "string")
        return null;
      const buf = readThemeAsset(packId, relPath);
      if (!buf) return null;
      // Hand the renderer a standalone ArrayBuffer (structured-clone friendly).
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  );
}
