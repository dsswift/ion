/**
 * Studio settings IPC.
 *
 * Extracted from `ipc/studio.ts` to keep that file under the size cap. It owns
 * the two settings channels the Studio window uses: reading the allow-listed
 * Studio keys (with defaults, and a derived read-only `studioEnabled`) and
 * writing one key at a time.
 *
 * The write path funnels through `persistAndBroadcastSettings` rather than
 * writing the file directly. That funnel is what emits `ion:settings-changed`
 * for cross-window convergence and what drives the client-tool resync, so a
 * direct write here would silently skip both — the Studio window would save a
 * setting that the overlay never learned about.
 */
import { ipcMain } from "electron";
import { IPC } from "../../shared/types";
import { log as _log } from "../logger";
import { enterprisePolicyCache } from "../state";
import { isStudioWindowOpen, applyStudioActivationPolicy } from "../studio-window-manager";
import { normalizeStudioLayout } from "../../shared/types-studio";
import { validateSurfacePersisted } from "../../shared/studio-surface-persistence";
import { resolveSurfacePlan } from "../surface-launch";
import { persistAndBroadcastSettings } from "../settings-broadcast";
import { readSettings, SETTINGS_DEFAULTS } from "../settings-store";

/**
 * The only settings keys the Studio window may read or write. All are
 * desktop-only: none appear in the iOS projectable allowlist. Exported so the
 * one allowlist governs both the read and the write path.
 */
export const STUDIO_SETTING_KEYS = new Set([
  "studioTheme",
  "studioZoom",
  "studioSeed",
  "studioDockPresence",
  "studioHeat",
  "studioBeacon",
  "studioSound",
  "studioLayout",
  "studioSurface",
  "studioPlaywrightEnabled",
  "studioTabStripVisible",
]);

function log(message: string, fields?: Record<string, unknown>): void {
  _log("studio_ipc", message, fields);
}

export function registerStudioSettingsIpc(): void {
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
        key === "studioSound" ||
        key === "studioPlaywrightEnabled" ||
        key === "studioTabStripVisible"
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
        // Routed through the shared funnel rather than writeSettings() so both
        // settings write paths converge: the funnel emits ion:settings-changed
        // (cross-window convergence) and drives the client-tool resync, which a
        // direct write would silently skip.
        const prev = { ...settings };
        settings[key] = value;
        persistAndBroadcastSettings(settings, prev);
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
}
