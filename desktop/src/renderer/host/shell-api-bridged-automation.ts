/**
 * Bridged `host.shell` verbs, automation domain: every one is served by a
 * `studio_action` or `studio_event` on every host (`browser-shell-bridge.ts`),
 * so the Electron preload no longer carries it. Moved verbatim from the
 * preload's `ionapi-automation.ts` (spec 12: `IonAPI` shrinks toward the natives and the
 * host relay, `ShellApi` keeps the full surface).
 */
import type { AutomationAction, AutomationDefinition, AutomationHistoryEntry, AutomationListing } from "@ion/shared/types-automation";

export interface AutomationMutationResult {
  ok: boolean;
  error?: string;
  definition?: AutomationDefinition;
}

export interface BridgedAutomationShell {
  /** Source-aware listing: every layer, effective flags, override + disabled state. */
  automationListing(projectPath?: string): Promise<AutomationListing>;
  /** Create or replace one user definition. Rejected if it cannot run. */
  automationUpsert(
    definition: AutomationDefinition,
  ): Promise<AutomationMutationResult>;
  /** Delete one user definition. */
  automationDelete(id: string): Promise<{ ok: boolean; error?: string }>;
  /** Duplicate any readable definition into a new, disabled user definition. */
  automationDuplicate(
    id: string,
    projectPath?: string,
  ): Promise<AutomationMutationResult>;
  automationHistory(): Promise<AutomationHistoryEntry[]>;
  setProjectAutomationEnabled(
    projectPath: string,
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }>;
  onAutomationCommand(
    callback: (command: { id: string; action: AutomationAction }) => void,
  ): () => void;
  resolveAutomationCommand(
    id: string,
    result: { ok: boolean; error?: string },
  ): void;
}
