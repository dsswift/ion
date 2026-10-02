/**
 * Enterprise managed defaults on this client.
 *
 * A managed default is an unlocked enterprise value that seeds a preference
 * the person may then change (`@ion/shared/managed-defaults` holds the rule).
 * This module is the table of preferences in the class and the one routine
 * that reconciles all of them against the loaded policy.
 *
 * The watermark is saved through the settings funnel, in the same place as
 * the preference it belongs to: a client-owned preference keeps its watermark
 * on this client, a server-owned one keeps it in the person's settings on
 * that server. The preference and its watermark go out in one save, so a
 * refused save cannot record a default that was never stored.
 */
import type { StoreApi } from "zustand";
import type { PreferencesState } from "@ion/server/preferences-types";
import {
  decideManagedDefault,
  sanitizeManagedDefaultWatermarks,
  type ManagedDefaultWatermarks,
} from "@ion/shared/managed-defaults";
import { deriveEnterpriseThemePolicy } from "@ion/shared/enterprise-theme-policy";
import { host } from "./host/host-instance";
import type { ShellApi } from "./host/shell-api";
import { saveSettings } from "./preferences-persist";
import { isClientOwnedSetting } from "./preferences-scope-transport";
import { applyTheme } from "./theme-tokens";
import { rDebug, rInfo, rWarn } from "./rendererLogger";

/** Watermarks for preferences this client keeps. A Device setting. */
export const CLIENT_WATERMARKS_KEY = "managedDefaultsApplied";
/** Watermarks for preferences a server keeps for this person. An Account setting. */
export const ACCOUNT_WATERMARKS_KEY = "accountManagedDefaultsApplied";

type WatermarksKey =
  typeof CLIENT_WATERMARKS_KEY | typeof ACCOUNT_WATERMARKS_KEY;
type ManagedPreferenceKey =
  "selectedTheme" | "defaultBaseDirectory" | "defaultEngineProfileId";

interface ManagedDefaultField {
  /** The preference the policy seeds. Also the watermark's key. */
  key: ManagedPreferenceKey;
  /** The policy's value for this preference, or null when the loaded policy does not set it. */
  policy(state: PreferencesState): { value: string; locked: boolean } | null;
  /** What must happen besides storing the value, if anything. */
  afterApply?(value: string): void;
}

/** Every preference in the managed-default class. A new member is one row here. */
export const MANAGED_DEFAULT_FIELDS: readonly ManagedDefaultField[] = [
  {
    key: "selectedTheme",
    policy: (state) => {
      const policy = deriveEnterpriseThemePolicy(state.enterprisePolicy);
      return policy ? { value: policy.themeId, locked: policy.locked } : null;
    },
    afterApply: (themeId) => {
      // The same two effects the theme setter has beyond storing the id.
      localStorage.setItem("ion_selectedTheme", themeId);
      applyTheme(themeId);
    },
  },
  {
    key: "defaultBaseDirectory",
    policy: (state) => {
      const policy = state.enterpriseNewConversationDefaults;
      return policy?.baseDirectory
        ? { value: policy.baseDirectory, locked: policy.locked === true }
        : null;
    },
  },
  {
    key: "defaultEngineProfileId",
    policy: (state) => {
      const policy = state.enterpriseNewConversationDefaults;
      return policy?.engineProfileId
        ? { value: policy.engineProfileId, locked: policy.locked === true }
        : null;
    },
  },
];

function watermarksKeyFor(key: ManagedPreferenceKey): WatermarksKey {
  return isClientOwnedSetting(key)
    ? CLIENT_WATERMARKS_KEY
    : ACCOUNT_WATERMARKS_KEY;
}

/** Where watermarks are read from and where an application is saved. A seam for tests. */
export interface ManagedDefaultsIo {
  readClient(): Promise<Record<string, unknown>>;
  readServer(): Promise<Record<string, unknown>>;
  save(patch: Record<string, unknown>): void;
}

const hostIo: ManagedDefaultsIo = {
  readClient: () => host.deviceSettings(),
  readServer: async () => {
    const load = (host as { shell?: Partial<Pick<ShellApi, "loadSettings">> })
      .shell?.loadSettings;
    if (typeof load !== "function")
      throw new Error("settings transport has no loadSettings");
    return (await load()) ?? {};
  },
  save: (patch) => saveSettings(patch),
};

type PreferencesStore = Pick<
  StoreApi<PreferencesState>,
  "getState" | "setState"
>;

async function reconcile(
  store: PreferencesStore,
  io: ManagedDefaultsIo,
): Promise<void> {
  const state = store.getState();
  const unlocked: Array<{ field: ManagedDefaultField; value: string }> = [];
  for (const field of MANAGED_DEFAULT_FIELDS) {
    const policy = field.policy(state);
    const decision = decideManagedDefault({
      policyValue: policy?.value,
      locked: policy?.locked === true,
      applied: null,
    });
    if (decision === "apply" && policy)
      unlocked.push({ field, value: policy.value });
    else
      rDebug("preferences", "managed default not in play", {
        key: field.key,
        decision,
      });
  }
  // An unmanaged or fully locked installation reads nothing.
  if (unlocked.length === 0) return;

  const needsClient = unlocked.some(
    ({ field }) => watermarksKeyFor(field.key) === CLIENT_WATERMARKS_KEY,
  );
  const needsServer = unlocked.some(
    ({ field }) => watermarksKeyFor(field.key) === ACCOUNT_WATERMARKS_KEY,
  );
  const none: Record<string, unknown> = {};
  const [client, server] = await Promise.all([
    needsClient ? io.readClient() : none,
    needsServer ? io.readServer() : none,
  ]);
  const watermarks: Record<WatermarksKey, ManagedDefaultWatermarks> = {
    [CLIENT_WATERMARKS_KEY]: sanitizeManagedDefaultWatermarks(
      client[CLIENT_WATERMARKS_KEY],
    ),
    [ACCOUNT_WATERMARKS_KEY]: sanitizeManagedDefaultWatermarks(
      server[ACCOUNT_WATERMARKS_KEY],
    ),
  };

  const patch: Record<string, unknown> = {};
  const statePatch: Partial<Pick<PreferencesState, ManagedPreferenceKey>> = {};
  const applied: ManagedDefaultField[] = [];
  for (const { field, value } of unlocked) {
    const watermarksKey = watermarksKeyFor(field.key);
    const previousPolicyValue = watermarks[watermarksKey][field.key] ?? null;
    if (
      decideManagedDefault({
        policyValue: value,
        locked: false,
        applied: previousPolicyValue,
      }) === "keep"
    ) {
      rDebug(
        "preferences",
        "enterprise managed default unchanged; preference left alone",
        { key: field.key, policy_value: value },
      );
      continue;
    }
    watermarks[watermarksKey] = {
      ...watermarks[watermarksKey],
      [field.key]: value,
    };
    patch[field.key] = value;
    patch[watermarksKey] = watermarks[watermarksKey];
    statePatch[field.key] = value;
    applied.push(field);
    rInfo(
      "preferences",
      "enterprise managed default applied; preference overwritten",
      {
        key: field.key,
        policy_value: value,
        previous_policy_value: previousPolicyValue,
        preference_changed: store.getState()[field.key] !== value,
      },
    );
  }
  if (applied.length === 0) return;
  store.setState(statePatch);
  io.save(patch);
  for (const field of applied) {
    const value = statePatch[field.key];
    if (value !== undefined) field.afterApply?.(value);
  }
}

let queue: Promise<void> = Promise.resolve();

/**
 * Reconcile every managed default against the policy the store holds now.
 * Call it whenever a policy lands. Runs are serialized: each one reads the
 * stored watermarks and writes them back, and two policy fetches settle
 * independently at startup.
 */
export function reconcileManagedDefaults(
  store: PreferencesStore,
  io: ManagedDefaultsIo = hostIo,
): Promise<void> {
  queue = queue
    .then(() => reconcile(store, io))
    .catch((err: unknown) => {
      // Nothing was applied or recorded, so the next policy load tries again.
      rWarn(
        "preferences",
        "managed defaults not reconciled; will retry on the next policy load",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    });
  return queue;
}
