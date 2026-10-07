import { log as _log } from "../../logger";
import { flushTranscript } from "../../transcript/transcript-publisher";
import { resolveEngineModel } from "../../resolve-engine-model";
import { sessionPlane, engineBridge } from "../../state";
import { useSessionStore } from "../../store/sessionStore";
import { processIncomingPrompt, type IncomingPrompt } from "../../engine/prompt-pipeline";
import { echoUserTurn } from "../../user-turn-echo";
import { getVoiceSystemPrompt } from "./engine";
import {
  performUnifiedInterrupt,
  performDispatchAbort,
} from "../../engine/engine-control-plane-interrupt";
import {
  awaitPromptDelivery,
  releaseUnclaimedPromptDelivery,
  type PromptOutcome,
} from "../prompt-delivery";
import { setDriving } from "../../protocol/presence";
import type { AbortScope } from "@ion/shared/types-engine";
import type { RemoteCommand } from "../protocol";
import { sendRemoteEvent } from '../../thin-view/remote-out'
import { startPromptHandleSpan } from "../../tracing/prompt-span";
import type { Span } from "@ion/shared/trace-context";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("main", msg, fields);
}

/**
 * Who submitted a prompt, which decides two things: whose voice configuration
 * and presence apply, and how the outcome gets back to them.
 *
 * A paired device on the `desktop_*` wire is told by event
 * (`desktop_prompt_result`). The caller of the `session.prompt` Studio action
 * awaits the outcome as the action's value.
 */
export type PromptOrigin = { kind: "caller"; clientId: string; principalSubject?: string };

/** What `submitClientPrompt` answers. `clientMsgId` is the id the user turn is echoed and persisted under. */
export interface ClientPromptResult extends PromptOutcome {
  clientMsgId: string;
}

/** The id a client's per-client state (voice configuration) is kept under. */
function originClientId(origin: PromptOrigin): string {
  return origin.clientId;
}

/**
 * FR-02 presence: mark `tabId` as driven by whichever principal the submitter
 * is attributed to. A submitter with no principal (no principal partitioning
 * configured) has nothing to attribute -- a no-op.
 */
function markDriving(tabId: string, origin: PromptOrigin): void {
  const subject =
    origin.principalSubject;
  if (subject) setDriving(tabId, subject);
}

/**
 * Resolve the working directory stored for a given tab. Used by handlePrompt
 * to feed the unified prompt pipeline a projectPath for `.md` template
 * expansion — without it, `.md` lookup would only search
 * `~/.claude/commands/` and miss project-scoped commands at
 * `${cwd}/.claude/commands/`. Returns undefined when the tab isn't found.
 */
export async function resolveTabProjectPath(
  tabId: string,
): Promise<string | undefined> {
  const tab = useSessionStore.getState().tabs.find((t) => t.id === tabId);
  return tab?.workingDirectory || undefined;
}

/**
 * Submit a prompt a client typed. One implementation for the `desktop_*`
 * command and the `session.prompt` Studio action.
 *
 * For a `caller` origin the returned promise resolves with the real outcome:
 * accepted once the engine admits the prompt, or once the pipeline finishes
 * having handled it some other way (a command, a shell line, a steer);
 * rejected with the reason otherwise. For a `device` origin the outcome
 * travels as `desktop_prompt_result`, and the value returned here reports
 * only the early rejection this function itself can decide.
 */
export async function submitClientPrompt(
  cmd: Omit<Extract<RemoteCommand, { type: "desktop_prompt" }>, "type">,
  origin: PromptOrigin,
): Promise<ClientPromptResult> {
  // Capture the user-echo timestamp ONCE, before any await. handlePrompt awaits
  // several executeJavaScript round-trips (instance resolution, model override,
  // project-path/plan-file queries) before it builds the echo. Stamping the echo
  // with Date.now() at the send site let the user turn's server timestamp land
  // AFTER the first assistant delta of the same turn — any consumer that orders
  // by the desktop-supplied timestamp then sank the user bubble below the reply
  // ("my message appears under the agent response"). Capturing here, before the
  // first await, makes the echo timestamp monotonically precede every event this
  // turn will produce. Both the engine and CLI branches use `echoTs`.
  const echoTs = Date.now();
  const reqId = cmd.clientMsgId || `remote-${echoTs}`;
  // The server's hop in the prompt's trace: the action.handle span of the
  // `session.prompt` action. Its outcome is recorded in dispatchToPipeline.
  const span = startPromptHandleSpan({
    traceparent: cmd.traceparent,
    tabId: cmd.tabId,
    requestId: reqId,
    surface: "session.prompt",
  });
  const trace = { trace_id: span.traceId };

  // When instanceId is present the iOS client is targeting an engine-hosted
  // conversation (merged from the former desktop_engine_prompt path). Detect
  // this here so we can choose the right pipeline branch below.
  const isEnginePrompt =
    cmd.instanceId !== undefined && cmd.instanceId !== null;

  if (isEnginePrompt) {
    // ── Engine tab path (formerly handleEnginePrompt) ──────────────────
    // Resolve the active instance from the session store.
    // If no instance exists yet (EngineView hasn't mounted), create one.
    let instanceId: string | null =
      cmd.instanceId ||
      useSessionStore.getState().conversationPanes.get(cmd.tabId)
        ?.activeInstanceId ||
      null;

    if (!instanceId) {
      log("handlePrompt (engine): no instance exists, auto-creating one", trace);
      instanceId = useSessionStore.getState().addEngineInstance(cmd.tabId);
      if (!instanceId) {
        log("handlePrompt (engine): failed to create engine instance", trace);
        const reason = "failed to create engine instance";
        span.end({ accepted: false }, reason);
        return { accepted: false, reason, clientMsgId: reqId };
      }
      // Notify iOS about the new instance
      const pane = useSessionStore.getState().conversationPanes.get(
        cmd.tabId,
      );
      const inst = pane?.instances.find((i) => i.id === instanceId);
      const instanceInfo = inst
        ? { id: inst.id, label: inst.label }
        : null;
      if (instanceInfo) {
        sendRemoteEvent({
          type: "desktop_instance_added",
          tabId: cmd.tabId,
          instance: instanceInfo,
        });
      }
      // Send the initial model override so iOS knows the configured model.
      // Resolved in main rather than via executeJavaScript: both inputs (the
      // tab's override in the renderer snapshot cache, and the two preference
      // fallbacks) are already main-owned, so the round-trip bought nothing.
      const modelOverride = resolveEngineModel(cmd.tabId, instanceId);
      if (modelOverride) {
        sendRemoteEvent({
          type: "desktop_model_override",
          tabId: cmd.tabId,
          instanceId,
          model: modelOverride,
        });
      }
      // Session readiness is guaranteed downstream, not by a timer here. The
      // prompt re-enters processIncomingPrompt → the store's unified submit →
      // sessionPlane.submitPrompt, which awaits the
      // idempotent `ensureSession` (engine-control-plane.ts) before dispatching
      // send_prompt. ensureSession resolves only when startSession has returned a
      // live session, so the prompt can never outrun session init. The former
      // `await sleep(500)` was a redundant fixed-delay GUESS at that readiness: it
      // both delayed the user echo (worsening the timestamp-ordering bug fixed via
      // echoTs above) and could still under-wait on a slow start. Removed — the
      // real readiness barrier is the awaited ensureSession downstream.
    }

    // Attachment encoding is owned by processIncomingPrompt. Keep the raw text
    // and raw metadata together until that single routing-aware encoding pass.
    let fullText = cmd.text;
    const attachments = cmd.attachments || [];
    if (attachments.length > 0) {
      const ctx = attachments
        .map((a) => `[Attached ${a.type}: ${a.path}]`)
        .join("\n");
      fullText = `${ctx}\n\n${fullText}`;
    }
    const voicePrompt = getVoiceSystemPrompt(originClientId(origin));
    // Reuse the client's clientMsgId as the engine request id: the owner
    // store stamps it on the row this prompt makes, which is how the client's
    // pending bubble finds its row. Falls back to a fresh id for a prompt that
    // carries no clientMsgId.
    const engineReqId = cmd.clientMsgId || `remote-engine-${echoTs}`;

    // Publish the user's turn to the Studio mirror under engineReqId, the id
    // the owner store's row for this prompt carries. The phone needs no echo:
    // that row reaches it on the transcript stream, stamped with the
    // clientMsgId its pending bubble waits for.
    echoUserTurn({
      tabId: cmd.tabId,
      id: engineReqId,
      content: fullText,
      timestamp: echoTs,
      implementationPhase: cmd.implementationPhase,
    });

    // Resolve project path from the tab (same lookup the CLI path below uses
    // via resolveTabProjectPath). Plan-file path lives on the active
    // conversation instance, not the tab — same field
    // handleSetPermissionMode reads.
    const enginePromptTab = useSessionStore
      .getState()
      .tabs.find((t) => t.id === cmd.tabId);
    const projectPath = enginePromptTab?.workingDirectory || undefined;
    const enginePromptPane = useSessionStore
      .getState()
      .conversationPanes.get(cmd.tabId);
    const enginePromptInstance = enginePromptPane
      ? (enginePromptPane.instances.find(
          (i) => i.id === enginePromptPane.activeInstanceId,
        ) ?? enginePromptPane.instances[0])
      : undefined;
    const planFilePath = enginePromptInstance?.planFilePath || undefined;

    return dispatchToPipeline(origin, true, span, {
      tabId: cmd.tabId,
      text: cmd.text,
      attachments,
      reqId: engineReqId,
      source: "remote",
      hasExtensions: true,
      instanceId,
      appendSystemPrompt: voicePrompt,
      projectPath,
      implementationPhase: cmd.implementationPhase,
      planFilePath,
      traceparent: span.traceparent,
    });
  }

  // ── CLI tab path (original handlePrompt) ──────────────────────────────
  // Publish the user's turn to the Studio mirror with the pre-await `echoTs`
  // (captured at the top of handlePrompt), so the turn's timestamp precedes
  // the turn's assistant deltas. The content carries the attachment markers,
  // as the owner store's row does.
  const cliAttachments = cmd.attachments || [];
  let cliEchoContent = cmd.text;
  if (cliAttachments.length > 0) {
    const ctx = cliAttachments
      .map((a) => `[Attached ${a.type}: ${a.path}]`)
      .join("\n");
    cliEchoContent = `${ctx}\n\n${cliEchoContent}`;
  }
  echoUserTurn({
    tabId: cmd.tabId,
    id: reqId,
    content: cliEchoContent,
    timestamp: echoTs,
    implementationPhase: cmd.implementationPhase,
  });
  // Resolve the tab's working directory from the renderer store so the
  // pipeline can find project-scoped `.md` templates (e.g.
  // ${cwd}/.claude/commands/ion--review-changes.md). The renderer is the
  // authoritative source for per-tab cwd; sessionPlane only stores it
  // implicitly via the most recent submitPrompt. Awaiting this query is
  // cheap (single executeJavaScript round-trip) and the work-in-flight
  // overlap with the engine dispatch is unavoidable anyway.
  const projectPath = await resolveTabProjectPath(cmd.tabId);
  // For a device the pipeline is fire-and-forget. Errors are logged inside the
  // pipeline; we never want a thrown error here to crash the transport.
  return dispatchToPipeline(origin, false, span, {
    tabId: cmd.tabId,
    text: cmd.text,
    attachments: cmd.attachments,
    reqId,
    source: "remote",
    hasExtensions: false,
    projectPath,
    implementationPhase: cmd.implementationPhase,
    traceparent: span.traceparent,
  });
}

/**
 * Register who gets the outcome, then run the pipeline.
 *
 * A device is answered by event, so its pipeline may run on (awaited only on
 * the engine path, which always was). A caller is answered by value, so its
 * pipeline is awaited: once it returns, a prompt bound for the engine has
 * claimed its delivery and the claimer settles it, and one still unclaimed
 * was handled without an engine admission and is settled here.
 */
async function dispatchToPipeline(
  origin: PromptOrigin,
  awaitForDevice: boolean,
  span: Span,
  prompt: IncomingPrompt,
): Promise<ClientPromptResult> {
  const { tabId, reqId } = prompt;
  const trace = { trace_id: span.traceId };
  markDriving(tabId, origin);
  // The store's submit claims this entry and sends the span's traceparent to
  // the engine instead of opening a second action.handle.
  const outcome = awaitPromptDelivery(reqId, tabId, span.traceparent);
  try {
    await processIncomingPrompt(prompt);
    if (releaseUnclaimedPromptDelivery(reqId, { accepted: true })) {
      log("submit_prompt: pipeline handled the prompt without an engine admission", { tab_id: tabId, req_id: reqId, ...trace });
    }
  } catch (err) {
    const reason = (err as Error).message;
    log("submit_prompt: pipeline error", { tab_id: tabId, req_id: reqId, error: reason, ...trace });
    releaseUnclaimedPromptDelivery(reqId, { accepted: false, reason });
  }
  const settled = await outcome;
  span.end({ accepted: settled.accepted }, settled.accepted ? undefined : settled.reason ?? "prompt rejected");
  // The row this prompt made must reach a thin client before the result that
  // says the prompt was accepted: the client drops its pending bubble when the
  // result arrives, and a result that beat its row would leave the turn
  // missing from the screen until the next patch.
  flushTranscript(tabId);
  log("submit_prompt: outcome", { tab_id: tabId, req_id: reqId, accepted: settled.accepted, reason: settled.reason, ...trace });
  return { ...settled, clientMsgId: reqId };
}

export function handleCancel(
  cmd: Extract<RemoteCommand, { type: "desktop_cancel" }>,
): void {
  // Absent scope means full teardown — the shape older clients send.
  const scope: AbortScope =
    cmd.scope === "orchestrator" || cmd.scope === "all_work" ? cmd.scope : "all";
  if (!sessionPlane.cancelTab(cmd.tabId, scope)) {
    log("remote_cancel: not in session plane, direct interrupt", {
      tab_id: cmd.tabId,
      abort_scope: scope,
    });
    // Mirror cancelTab's interrupt on the not-in-plane fallback path, at the
    // same scope. Otherwise a cancel that misses the session plane (e.g. a tab
    // the control plane doesn't track) would behave differently from one that
    // hits it.
    performUnifiedInterrupt(engineBridge, cmd.tabId, scope);
  }
}

/**
 * Stop one background dispatch from a remote client. Falls back to the bridge
 * when the tab is not tracked by the session plane, matching handleCancel — a
 * dispatch stop must not depend on control-plane bookkeeping the engine does
 * not share.
 */
export function handleAbortDispatch(
  cmd: Extract<RemoteCommand, { type: "desktop_abort_dispatch" }>,
): void {
  if (!cmd.dispatchId) {
    log("remote_abort_dispatch: rejecting empty dispatchId", {
      tab_id: cmd.tabId,
    });
    return;
  }
  if (!sessionPlane.abortDispatch(cmd.tabId, cmd.dispatchId)) {
    log("remote_abort_dispatch: not in session plane, direct abort", {
      tab_id: cmd.tabId,
      dispatch_id: cmd.dispatchId,
    });
    performDispatchAbort(engineBridge, cmd.tabId, cmd.dispatchId);
  }
}

/** Tab ids are opaque keys; refuse anything that is not one rather than
 *  letting it reach the store as a fabricated conversation key. */
const DRAFT_TAB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * A remote client's unsent composer text.
 *
 * The draft is durable conversation state — the store writes it onto the
 * conversation pane and the tabs file carries it across a restart — so a
 * phone's half-typed prompt is not the phone's private business: it is the
 * same draft the desktop composer adopts when it opens the conversation.
 *
 * The text itself is never logged; it is the operator's unsent words. Length
 * is what tells a diagnosis whether the write arrived and whether it was a
 * keystroke or a clear.
 */
export function handleSetDraft(cmd: Extract<RemoteCommand, { type: 'desktop_set_draft' }>): void {
  if (!DRAFT_TAB_ID_RE.test(cmd.tabId)) {
    log('draft rejected: bad tabId', { tab_id: String(cmd.tabId).slice(0, 32) })
    return
  }
  if (typeof cmd.text !== 'string') {
    log('draft rejected: text is not a string', { tab_id: cmd.tabId.slice(0, 8) })
    return
  }
  const known = useSessionStore.getState().tabs.some((t) => t.id === cmd.tabId)
  if (!known) {
    log('draft rejected: unknown tab', { tab_id: cmd.tabId.slice(0, 8) })
    return
  }
  useSessionStore.getState().setDraftInput(cmd.tabId, cmd.text)
  log('remote draft applied', { tab_id: cmd.tabId.slice(0, 8), count: cmd.text.length })
}
