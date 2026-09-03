import { randomUUID } from "crypto";
import { error as _error, log as _log, warn as _warn } from "../logger";
import {
  continueAutomationCausation,
  DEFAULT_MAX_AUTOMATION_DEPTH,
} from "./causation";
import { evaluateCondition, runSteps } from "./declarative";
import { AutomationHistoryStore } from "./history";
import { listAutomationLayers, mergeAutomationLayers } from "./merge";
import { validateUserDefinition } from "../../shared/automation-catalog";
import {
  AutomationDefinitionSource,
  AutomationStore,
  ProjectAutomationStateStore,
  projectAutomationDirectory,
  projectAutomationStateFile,
  validateUniqueDefinitions,
} from "./store";
import type {
  AutomationActionRunner,
  AutomationCausation,
  AutomationDefinition,
  AutomationEvaluation,
  AutomationEvent,
  AutomationEvaluationTrace,
  AutomationHistoryEntry,
  AutomationLayers,
  AutomationListing,
  EffectiveAutomations,
} from "./types";
import { cloneDefinition } from "../../shared/types-automation";

const TAG = "automation.service";
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields);
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields);
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error(TAG, msg, fields);
}

export interface AutomationServiceOptions {
  builtIn?: readonly AutomationDefinition[];
  enterprise?: AutomationLayers["enterprise"];
  enterprisePolicy?: () => AutomationLayers["enterprise"];
  store?: AutomationStore;
  projectPath?: string;
  projectSource?: AutomationDefinitionSource;
  projectState?: ProjectAutomationStateStore;
  history?: AutomationHistoryStore;
  maxCausationDepth?: number;
}

/** Main-process orchestration boundary for durable automations. */
export class AutomationService {
  private readonly store: AutomationStore;
  private readonly projectSource?: AutomationDefinitionSource;
  private readonly projectState?: ProjectAutomationStateStore;
  private readonly history: AutomationHistoryStore;
  private readonly builtIn: readonly AutomationDefinition[];
  private readonly enterprise: AutomationLayers["enterprise"];
  private readonly enterprisePolicy: () => AutomationLayers["enterprise"];
  private readonly maxCausationDepth: number;

  constructor(options: AutomationServiceOptions = {}) {
    this.store = options.store ?? new AutomationStore();
    this.projectSource =
      options.projectSource ??
      (options.projectPath
        ? new AutomationDefinitionSource(
            projectAutomationDirectory(options.projectPath),
          )
        : undefined);
    this.projectState =
      options.projectState ??
      (options.projectPath
        ? new ProjectAutomationStateStore(
            projectAutomationStateFile(options.projectPath),
          )
        : undefined);
    this.history = options.history ?? new AutomationHistoryStore();
    this.builtIn = options.builtIn ?? [];
    this.enterprise = options.enterprise;
    this.enterprisePolicy = options.enterprisePolicy ?? (() => this.enterprise);
    this.maxCausationDepth =
      options.maxCausationDepth ?? DEFAULT_MAX_AUTOMATION_DEPTH;
  }

  /** Build the layer inputs once so effective() and listing() cannot disagree. */
  private layers(projectPath?: string): AutomationLayers {
    const projectSource = projectPath
      ? new AutomationDefinitionSource(projectAutomationDirectory(projectPath))
      : this.projectSource;
    const projectState = projectPath
      ? new ProjectAutomationStateStore(projectAutomationStateFile(projectPath))
      : this.projectState;
    return {
      builtIn: this.builtIn,
      user: this.store.load(),
      project: projectSource?.load(),
      projectDisabledIds: projectState?.loadDisabledIds(),
      enterprise: this.enterprisePolicy(),
    };
  }

  effective(projectPath?: string): EffectiveAutomations {
    return mergeAutomationLayers(this.layers(projectPath));
  }

  /** Source-aware view for Settings — every source layer, not only winners. */
  listing(projectPath?: string): AutomationListing {
    return listAutomationLayers(this.layers(projectPath));
  }

  userDefinitions(): AutomationDefinition[] {
    return this.store.load();
  }

  projectDefinitionIds(projectPath: string): string[] {
    return new AutomationDefinitionSource(
      projectAutomationDirectory(projectPath),
    )
      .load()
      .map((definition) => definition.id);
  }

  setProjectDefinitionEnabled(
    id: string,
    enabled: boolean,
    projectPath: string,
  ): void {
    const source = new AutomationDefinitionSource(
      projectAutomationDirectory(projectPath),
    );
    if (!source.load().some((definition) => definition.id === id))
      throw new Error(`Unknown project automation id: ${id}`);
    const state = new ProjectAutomationStateStore(
      projectAutomationStateFile(projectPath),
    );
    const disabled = new Set(state.loadDisabledIds());
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    state.saveDisabledIds([...disabled]);
  }

  historyEntries(): AutomationHistoryEntry[] {
    return this.history.load();
  }

  saveUserDefinitions(definitions: readonly AutomationDefinition[]): void {
    if (this.effective().locked)
      throw new Error("Enterprise policy locks automation changes");
    validateUniqueDefinitions(definitions);
    this.store.save(definitions);
  }

  /**
   * Create or replace ONE user definition. The main process is the source of
   * truth: it reloads the user store, applies exactly this change, validates the
   * result against the catalog and uniqueness, then writes the whole user set
   * atomically. It never trusts a renderer to send the complete list, so no
   * project, enterprise, or built-in definition can be copied into the user
   * store by a save.
   */
  saveUserDefinition(definition: AutomationDefinition): AutomationDefinition {
    this.assertUnlocked();
    const validation = validateUserDefinition(definition);
    if (!validation.ok) throw new Error(validation.error);
    const saved: AutomationDefinition = {
      ...cloneDefinition(definition),
      updatedAt: new Date().toISOString(),
    };
    const next = this.store.load().filter((d) => d.id !== saved.id);
    next.push(saved);
    validateUniqueDefinitions(next);
    this.store.save(next);
    return saved;
  }

  /** Delete ONE user definition. A no-op id leaves the user set unchanged. */
  deleteUserDefinition(id: string): void {
    this.assertUnlocked();
    const current = this.store.load();
    const next = current.filter((d) => d.id !== id);
    if (next.length === current.length) return;
    this.store.save(next);
  }

  /**
   * Duplicate any readable definition (from any source) into a NEW disabled user
   * definition with a fresh id. Copying is how a project, enterprise, or
   * built-in rule becomes editable without ever mutating its source layer.
   */
  duplicateDefinition(
    id: string,
    projectPath?: string,
  ): AutomationDefinition {
    this.assertUnlocked();
    const source = this.findReadableDefinition(id, projectPath);
    if (!source) throw new Error(`Unknown automation id: ${id}`);
    const now = new Date().toISOString();
    const copy: AutomationDefinition = {
      ...cloneDefinition(source),
      id: `user.${randomUUID()}`,
      name: `${source.name} (copy)`,
      enabled: false,
      createdAt: now,
      updatedAt: now,
    };
    const next = this.store.load();
    next.push(copy);
    validateUniqueDefinitions(next);
    this.store.save(next);
    return copy;
  }

  private assertUnlocked(): void {
    if (this.effective().locked)
      throw new Error("Enterprise policy locks automation changes");
  }

  private findReadableDefinition(
    id: string,
    projectPath?: string,
  ): AutomationDefinition | undefined {
    const entries = this.listing(projectPath).entries.filter(
      (entry) => entry.definition.id === id,
    );
    if (entries.length === 0) return undefined;
    // Prefer the effective winner so a duplicate copies what actually runs.
    return (entries.find((entry) => entry.effective) ?? entries[0]).definition;
  }

  async evaluate(
    event: AutomationEvent,
    runner: AutomationActionRunner,
    parentCausation?: AutomationCausation,
    projectPath?: string,
  ): Promise<AutomationEvaluation[]> {
    const effective = this.effective(projectPath);
    const rootCausation = parentCausation ?? {
      rootId: randomUUID(),
      chain: [],
      depth: 0,
    };
    const candidates = effective.definitions
      .filter(
        (definition) =>
          definition.enabled && definition.trigger.event === event.type,
      )
      .map((automation) => ({
        automation,
        condition: evaluateCondition(automation.condition, event),
      }));
    log("automation event evaluated", {
      event_type: event.type,
      candidates: candidates.length,
    });
    const results: AutomationEvaluation[] = [];

    for (const { automation, condition } of candidates) {
      if (!condition.matched) {
        const skippedAt = new Date().toISOString();
        const trace: AutomationEvaluationTrace = {
          trigger: triggerTrace(event),
          condition,
          causation: {
            decision: "not-evaluated",
            input: rootCausation,
          },
          steps: [],
        };
        this.history.append(
          {
            id: randomUUID(),
            automationId: automation.id,
            eventType: event.type,
            causation: rootCausation,
            startedAt: skippedAt,
            finishedAt: skippedAt,
            outcome: "skipped",
            error: "condition:false",
            trace,
          },
          effective.maxHistoryEntries,
        );
        results.push({
          automationId: automation.id,
          outcome: "skipped",
          reason: "condition",
        });
        continue;
      }
      const decision = continueAutomationCausation(
        rootCausation,
        automation.id,
        this.maxCausationDepth,
      );
      if (!decision.ok) {
        warn("automation skipped by causation guard", {
          automation_id: automation.id,
          event_type: event.type,
          reason: decision.reason,
        });
        const skippedAt = new Date().toISOString();
        const trace: AutomationEvaluationTrace = {
          trigger: triggerTrace(event),
          condition,
          causation: {
            decision: decision.reason,
            input: rootCausation,
          },
          steps: [],
        };
        this.history.append(
          {
            id: randomUUID(),
            automationId: automation.id,
            eventType: event.type,
            causation: rootCausation,
            startedAt: skippedAt,
            finishedAt: skippedAt,
            outcome: "skipped",
            error: `causation:${decision.reason}`,
            trace,
          },
          effective.maxHistoryEntries,
        );
        results.push({
          automationId: automation.id,
          outcome: "skipped",
          reason: decision.reason,
        });
        continue;
      }

      const startedAt = new Date().toISOString();
      const trace: AutomationEvaluationTrace = {
        trigger: triggerTrace(event),
        condition,
        causation: {
          decision: "continued",
          input: rootCausation,
          output: decision.causation,
        },
        steps: [],
      };
      let failure: string | undefined;
      try {
        await runSteps(
          automation.steps ?? automation.actions ?? [],
          { automation, event, causation: decision.causation },
          runner,
          trace.steps,
        );
      } catch (err) {
        failure = String(err);
        error("automation action failed", {
          automation_id: automation.id,
          event_type: event.type,
          error: failure,
        });
      }
      const finishedAt = new Date().toISOString();
      const outcome = failure ? "failed" : "succeeded";
      this.history.append(
        {
          id: randomUUID(),
          automationId: automation.id,
          eventType: event.type,
          causation: decision.causation,
          startedAt,
          finishedAt,
          outcome,
          error: failure,
          trace,
        },
        effective.maxHistoryEntries,
      );
      results.push({
        automationId: automation.id,
        outcome,
        causation: decision.causation,
        error: failure,
      });
    }
    return results;
  }
}

function triggerTrace(event: AutomationEvent): AutomationEvaluationTrace["trigger"] {
  return event.occurredAt
    ? { eventType: event.type, occurredAt: event.occurredAt }
    : { eventType: event.type };
}
