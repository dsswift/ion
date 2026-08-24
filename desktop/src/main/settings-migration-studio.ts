/**
 * settings-migration-studio — one-shot, idempotent rename of the legacy atv*
 * settings keys to their studio* names, run at boot BEFORE window creation
 * and IPC registration so every consumer sees only the new names.
 *
 * The Ion Studio window became Ion Studio; the settings file is
 * the only on-disk artifact carrying the old vocabulary. Policy (D9): this
 * is a clean one-way delete migration — values are copied to the new key
 * only when the new key is absent, then the old key is removed. No rollback
 * shim, no dual-read period.
 *
 * Key decisions encoded here (see the Ion Studio plan, phase A1):
 *   - atvBeta/studioBeta: DROPPED at release (F2). The gate shipped the
 *     phases; activeUi: 'studio' alone now launches Studio.
 *   - launchSurface → activeUi with value maps atv→studio and both→overlay.
 *     Single-UI exclusivity (decision D1): there is no 'both' anymore.
 *   - surfacePolicy: folded into activeUi (atv-only→studio, overlay-only→
 *     overlay, both→no-op) and DROPPED. The enterprise lock moves to the
 *     MDM policy blob, not user settings.
 *   - atvAutoDrawer: DROPPED. The Studio shell always shows the
 *     conversation; the auto-drawer concept is obsolete.
 *   - atvLayout: only dockTab survives, mapped onto the studioLayout
 *     leftSidebarView ('files'→'explorer', 'worktrees'→'git',
 *     'conversation'→default). dockOpen/dockWidth die with the old dock.
 */
import { existsSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { log } from "./logger";
import { readSettings, writeSettings } from "./settings-store";
import { normalizeStudioLayout } from "../shared/types-studio";

/** Old key → new key. Copy-if-absent, then delete old. */
const KEY_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["atvBounds", "studioBounds"],
  ["atvTheme", "studioTheme"],
  ["atvZoom", "studioZoom"],
  ["atvSeed", "studioSeed"],
  ["atvSeeds", "studioSeeds"],
  ["atvDockPresence", "studioDockPresence"],
  ["atvHeat", "studioHeat"],
  ["atvBeacon", "studioBeacon"],
  ["atvSound", "studioSound"],
  ["atvShortcut", "studioShortcut"],
  // atvBeta maps into the DROPPED set below (studioBeta retired at
  // release) — listing it here would resurrect the key.
];

/**
 * Keys deleted without replacement. `studioBeta` retires here at release
 * (F2): A1 RENAMED atvBeta→studioBeta so the gate survived the rename
 * phases; with the Studio shell shipping, `activeUi: 'studio'` alone
 * launches Studio and the gate key is dropped from disk.
 */
const DROPPED_KEYS: readonly string[] = [
  "atvAutoDrawer",
  // Studio open-state persistence was removed with persistStudioOpenState():
  // the Studio window is a normal desktop window and its open state is no
  // longer restored across restarts. Both the old and the renamed key are
  // dropped — keeping the rename would have written studioWindowOpen back to
  // disk on every migration for a key nothing reads.
  "atvWindowOpen",
  "studioWindowOpen",
  "studioBeta",
  "atvBeta",
  // Pin retired with the always-on-top machinery: the Studio window is a
  // normal desktop window now (never setAlwaysOnTop).
  "atvPinned",
  "studioPinned",
];

/** launchSurface / surfacePolicy value → activeUi value. */
function mapLaunchSurface(value: unknown): "overlay" | "studio" | null {
  if (value === "atv") return "studio";
  if (value === "both") return "overlay"; // D1: single-UI exclusivity — no 'both'
  if (value === "overlay") return "overlay";
  return null;
}

/**
 * Legacy dockTab → studioLayout.leftSidebarView. The worktrees dock pane's
 * content lives in the git panel's WorktreesSection, so 'worktrees' maps to
 * the git view. 'conversation' maps to nothing: the conversation is the
 * Studio center pane now, not a dock tab.
 */
function mapDockTab(value: unknown): "explorer" | "git" | null {
  if (value === "files") return "explorer";
  if (value === "worktrees") return "git";
  return null;
}

/**
 * Move user-installed theme packs from the legacy ~/.ion/atv/themes root to
 * ~/.ion/studio/themes (the only root the loader scans now). Copy-free
 * rename; skipped when the new root already exists (never merge/overwrite).
 */
function migrateThemePackDir(): void {
  const oldRoot = join(homedir(), ".ion", "atv");
  const newRoot = join(homedir(), ".ion", "studio");
  try {
    if (!existsSync(oldRoot)) return;
    if (existsSync(newRoot)) {
      log(
        "settings_migration_studio",
        "legacy theme dir left in place (new root exists)",
        { old: oldRoot, new: newRoot },
      );
      return;
    }
    renameSync(oldRoot, newRoot);
    log("settings_migration_studio", "moved user theme packs", {
      old: oldRoot,
      new: newRoot,
    });
  } catch (err) {
    log("settings_migration_studio", "theme dir migration failed", {
      error: String(err),
    });
  }
}

/**
 * Run the migration. Idempotent: a settings file with no legacy keys is
 * left untouched (no write). Returns true when a write happened.
 */
export function migrateStudioSettings(): boolean {
  migrateThemePackDir();
  let settings: Record<string, unknown>;
  try {
    settings = readSettings();
  } catch (err) {
    log("settings_migration_studio", "read failed, skipping", {
      error: String(err),
    });
    return false;
  }

  let changed = false;
  const applied: string[] = [];

  for (const [oldKey, newKey] of KEY_RENAMES) {
    if (!(oldKey in settings)) continue;
    if (!(newKey in settings)) {
      settings[newKey] = settings[oldKey];
      applied.push(`${oldKey}→${newKey}`);
    } else {
      applied.push(`${oldKey} dropped (new key present)`);
    }
    delete settings[oldKey];
    changed = true;
  }

  for (const key of DROPPED_KEYS) {
    if (!(key in settings)) continue;
    delete settings[key];
    applied.push(`${key} dropped`);
    changed = true;
  }

  // launchSurface → activeUi (value-mapped), only when activeUi absent.
  if ("launchSurface" in settings) {
    if (!("activeUi" in settings)) {
      const mapped = mapLaunchSurface(settings.launchSurface);
      if (mapped !== null) {
        settings.activeUi = mapped;
        applied.push(
          `launchSurface(${String(settings.launchSurface)})→activeUi(${mapped})`,
        );
      } else {
        applied.push(
          `launchSurface(${String(settings.launchSurface)}) invalid, dropped`,
        );
      }
    } else {
      applied.push("launchSurface dropped (activeUi present)");
    }
    delete settings.launchSurface;
    changed = true;
  }

  // Legacy surfacePolicy fold: an enforced single-surface policy becomes the
  // activeUi value (the operator's intent — that surface is the UI); 'both'
  // is a no-op. The key is dropped either way: the enterprise lock lives in
  // the MDM policy blob now, never in user settings.
  if ("surfacePolicy" in settings) {
    const policy = settings.surfacePolicy;
    if (policy === "atv-only" && !("activeUi" in settings)) {
      settings.activeUi = "studio";
      applied.push("surfacePolicy(atv-only)→activeUi(studio)");
    } else if (policy === "overlay-only" && !("activeUi" in settings)) {
      settings.activeUi = "overlay";
      applied.push("surfacePolicy(overlay-only)→activeUi(overlay)");
    } else {
      applied.push(`surfacePolicy(${String(policy)}) dropped`);
    }
    delete settings.surfacePolicy;
    changed = true;
  }

  // atvLayout: dockTab survives as studioLayout.leftSidebarView; the rest of
  // the legacy dock geometry is obsolete in the Studio shell.
  if ("atvLayout" in settings) {
    const layout = settings.atvLayout as { dockTab?: unknown } | null;
    const view =
      layout && typeof layout === "object" ? mapDockTab(layout.dockTab) : null;
    if (view !== null && !("studioLayout" in settings)) {
      // Write the COMPLETE normalized layout so the on-disk value always
      // satisfies the write-path validator's full-shape requirement.
      settings.studioLayout = normalizeStudioLayout({ leftSidebarView: view });
      applied.push(
        `atvLayout.dockTab(${String(layout?.dockTab)})→studioLayout.leftSidebarView(${view})`,
      );
    } else {
      applied.push("atvLayout dropped");
    }
    delete settings.atvLayout;
    changed = true;
  }

  if (!changed) return false;

  try {
    writeSettings(settings);
    log("settings_migration_studio", "migrated legacy atv keys", {
      applied: applied.join(", "),
    });
    return true;
  } catch (err) {
    log("settings_migration_studio", "write failed", {
      error: String(err),
      applied: applied.join(", "),
    });
    return false;
  }
}
