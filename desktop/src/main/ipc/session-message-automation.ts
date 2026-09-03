import { getAutomationRuntime } from "../automation/runtime";
import { classifyAutomationMessageKind } from "../../shared/automation-message-kind";
import type { AutomationCausation } from "../../shared/types-automation";
import type { SteerMeta } from "../../shared/types";
import { parseSlash } from "../slash-parse";
import { warn as _warn } from "../logger";

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn("main", msg, fields);
}

/**
 * Emit the Desktop Automation `conversation:message-submitted` fact for an
 * admitted fresh prompt. Fires once per prompt, alongside the retained
 * `prompt:submitted`, carrying the authorship classification so a rule can
 * target only real operator prompts. Awaited within the prompt handler's try.
 */
export async function emitFreshMessageSubmitted(args: {
  tabId: string;
  requestId: string;
  clientMessageId: string;
  projectPath: string;
  permissionMode: string;
  source: RunSource;
  messageKind?: ReturnType<typeof classifyAutomationMessageKind>;
  injectionKind?: string;
  isSlash: boolean;
  causation?: AutomationCausation;
}): Promise<void> {
  await getAutomationRuntime().trigger(
    {
      type: "conversation:message-submitted",
      payload: {
        tabId: args.tabId,
        requestId: args.requestId,
        clientMessageId: args.clientMessageId,
        projectPath: args.projectPath,
        worktreePath: args.projectPath,
        permissionMode: args.permissionMode,
        source: args.source ?? "desktop",
        messageKind:
          args.messageKind ??
          classifyAutomationMessageKind({
            source: args.source,
            injectionKind: args.injectionKind,
            isSlash: args.isSlash,
          }),
        isSteer: false,
      },
    },
    args.causation,
  );
}

type RunSource = "desktop" | "remote" | "machine" | undefined;

/**
 * Emit the same fact for an admitted mid-run Steer (isSteer: true). The steer
 * IPC is fire-and-forget, so this is voided with an explicit failure log rather
 * than awaited. permissionMode is resolved from the live tab status here;
 * authorship + worktree path ride the optional steer metadata.
 */
export function emitSteerMessageSubmitted(args: {
  tabId: string;
  message: string;
  clientMessageId?: string;
  meta?: SteerMeta;
  permissionMode: string;
}): void {
  const steerSlash = parseSlash(args.message);
  void getAutomationRuntime()
    .trigger({
      type: "conversation:message-submitted",
      payload: {
        tabId: args.tabId,
        clientMessageId: args.clientMessageId ?? "",
        projectPath: args.meta?.projectPath ?? "",
        worktreePath: args.meta?.worktreePath ?? args.meta?.projectPath ?? "",
        permissionMode: args.permissionMode,
        source: args.meta?.source ?? "desktop",
        messageKind:
          args.meta?.messageKind ??
          classifyAutomationMessageKind({
            source: args.meta?.source,
            injectionKind: args.meta?.injectionKind,
            isSlash: !!steerSlash,
          }),
        isSteer: true,
      },
    })
    .catch((err) => {
      warn("steer message-submitted automation failed", {
        tab_id: args.tabId,
        error: String(err),
      });
    });
}
