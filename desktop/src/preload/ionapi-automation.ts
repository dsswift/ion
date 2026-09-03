/**
 * The automation portion of the IonAPI contextBridge surface, split out of
 * ionapi-core.ts so the core interface stays under the 600-line cap and the
 * automation bridge is a cohesive domain module. index.ts merges the matching
 * `automationApi` implementation once.
 */
import type {
  AutomationAction,
  AutomationDefinition,
  AutomationHistoryEntry,
  AutomationListing,
  AutomationRuntimeEvent,
} from "../shared/types-automation";

export interface AutomationMutationResult {
  ok: boolean;
  error?: string;
  definition?: AutomationDefinition;
}

/**
 * Automation definition, history, and execution bridge. No renderer executes
 * actions; the main process owns evaluation and persistence. Settings reads the
 * source-aware listing and mutates one user definition at a time.
 */
export interface IonAutomationApi {
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
  automationProjectIds(projectPath: string): Promise<string[]>;
  setProjectAutomationEnabled(
    projectPath: string,
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }>;
  triggerPlanImplemented(payload: {
    tabId: string;
    worktreePath: string;
    repoPath: string;
    branchName: string;
    sourceBranch: string;
    planFilePath: string;
    clearContext: boolean;
    source: "renderer";
  }): Promise<void>;
  onAutomationEvent(
    callback: (event: AutomationRuntimeEvent) => void,
  ): () => void;
  onAutomationCommand(
    callback: (command: { id: string; action: AutomationAction }) => void,
  ): () => void;
  resolveAutomationCommand(
    id: string,
    result: { ok: boolean; error?: string },
  ): void;
}
