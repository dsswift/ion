// hook_descriptors.go — one typed descriptor per engine hook.
//
// Split from hooks.go so the names, the generic machinery, and this table each
// live in their own file. The table is the SDK's claim about the engine's hook
// surface: parity_test.go reads the engine's contract manifest and asserts
// that every hook in it has a descriptor here whose payload fields match, and
// that no descriptor here names a hook the engine does not fire.
//
// Result types follow the manifest's result categories:
//
//	none        -> NoResult      (the engine discards the return)
//	string      -> StringResult  (non-empty replaces an engine value)
//	bool        -> BoolResult    (false cancels)
//	block       -> ToolCallResult
//	perToolCall -> PerToolCallResult
//	rejection   -> ContextRejectionResult
//	content     -> json.RawMessage (pass-through, no fixed schema)
//	structured  -> the hook's own result struct
//	asyncVeto   -> AsyncRegistrationVeto
package ion

import "encoding/json"

// --- Lifecycle ---

// HookSessionStart fires when a session begins.
var HookSessionStart = Hook[NoPayload, NoResult]{Name: HookNameSessionStart}

// HookSessionEnd fires when a session ends.
var HookSessionEnd = Hook[NoPayload, NoResult]{Name: HookNameSessionEnd}

// HookBeforePrompt fires before the user's prompt reaches the model. The
// handler may rewrite the prompt or append to the system prompt.
var HookBeforePrompt = Hook[string, BeforePromptResult]{Name: HookNameBeforePrompt}

// HookTurnStart fires at the start of each agent-loop turn.
var HookTurnStart = Hook[TurnInfo, NoResult]{Name: HookNameTurnStart}

// HookTurnEnd fires at the end of each agent-loop turn.
var HookTurnEnd = Hook[TurnInfo, NoResult]{Name: HookNameTurnEnd}

// HookMessageStart fires when the model begins a message.
var HookMessageStart = Hook[NoPayload, NoResult]{Name: HookNameMessageStart}

// HookMessageEnd fires when the model finishes a message.
var HookMessageEnd = Hook[NoPayload, NoResult]{Name: HookNameMessageEnd}

// HookToolStart fires as a tool begins executing.
var HookToolStart = Hook[ToolStartInfo, NoResult]{Name: HookNameToolStart}

// HookToolEnd fires as a tool finishes executing.
var HookToolEnd = Hook[NoPayload, NoResult]{Name: HookNameToolEnd}

// HookToolCall fires before any tool runs. Return Block to refuse it.
var HookToolCall = Hook[ToolCallInfo, ToolCallResult]{Name: HookNameToolCall}

// HookOnError fires when the engine encounters an error.
var HookOnError = Hook[ErrorInfo, NoResult]{Name: HookNameOnError}

// HookAgentStart fires when an agent begins. Check IsRoot to tell the
// conversation's own agent from a dispatched sub-agent.
var HookAgentStart = Hook[AgentInfo, NoResult]{Name: HookNameAgentStart}

// HookAgentEnd fires when an agent finishes.
var HookAgentEnd = Hook[AgentInfo, NoResult]{Name: HookNameAgentEnd}

// --- Session management ---

// HookSessionBeforeCompact fires before compaction. Return false to cancel.
var HookSessionBeforeCompact = Hook[CompactionInfo, BoolResult]{Name: HookNameSessionBeforeCompact}

// HookSessionCompact fires after compaction completes.
var HookSessionCompact = Hook[CompactionInfo, NoResult]{Name: HookNameSessionCompact}

// HookSessionBeforeFork fires before a session fork. Return false to cancel.
var HookSessionBeforeFork = Hook[ForkInfo, BoolResult]{Name: HookNameSessionBeforeFork}

// HookSessionFork fires after a session fork.
var HookSessionFork = Hook[ForkInfo, NoResult]{Name: HookNameSessionFork}

// HookSessionBeforeSwitch fires before the session switches conversations.
var HookSessionBeforeSwitch = Hook[NoPayload, NoResult]{Name: HookNameSessionBeforeSwitch}

// HookCompactSummaryRequest asks the harness for a compaction summary,
// short-circuiting the engine's regex fact extractor. Return an empty summary
// to abstain.
var HookCompactSummaryRequest = Hook[CompactSummaryRequestInfo, CompactSummaryRequestResult]{Name: HookNameCompactSummaryRequest}

// --- Pre-action ---

// HookBeforeAgentStart fires before an agent starts, allowing a system-prompt
// or name override.
var HookBeforeAgentStart = Hook[AgentInfo, BeforeAgentStartResult]{Name: HookNameBeforeAgentStart}

// HookBeforeProviderRequest fires before each outbound provider request.
var HookBeforeProviderRequest = Hook[json.RawMessage, NoResult]{Name: HookNameBeforeProviderRequest}

// --- Early stop ---

// HookBeforeEarlyStopDecision fires while the engine weighs nudging the model
// to keep working. The handler can override the decision.
var HookBeforeEarlyStopDecision = Hook[EarlyStopDecisionInfo, EarlyStopDecisionResult]{Name: HookNameBeforeEarlyStopDecision}

// HookEarlyStopContinued fires after a continuation nudge went out.
var HookEarlyStopContinued = Hook[EarlyStopContinuedInfo, NoResult]{Name: HookNameEarlyStopContinued}

// --- Content ---

// HookContext fires as context is assembled. Return a string to contribute.
var HookContext = Hook[json.RawMessage, StringResult]{Name: HookNameContext}

// HookMessageUpdate fires as a message is updated.
var HookMessageUpdate = Hook[MessageUpdateInfo, json.RawMessage]{Name: HookNameMessageUpdate}

// HookToolResult fires with a tool's result.
var HookToolResult = Hook[ToolResultInfo, json.RawMessage]{Name: HookNameToolResult}

// HookInput fires on raw user input. Return a string to rewrite it.
var HookInput = Hook[string, StringResult]{Name: HookNameInput}

// HookModelSelect fires during model selection. Return a model name to
// override.
var HookModelSelect = Hook[ModelSelectInfo, StringResult]{Name: HookNameModelSelect}

// HookUserBash fires when the user runs a bash command directly.
var HookUserBash = Hook[string, NoResult]{Name: HookNameUserBash}

// HookSlashCommandResolved fires after the engine expands a slash command.
// Return a string to override the expansion.
var HookSlashCommandResolved = Hook[SlashCommandResolvedInfo, StringResult]{Name: HookNameSlashCommandResolved}

// --- Per-tool call ---

// HookBashToolCall fires before the Bash tool runs.
var HookBashToolCall = Hook[ToolInput, PerToolCallResult]{Name: HookNameBashToolCall}

// HookReadToolCall fires before the Read tool runs.
var HookReadToolCall = Hook[ToolInput, PerToolCallResult]{Name: HookNameReadToolCall}

// HookWriteToolCall fires before the Write tool runs.
var HookWriteToolCall = Hook[ToolInput, PerToolCallResult]{Name: HookNameWriteToolCall}

// HookEditToolCall fires before the Edit tool runs.
var HookEditToolCall = Hook[ToolInput, PerToolCallResult]{Name: HookNameEditToolCall}

// HookGrepToolCall fires before the Grep tool runs.
var HookGrepToolCall = Hook[ToolInput, PerToolCallResult]{Name: HookNameGrepToolCall}

// HookGlobToolCall fires before the Glob tool runs.
var HookGlobToolCall = Hook[ToolInput, PerToolCallResult]{Name: HookNameGlobToolCall}

// HookAgentToolCall fires before the Agent tool runs.
var HookAgentToolCall = Hook[ToolInput, PerToolCallResult]{Name: HookNameAgentToolCall}

// --- Per-tool result ---

// HookBashToolResult fires with the Bash tool's result.
var HookBashToolResult = Hook[ToolResultInfo, NoResult]{Name: HookNameBashToolResult}

// HookReadToolResult fires with the Read tool's result.
var HookReadToolResult = Hook[ToolResultInfo, NoResult]{Name: HookNameReadToolResult}

// HookWriteToolResult fires with the Write tool's result.
var HookWriteToolResult = Hook[ToolResultInfo, NoResult]{Name: HookNameWriteToolResult}

// HookEditToolResult fires with the Edit tool's result.
var HookEditToolResult = Hook[ToolResultInfo, NoResult]{Name: HookNameEditToolResult}

// HookGrepToolResult fires with the Grep tool's result.
var HookGrepToolResult = Hook[ToolResultInfo, NoResult]{Name: HookNameGrepToolResult}

// HookGlobToolResult fires with the Glob tool's result.
var HookGlobToolResult = Hook[ToolResultInfo, NoResult]{Name: HookNameGlobToolResult}

// HookAgentToolResult fires with the Agent tool's result.
var HookAgentToolResult = Hook[ToolResultInfo, NoResult]{Name: HookNameAgentToolResult}

// --- Context discovery ---

// HookContextDiscover fires per discovered context file. Return false to
// exclude it.
var HookContextDiscover = Hook[ContextDiscoverInfo, BoolResult]{Name: HookNameContextDiscover}

// HookContextLoad fires as a context file is loaded. Supply replacement
// content or reject the file.
var HookContextLoad = Hook[ContextLoadInfo, ContextRejectionResult]{Name: HookNameContextLoad}

// HookInstructionLoad fires as an instruction file is loaded.
var HookInstructionLoad = Hook[ContextLoadInfo, ContextRejectionResult]{Name: HookNameInstructionLoad}

// --- Permissions ---

// HookPermissionRequest fires when a permission decision is made.
var HookPermissionRequest = Hook[PermissionRequestInfo, NoResult]{Name: HookNamePermissionRequest}

// HookPermissionDenied fires when a permission is denied.
var HookPermissionDenied = Hook[PermissionDeniedInfo, NoResult]{Name: HookNamePermissionDenied}

// HookPermissionClassify is the pluggable permission classifier. Return the
// classification string.
var HookPermissionClassify = Hook[PermissionClassifyInfo, StringResult]{Name: HookNamePermissionClassify}

// --- Files ---

// HookFileChanged fires after the model's Write or Edit tool writes a file.
// External edits do not fire it.
var HookFileChanged = Hook[FileChangedInfo, NoResult]{Name: HookNameFileChanged}

// HookWorkspaceFileChanged fires on any non-ignored change under the session's
// working directory, whatever made it.
var HookWorkspaceFileChanged = Hook[WorkspaceFileChangedInfo, NoResult]{Name: HookNameWorkspaceFileChanged}

// --- Tasks ---

// HookTaskCreated fires when a turn task is created.
var HookTaskCreated = Hook[TaskLifecycleInfo, NoResult]{Name: HookNameTaskCreated}

// HookTaskCompleted fires when a turn task completes.
var HookTaskCompleted = Hook[TaskLifecycleInfo, NoResult]{Name: HookNameTaskCompleted}

// HookBackgroundTaskCompleted fires when a background shell command reaches a
// terminal state.
var HookBackgroundTaskCompleted = Hook[BackgroundTaskCompletedInfo, NoResult]{Name: HookNameBackgroundTaskCompleted}

// --- Dispatch loss ---

// HookDispatchLost fires once per dispatch that was running when the engine
// process died, during rehydration at session start. Observe-only; the engine
// has already emitted engine_dispatch_lost and marked the agent-state row
// "error" by the time a handler runs.
var HookDispatchLost = Hook[DispatchLostInfo, NoResult]{Name: HookNameDispatchLost}

// --- Elicitation ---

// HookElicitationRequest fires when the engine asks the user for input.
var HookElicitationRequest = Hook[ElicitationRequestInfo, json.RawMessage]{Name: HookNameElicitationRequest}

// HookElicitationResult fires with the user's answer.
var HookElicitationResult = Hook[ElicitationResultInfo, NoResult]{Name: HookNameElicitationResult}

// --- Plan mode ---

// HookPlanModePrompt fires as the plan-mode prompt is built. Return a string
// to replace it.
var HookPlanModePrompt = Hook[string, StringResult]{Name: HookNamePlanModePrompt}

// HookBeforePlanModeEnter fires before entering plan mode. Veto with Allow.
var HookBeforePlanModeEnter = Hook[PlanModeEnterInfo, BeforePlanModeEnterResult]{Name: HookNameBeforePlanModeEnter}

// HookBeforePlanModeExit fires before leaving plan mode. Veto with Allow.
var HookBeforePlanModeExit = Hook[BeforePlanModeExitInfo, BeforePlanModeExitResult]{Name: HookNameBeforePlanModeExit}

// HookBeforePlanModeAutoExit fires before the engine leaves plan mode on its
// own. Suppress to keep the session in plan mode.
var HookBeforePlanModeAutoExit = Hook[BeforePlanModeAutoExitInfo, BeforePlanModeAutoExitResult]{Name: HookNameBeforePlanModeAutoExit}

// HookSystemInject fires before the engine injects any system message. Return
// a string to replace the engine's text.
var HookSystemInject = Hook[SystemInjectInfo, StringResult]{Name: HookNameSystemInject}

// --- Context injection ---

// HookContextInject fires as context is injected. Return a string to
// contribute.
var HookContextInject = Hook[ContextInjectInfo, StringResult]{Name: HookNameContextInject}

// --- Capabilities ---

// HookCapabilityDiscover fires during capability discovery.
var HookCapabilityDiscover = Hook[json.RawMessage, StringResult]{Name: HookNameCapabilityDiscover}

// HookCapabilityMatch fires to match user input against registered
// capabilities.
var HookCapabilityMatch = Hook[CapabilityMatchInfo, StringResult]{Name: HookNameCapabilityMatch}

// HookCapabilityInvoke fires to invoke a matched capability.
var HookCapabilityInvoke = Hook[json.RawMessage, StringResult]{Name: HookNameCapabilityInvoke}

// --- Extension lifecycle ---

// HookExtensionRespawned fires at this extension after the engine
// auto-respawns it.
var HookExtensionRespawned = Hook[ExtensionRespawnedInfo, NoResult]{Name: HookNameExtensionRespawned}

// HookTurnAborted fires when a turn is aborted.
var HookTurnAborted = Hook[TurnAbortedInfo, NoResult]{Name: HookNameTurnAborted}

// HookPeerExtensionDied fires when another extension's subprocess dies.
var HookPeerExtensionDied = Hook[PeerExtensionInfo, NoResult]{Name: HookNamePeerExtensionDied}

// HookPeerExtensionRespawned fires when another extension is respawned.
var HookPeerExtensionRespawned = Hook[PeerExtensionInfo, NoResult]{Name: HookNamePeerExtensionRespawned}

// --- Async-trigger registration ---

// HookWebhookRegistered fires as a webhook route is registered. Return
// Block to refuse it.
var HookWebhookRegistered = Hook[AsyncRegistrationInfo, AsyncRegistrationVeto]{Name: HookNameWebhookRegistered}

// HookWebhookDeregistered fires as a webhook route is removed.
// Observation-only.
var HookWebhookDeregistered = Hook[AsyncRegistrationInfo, NoResult]{Name: HookNameWebhookDeregistered}

// HookScheduleRegistered fires as a schedule is registered. Return Block to
// refuse it.
var HookScheduleRegistered = Hook[AsyncRegistrationInfo, AsyncRegistrationVeto]{Name: HookNameScheduleRegistered}

// HookScheduleDeregistered fires as a schedule is removed. Observation-only.
var HookScheduleDeregistered = Hook[AsyncRegistrationInfo, NoResult]{Name: HookNameScheduleDeregistered}

// HookScheduleMissed fires when the scheduler finds a slot that elapsed while
// the engine was down.
var HookScheduleMissed = Hook[ScheduleMissedInfo, NoResult]{Name: HookNameScheduleMissed}

// --- Run recovery ---

// HookBeforeRunRecovery fires before the engine resumes a journaled run.
var HookBeforeRunRecovery = Hook[BeforeRunRecoveryInfo, BeforeRunRecoveryResult]{Name: HookNameBeforeRunRecovery}

// --- Cross-session messaging ---

// HookSessionMessage fires when another session of this extension sends a
// message via ctx.Sessions().Send.
var HookSessionMessage = Hook[SessionMessageInfo, NoResult]{Name: HookNameSessionMessage}

// allHookDescriptors lists every descriptor above, so the parity test can
// enumerate the SDK's declared coverage without reflection over package vars.
// A descriptor added above and not here fails TestDescriptorTableIsComplete.
func allHookDescriptors() []descriptorInfo {
	return []descriptorInfo{
		descriptorOf(HookSessionStart), descriptorOf(HookSessionEnd),
		descriptorOf(HookBeforePrompt), descriptorOf(HookTurnStart),
		descriptorOf(HookTurnEnd), descriptorOf(HookMessageStart),
		descriptorOf(HookMessageEnd), descriptorOf(HookToolStart),
		descriptorOf(HookToolEnd), descriptorOf(HookToolCall),
		descriptorOf(HookOnError), descriptorOf(HookAgentStart),
		descriptorOf(HookAgentEnd),

		descriptorOf(HookSessionBeforeCompact), descriptorOf(HookSessionCompact),
		descriptorOf(HookSessionBeforeFork), descriptorOf(HookSessionFork),
		descriptorOf(HookSessionBeforeSwitch), descriptorOf(HookCompactSummaryRequest),

		descriptorOf(HookBeforeAgentStart), descriptorOf(HookBeforeProviderRequest),

		descriptorOf(HookBeforeEarlyStopDecision), descriptorOf(HookEarlyStopContinued),

		descriptorOf(HookContext), descriptorOf(HookMessageUpdate),
		descriptorOf(HookToolResult), descriptorOf(HookInput),
		descriptorOf(HookModelSelect), descriptorOf(HookUserBash),
		descriptorOf(HookSlashCommandResolved),

		descriptorOf(HookBashToolCall), descriptorOf(HookReadToolCall),
		descriptorOf(HookWriteToolCall), descriptorOf(HookEditToolCall),
		descriptorOf(HookGrepToolCall), descriptorOf(HookGlobToolCall),
		descriptorOf(HookAgentToolCall),

		descriptorOf(HookBashToolResult), descriptorOf(HookReadToolResult),
		descriptorOf(HookWriteToolResult), descriptorOf(HookEditToolResult),
		descriptorOf(HookGrepToolResult), descriptorOf(HookGlobToolResult),
		descriptorOf(HookAgentToolResult),

		descriptorOf(HookContextDiscover), descriptorOf(HookContextLoad),
		descriptorOf(HookInstructionLoad),

		descriptorOf(HookPermissionRequest), descriptorOf(HookPermissionDenied),
		descriptorOf(HookPermissionClassify),

		descriptorOf(HookFileChanged), descriptorOf(HookWorkspaceFileChanged),

		descriptorOf(HookTaskCreated), descriptorOf(HookTaskCompleted),
		descriptorOf(HookBackgroundTaskCompleted),

		descriptorOf(HookDispatchLost),

		descriptorOf(HookElicitationRequest), descriptorOf(HookElicitationResult),

		descriptorOf(HookPlanModePrompt), descriptorOf(HookBeforePlanModeEnter),
		descriptorOf(HookBeforePlanModeExit), descriptorOf(HookBeforePlanModeAutoExit),
		descriptorOf(HookSystemInject),

		descriptorOf(HookContextInject),

		descriptorOf(HookCapabilityDiscover), descriptorOf(HookCapabilityMatch),
		descriptorOf(HookCapabilityInvoke),

		descriptorOf(HookExtensionRespawned), descriptorOf(HookTurnAborted),
		descriptorOf(HookPeerExtensionDied), descriptorOf(HookPeerExtensionRespawned),

		descriptorOf(HookWebhookRegistered), descriptorOf(HookWebhookDeregistered),
		descriptorOf(HookScheduleRegistered), descriptorOf(HookScheduleDeregistered),
		descriptorOf(HookScheduleMissed),

		descriptorOf(HookBeforeRunRecovery),
		descriptorOf(HookSessionMessage),
	}
}
