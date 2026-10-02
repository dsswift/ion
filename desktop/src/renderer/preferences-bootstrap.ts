/**
 * preferences-bootstrap — module-load startup side effects for the
 * preferences store, extracted from preferences.ts (600-line cap split).
 *
 * Everything here runs exactly once, when preferences.ts finishes creating
 * the store and calls bootstrapPreferences(). The store is passed in as an
 * argument (not imported) so this module has no import cycle back into
 * preferences.ts.
 */
import { isClientOwnedSetting } from "./preferences-scope-transport";
import type { StoreApi, UseBoundStore } from "zustand";
import {
  applyTheme,
  onThemeRegistryChanged,
  registerCustomThemes,
} from "./theme-tokens";
import type { PreferencesState } from "@ion/server/preferences-types";
import type { CustomThemeForRenderer } from "@ion/shared/theme-pack-types";
import {
  deriveEnterpriseThemePolicy,
  resolveEffectiveThemeId,
} from "@ion/shared/enterprise-theme-policy";
import type { EnvironmentTarget } from "@ion/shared/types-environments";
import { loadPersistedSettings } from "./preferences-persist";
import { reconcileManagedDefaults } from "./managed-defaults";
import { reconcileManagedCatalog } from "./studio/connection/catalog";
import { rError, rInfo, rWarn } from "./rendererLogger";
import { host } from "./host/host-instance";
import type { ShellApi } from "./host/shell-api";
import type { EnterprisePolicy } from "@ion/shared/types-enterprise";
import { LOCAL_ENVIRONMENT_ID } from "@ion/shared/types-environments";
import { stableStringify } from "@ion/shared/enterprise-settings-policy";
import { policyStore } from "./studio/connection/policy-store";
import { holdDevicePolicy } from "./settings-policy";
import { applyDeviceSettingsPolicy } from "./settings-policy-apply";

type PreferencesStore = UseBoundStore<StoreApi<PreferencesState>>;

/**
 * The theme id that must actually render: the enterprise-enforced id when
 * a locked policy is present, otherwise the caller's (user) choice. The
 * user's saved pick is never overwritten by enforcement — it resumes when
 * the policy lifts.
 */
function effectiveThemeId(store: PreferencesStore, userChoice: string): string {
  return resolveEffectiveThemeId(store.getState().enterprisePolicy, userChoice);
}

/**
 * Run the one-time startup sequence: seed theme CSS variables, hydrate
 * persisted settings from disk, fetch enterprise policies from the engine,
 * and subscribe to main-process settings pushes.
 */
let preferencesReady: Promise<void> | null = null;

export function bootstrapPreferencesReady(): Promise<void> {
  return preferencesReady ?? Promise.resolve();
}

type BootstrapVerbs = Pick<
  ShellApi,
  | "listCustomThemes"
  | "onThemesChanged"
  | "getEnterprisePolicy"
  | "getEnterprisePolicyFull"
  | "onSettingsChanged"
>;

/**
 * The five shell verbs this bootstrap needs, each falling back to an inert
 * implementation that logs once when a partial double lacks it. Production
 * hosts carry every verb; the fallback exists so a unit test that mocks
 * `host-instance` with `shell: {}` can still import the preference store.
 */
function shellVerbs(
  shell: Partial<ShellApi> | undefined,
): BootstrapVerbs | null {
  if (!shell) return null;
  const missing = (name: keyof BootstrapVerbs): void => {
    rWarn(
      "preferences",
      "host shell lacks a bootstrap verb; that feature is unavailable in this client",
      { verb: name },
    );
  };
  const pick = <K extends keyof BootstrapVerbs>(
    name: K,
    fallback: BootstrapVerbs[K],
  ): BootstrapVerbs[K] => {
    const fn = shell[name];
    if (typeof fn === "function") return fn.bind(shell) as BootstrapVerbs[K];
    missing(name);
    return fallback;
  };
  return {
    listCustomThemes: pick("listCustomThemes", async () => []),
    onThemesChanged: pick("onThemesChanged", () => () => {}),
    getEnterprisePolicy: pick("getEnterprisePolicy", async () => null),
    getEnterprisePolicyFull: pick("getEnterprisePolicyFull", async () => null),
    onSettingsChanged: pick("onSettingsChanged", () => () => {}),
  };
}

/** Settles once disk hydration has, whether it succeeded or not. Hydration logs its own failure. */
function hydrated(): Promise<void> {
  return (preferencesReady ?? Promise.resolve()).catch(() => {
    // silent-ok: loadPersistedSettings already logged; a policy must still apply over in-memory defaults
  });
}

export function bootstrapPreferences(
  store: PreferencesStore,
  savedThemeId: string,
): void {
  // Initialize CSS vars + scheme classes with the saved theme so the first
  // paint is already correct (disk hydration below may still change it).
  applyTheme(savedThemeId);

  // Load persisted settings from disk (async, fires once on startup).
  // The theme callback routes through the enterprise gate: if the policy
  // fetch below resolved first with a lock, the disk value must not win.
  preferencesReady = loadPersistedSettings(
    (patch) => store.setState(patch),
    () => store.getState(),
    (id) => applyTheme(effectiveThemeId(store, id)),
  );

  // Whenever the custom-theme registry changes (boot fetch below or a live
  // ion:themes-changed push), re-apply the effective theme: a selected (or
  // enforced) custom theme just arrived/updated, or was removed (getTheme
  // falls back to ion-dark visually; the saved id is kept so the choice
  // restores if the pack returns).
  onThemeRegistryChanged(() => {
    applyTheme(effectiveThemeId(store, store.getState().selectedTheme));
  });

  // This runs at module load (preferences.ts calls it while creating the
  // store), and a partial host double in a test may carry no `shell`, or a
  // shell missing some of these verbs. A real client always has all of them;
  // a missing one is treated as "no transport for that verb" and said so,
  // the same rule preferences-persist applies to the settings transport.
  const shell = shellVerbs((host as { shell?: Partial<ShellApi> }).shell);
  if (!shell) {
    rWarn(
      "preferences",
      "host has no shell; custom themes, enterprise policy and settings pushes are unavailable",
    );
    return;
  }

  // Custom theme packs: fetch the installed set once at boot. Built-ins are
  // compiled in, so this only affects users with packs on disk; the initial
  // applyTheme above already painted correctly for built-in selections.
  // `themes.list` is a server read, so a browser client gets its packs too.
  shell
    .listCustomThemes()
    .then((customs: CustomThemeForRenderer[]) => {
      registerCustomThemes(customs ?? []);
    })
    .catch((err: unknown) => {
      rError(
        "preferences",
        "listCustomThemes failed; custom themes unavailable",
        { error: String(err) },
      );
    });

  // Live pack-set updates (the server's fs watcher / sync-time rescan).
  shell.onThemesChanged((customs) => {
    registerCustomThemes(customs ?? []);
  });

  // Load enterprise policy from the engine at startup (async, not persisted).
  // Errors are non-fatal: the app runs without enterprise constraints.
  // An unlocked policy seeds the new-conversation preferences, so it is
  // reconciled only once disk hydration has settled.
  shell
    .getEnterprisePolicy()
    .then(async (policy) => {
      store.getState().setEnterpriseNewConversationDefaults(policy);
      await hydrated();
      await reconcileManagedDefaults(store);
    })
    .catch((err: unknown) => {
      rInfo(
        "preferences",
        "enterprise new-conversation policy unavailable; running without it",
        { error: String(err) },
      );
    });

  // Full enterprise policy blob (D-004): model allowlist (D-011) and every
  // other renderer-side enterprise constraint ride this. Same non-fatal
  // semantics as the new-conversation policy above.
  // Sequenced after disk hydration so the policy lands on the hydrated store,
  // not on defaults that hydration would then overwrite. The theme branch below
  // reads localStorage, which is synchronous.
  // Everything device policy changes about this client, in one place: it runs
  // for the boot fetch and again whenever the local server announces a
  // different policy.
  const adoptDevicePolicy = (
    policy: EnterprisePolicy | null,
    live: boolean,
  ): void => {
    store.getState().setEnterprisePolicy(policy);
    holdDevicePolicy(policy);
    const themePolicy = deriveEnterpriseThemePolicy(policy);
    if (themePolicy?.locked) {
      rInfo("preferences", "enterprise theme lock active", {
        theme_id: themePolicy.themeId,
      });
      applyTheme(themePolicy.themeId);
    } else if (live) {
      applyTheme(store.getState().selectedTheme);
    }
    applyDeviceSettingsPolicy(store, policy);
    void reconcileManagedDefaults(store);
  };

  // A policy the local server announces after boot. The store is hydrated
  // again first, so a setting whose seal lifted shows what the person saved.
  let adopted: string | null = null;
  const followLivePolicy = (): void => {
    policyStore.subscribe(() => {
      if (!policyStore.has(LOCAL_ENVIRONMENT_ID)) return;
      const policy = policyStore.devicePolicy();
      const next = stableStringify(policy);
      if (next === adopted) return;
      adopted = next;
      rInfo("preferences", "device policy changed; applying", {
        has_policy: policy !== null,
      });
      void loadPersistedSettings(
        (patch) => store.setState(patch),
        () => store.getState(),
        () => {},
      )
        .catch((err: unknown) =>
          rWarn("preferences", "settings reload after a policy change failed", {
            error: String(err),
          }),
        )
        .then(() => adoptDevicePolicy(policy, true));
    });
  };

  void (preferencesReady ?? Promise.resolve())
    .catch(() => {
      // Hydration already logs its own failure; the policy must still apply.
    })
    .then(() => shell.getEnterprisePolicyFull())
    .then((policy) => {
      adopted = stableStringify(policy);
      adoptDevicePolicy(policy, false);
      followLivePolicy();

      // Managed environments (spec 14): customFields['ion-desktop'].environments
      // become catalog entries with managed:true. Reconciliation is idempotent
      // and re-runs on every policy fetch (spec 13 edge case: "the list is
      // re-applied on policy-change").
      const rawEnvironments = policy?.customFields?.['ion-desktop']
        ? (policy.customFields['ion-desktop'] as { environments?: Array<Record<string, unknown>> }).environments
        : undefined
      if (Array.isArray(rawEnvironments) && rawEnvironments.length > 0) {
        const targets = rawEnvironments.filter(
          (e): e is EnvironmentTarget & Record<string, unknown> =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as { kind?: unknown }).kind === "string",
        );
      void reconcileManagedCatalog(targets).catch((err) => rWarn('preferences', 'managed environments reconciliation failed', {
        error: String(err),
      }))
      }
    })
    .catch((err: unknown) => {
      rInfo(
        "preferences",
        "enterprise policy unavailable; running without it",
        { error: String(err) },
      );
    });

  // Listen for settings changes pushed from the server (e.g. iOS
  // `set_desktop_setting` writes). Without this, iOS-originated changes
  // only land on disk — the renderer Zustand store keeps the stale
  // in-memory value until the next restart.
  shell.onSettingsChanged((key, value) => {
    // A client-owned key is this client's: a server's copy of it is a leftover
    // from before it moved, and must not overwrite what this client holds.
    if (isClientOwnedSetting(key)) return;
    const current = store.getState();
    if (
      !(key in current) ||
      (current as unknown as Record<string, unknown>)[key] === value
    )
      return;
    // Theme selection must go through the setter so the palette is applied
    // (and localStorage mirrored) — a bare setState only updates the store.
    if (key === "selectedTheme" && typeof value === "string") {
      current.setSelectedTheme(value);
      return;
    }
    store.setState({ [key]: value });
  });
}
