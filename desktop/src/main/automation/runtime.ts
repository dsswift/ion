import { Notification } from "electron";
import { debug } from "../logger";
import { broadcast } from "../broadcast";
import { setWorktreeStage, lookupWorktreeStage } from "../worktree/registry";
import { setWorktreePinAdvanceAutomationTrigger } from "../worktree/pin-advance-trigger";
import {
  setWorktreeStageChangeAutomationTrigger,
  type WorktreeStageChange,
} from "../worktree/stage-change-trigger";
import { setWorktreeLifecycleAutomationTrigger } from "../worktree/lifecycle-automation-trigger";
import { setBenchAutomationTrigger } from "../integration/bench-automation-trigger";
import { enterprisePolicyCache } from "../state";
import {
  deriveEnterpriseAutomationPolicy,
  type AutomationAction,
  type AutomationActionContext,
  type AutomationCausation,
  type AutomationDefinition,
  type AutomationEvent,
  type AutomationHistoryEntry,
  type AutomationListing,
  type AutomationRuntimeEvent,
} from "../../shared/types-automation";
import type { WorkStage, WorktreePinAdvance } from "../../shared/types-git";
import { AutomationService } from "./service";
import { runAutomationRendererCommand } from "./renderer-command";

type AutomationBroadcast = (event: AutomationRuntimeEvent) => void;

/** Main-process registry for declarative automation side effects. */
export class AutomationRuntime {
  private readonly lastSlashByTab = new Map<
    string,
    { command: string; args: string; payload: Record<string, unknown> }
  >();
  private readonly lastPromptContextByTab = new Map<
    string,
    Record<string, unknown>
  >();
  private readonly lastStatusByTab = new Map<string, string>();
  readonly service: AutomationService;

  constructor(
    service: AutomationService = new AutomationService({
      enterprisePolicy: () =>
        deriveEnterpriseAutomationPolicy(enterprisePolicyCache.policy),
    }),
    private readonly emit: AutomationBroadcast = (event) =>
      broadcast("ion:automation-event", event),
    private readonly runRendererCommand: (
      action: AutomationAction,
    ) => Promise<void> = runAutomationRendererCommand,
    private readonly notify: (
      title: string,
      body: string,
    ) => void = showNotification,
    private readonly enterprisePolicy: () => ReturnType<
      typeof deriveEnterpriseAutomationPolicy
    > = () => deriveEnterpriseAutomationPolicy(enterprisePolicyCache.policy),
  ) {
    this.service = service;
  }

  definitions(projectPath?: string): AutomationDefinition[] {
    return this.service.effective(projectPath).definitions;
  }
  projectDefinitionIds(projectPath: string): string[] {
    return this.service.projectDefinitionIds(projectPath);
  }
  setProjectDefinitionEnabled(
    projectPath: string,
    id: string,
    enabled: boolean,
  ): void {
    this.service.setProjectDefinitionEnabled(id, enabled, projectPath);
  }
  history(): AutomationHistoryEntry[] {
    return this.service.historyEntries();
  }
  /** Source-aware view for Settings; the runtime itself evaluates only effective. */
  listing(projectPath?: string): AutomationListing {
    return this.service.listing(projectPath);
  }
  saveUserDefinition(definition: AutomationDefinition): AutomationDefinition {
    return this.service.saveUserDefinition(definition);
  }
  deleteUserDefinition(id: string): void {
    this.service.deleteUserDefinition(id);
  }
  duplicateDefinition(id: string, projectPath?: string): AutomationDefinition {
    return this.service.duplicateDefinition(id, projectPath);
  }

  async trigger(
    event: AutomationEvent,
    parentCausation?: AutomationCausation,
  ): Promise<void> {
    // Normalize the current worktree stage onto the payload before any caching
    // or evaluation so every rule — message, slash, completion, plan, pin,
    // lifecycle, and bench — sees the same authoritative `payload.stage`.
    const normalized = normalizeAutomationEvent(event);
    const eventTabId = stringField(normalized.payload, "tabId");
    if (normalized.type === "prompt:submitted" && eventTabId)
      this.lastPromptContextByTab.set(eventTabId, normalized.payload ?? {});
    if (normalized.type === "conversation:slash") {
      const command = stringField(normalized.payload, "slashCommand");
      if (eventTabId && command)
        this.lastSlashByTab.set(eventTabId, {
          command,
          args: stringField(normalized.payload, "slashArgs") ?? "",
          payload: normalized.payload ?? {},
        });
    }
    const projectPath =
      stringField(normalized.payload, "projectPath") ??
      stringField(normalized.payload, "worktreePath");
    const evaluations = await this.service.evaluate(
      normalized,
      (context) => this.runAction(context),
      parentCausation,
      projectPath,
    );
    for (const evaluation of evaluations) {
      this.emit({
        type: "automation:executed",
        automationId: evaluation.automationId,
        eventType: normalized.type,
        outcome: evaluation.outcome,
        worktreePath: stringField(normalized.payload, "worktreePath"),
      });
    }
  }

  async triggerPinAdvance(advance: WorktreePinAdvance): Promise<void> {
    await this.trigger({
      type: "worktree:pin-advanced",
      payload: { ...advance },
    });
  }

  async triggerStatus(
    tabId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const signature = JSON.stringify({
      state: payload.state,
      sessionId: payload.sessionId,
      completionReason: payload.completionReason ?? "",
      permissionDenials: payload.permissionDenials ?? [],
    });
    if (this.lastStatusByTab.get(tabId) === signature) return;
    this.lastStatusByTab.set(tabId, signature);
    await this.trigger({
      type: "engine:status",
      payload: { ...payload, tabId },
    });
  }

  async triggerCompletion(
    tabId: string,
    payload: Record<string, unknown>,
    parentCausation?: AutomationCausation,
  ): Promise<void> {
    await this.trigger({
      type: "conversation:completed",
      payload: {
        ...this.lastPromptContextByTab.get(tabId),
        ...payload,
        tabId,
        lastSlashCommand: this.lastSlashByTab.get(tabId)?.command ?? "",
      },
    }, parentCausation);
  }

  async triggerResolvedSlash(
    tabId: string,
    frontmatter: Record<string, unknown> | undefined,
  ): Promise<void> {
    const slash = this.lastSlashByTab.get(tabId);
    if (!slash) return;
    await this.trigger({
      type: "conversation:slash-resolved",
      payload: {
        ...slash.payload,
        tabId,
        slashCommand: slash.command,
        slashArgs: slash.args,
        frontmatter: frontmatter ?? {},
      },
    });
  }

  async triggerPlanImplemented(
    tabId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.trigger({
      type: "plan:implemented",
      payload: { ...this.lastPromptContextByTab.get(tabId), ...payload, tabId },
    });
  }

  async triggerStageChange(change: WorktreeStageChange): Promise<void> {
    await this.trigger(
      {
        type: "worktree:stage-changed",
        payload: {
          worktreePath: change.worktreePath,
          previousStage: change.previousStage ?? "",
          stage: change.stage ?? "",
          source: change.source,
          automationId: change.automationId ?? "",
        },
      },
      change.causation,
    );
  }

  private async runAction(context: AutomationActionContext): Promise<void> {
    switch (context.action.kind) {
      case "worktree:set-stage":
        this.setWorktreeStage(context);
        return;
      case "desktop:notification":
        this.showDesktopNotification(context.action);
        return;
      case "conversation":
      case "conversation:run":
      case "conversation:slash":
        this.requireAiAuthorization(context);
        await this.runRendererCommand(withEventDirectory(context));
        return;
      case "tab:set-color":
      case "tab:set-icon":
      case "tab:set-group":
        await this.runRendererCommand({
          ...context.action,
          payload: {
            ...context.action.payload,
            __automationCausation: context.causation,
          },
        });
        return;
      case "record":
        return;
      default:
        throw new Error(
          `Unsupported automation action: ${context.action.kind}`,
        );
    }
  }

  private requireAiAuthorization(context: AutomationActionContext): void {
    const enterprise = this.enterprisePolicy();
    const enterpriseDefinition = enterprise?.definitions?.some(
      (definition) => definition.id === context.automation.id,
    );
    if (enterpriseDefinition && enterprise?.authorizeAiActions !== true) {
      throw new Error(
        `Enterprise automation ${context.automation.id} is not authorized to run AI actions`,
      );
    }
  }

  private showDesktopNotification(action: AutomationAction): void {
    const title = stringField(action.payload, "title");
    const body = stringField(action.payload, "body");
    if (!title) throw new Error("desktop:notification requires a title");
    this.notify(title, body ?? "");
  }

  private setWorktreeStage(context: AutomationActionContext): void {
    const worktreePath = stringField(context.event.payload, "worktreePath");
    if (!worktreePath) {
      // Event has no worktree context (plain conversation, no worktree checked out).
      // Skip silently — a worktree action on a non-worktree event is a no-op, not
      // an error. The rule author need not add a "Worktree is present" guard.
      debug("automation", "worktree:set-stage skipped: no worktreePath in event payload", {
        automation_id: context.automation.id,
      });
      return;
    }
    const stage = context.action.payload?.stage;
    if (!isWorkStage(stage))
      throw new Error("worktree:set-stage requires a valid stage");
    const onlyIfStage = context.action.payload?.onlyIfStage;
    if (onlyIfStage !== undefined && !isWorkStage(onlyIfStage))
      throw new Error("worktree:set-stage onlyIfStage must be a valid stage");
    if (
      !setWorktreeStage(worktreePath, stage, undefined, {
        kind: "automation",
        automationId: context.automation.id,
        causationRootId: context.causation.rootId,
        causation: context.causation,
        onlyIfStage,
      })
    ) {
      throw new Error(
        `Could not persist automation stage mutation for ${worktreePath}`,
      );
    }
  }
}

/**
 * Return a copy of the event whose payload carries the current worktree stage.
 *
 * The producer of an event knows a worktree path but not its live stage, so the
 * runtime resolves it here from the registry once, before caching and
 * evaluation. A registered worktree contributes its current stage; an
 * unregistered or unstaged directory leaves `stage` absent (never an
 * empty-string sentinel), which lets a value operator fail closed. A semantic
 * transition that already supplied a stage keeps it when the registry has none.
 */
export function normalizeAutomationEvent(event: AutomationEvent): AutomationEvent {
  const payload: Record<string, unknown> = { ...(event.payload ?? {}) };
  const worktreePath = stringField(payload, "worktreePath");
  if (worktreePath) {
    const stage = lookupWorktreeStage(worktreePath);
    if (stage !== null) payload.stage = stage;
  }
  if (payload.stage === "") delete payload.stage;
  return { ...event, payload };
}

function showNotification(title: string, body: string): void {
  if (!Notification.isSupported())
    throw new Error("Desktop notifications are not supported");
  new Notification({ title, body }).show();
}

function withEventDirectory(
  context: AutomationActionContext,
): AutomationAction {
  if (stringField(context.action.payload, "directory")) return context.action;
  const directory =
    stringField(context.event.payload, "worktreePath") ??
    stringField(context.event.payload, "directory");
  if (!directory)
    throw new Error(
      `${context.action.kind} requires a directory or event worktreePath`,
    );
  return {
    ...context.action,
    payload: {
      ...context.action.payload,
      directory,
      __automationCausation: context.causation,
    },
  };
}

function stringField(
  payload: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = payload?.[field];
  return typeof value === "string" ? value : undefined;
}
function isWorkStage(value: unknown): value is WorkStage {
  return (
    value === "plan" ||
    value === "build" ||
    value === "test" ||
    value === "bug" ||
    value === "verified" ||
    value === "merge" ||
    value === "ready"
  );
}

let runtime: AutomationRuntime | null = null;
export function wireAutomationRuntime(): AutomationRuntime {
  if (!runtime) {
    runtime = new AutomationRuntime();
    setWorktreePinAdvanceAutomationTrigger({
      onWorktreePinAdvance: (advance) => runtime?.triggerPinAdvance(advance),
    });
    setWorktreeStageChangeAutomationTrigger({
      onWorktreeStageChange: (change) => runtime?.triggerStageChange(change),
    });
    setWorktreeLifecycleAutomationTrigger({
      onWorktreeLifecycleEvent: (type, payload) =>
        runtime?.trigger({ type, payload }),
    });
    setBenchAutomationTrigger({
      onBenchEvent: (type, payload) => runtime?.trigger({ type, payload }),
    });
  }
  return runtime;
}
export function getAutomationRuntime(): AutomationRuntime {
  return runtime ?? wireAutomationRuntime();
}
export function resetAutomationRuntimeForTests(): void {
  runtime = null;
}
