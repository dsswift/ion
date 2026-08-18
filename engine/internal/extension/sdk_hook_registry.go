// sdk_hook_registry.go — the declared hook registry.
//
// The engine's hook surface is a set of string constants in sdk.go plus a set
// of Fire* methods that decide what each hook's payload and return value look
// like. Neither is machine-enumerable: Go constants are not reflectable, and
// the payload/result shape lives in a method signature rather than in data.
//
// hookSpecs() is that surface as data. It exists so a client SDK in another
// language can be checked against the engine mechanically instead of by
// convention — the SDK contract manifest (sdk_contract_test.go) is generated
// from it, and the Go SDK's parity test reads that manifest. A hook added to
// the engine but missing from a client SDK is a test failure, not a surprise
// at runtime.
//
// Two guards keep this file honest, both in sdk_hook_registry_test.go:
//
//   - TestHookRegistryCoversAllConstants parses the Hook* const block in
//     sdk.go and asserts set-equality with these keys, so a new hook constant
//     cannot land without an entry here.
//   - TestHookRegistryMatchesForwarders records the result category that
//     registerHookForwarders actually installs for each hook and asserts it
//     equals the category declared here, so an entry cannot claim a shape the
//     forwarder does not produce.
package extension

// hookResultKind classifies what a hook handler may return, which is the part
// of a hook's contract a client SDK has to implement correctly. The categories
// mirror the forwarder families in hook_forwarders.go.
type hookResultKind string

const (
	// hookResultNone: the handler's return value is discarded. Observation
	// only — the engine has already acted by the time the hook fires.
	hookResultNone hookResultKind = "none"
	// hookResultString: a non-empty string replaces an engine-computed
	// string (prompt, model, system-prompt fragment, classification).
	hookResultString hookResultKind = "string"
	// hookResultBool: a boolean cancels or permits the pending operation.
	hookResultBool hookResultKind = "bool"
	// hookResultBlock: {block, reason} — veto with an explanation.
	hookResultBlock hookResultKind = "block"
	// hookResultPerToolCall: {block, reason, mutate} — veto plus argument
	// rewriting for the per-tool call hooks.
	hookResultPerToolCall hookResultKind = "perToolCall"
	// hookResultRejection: {content, reject} — supply or refuse content.
	hookResultRejection hookResultKind = "rejection"
	// hookResultContent: the raw result value is passed through to the
	// engine caller without a fixed schema.
	hookResultContent hookResultKind = "content"
	// hookResultStructured: a hook-specific result struct. The payload type
	// in the spec names which one.
	hookResultStructured hookResultKind = "structured"
	// hookResultAsyncVeto: {block, reason} decoded as *AsyncRegistrationVeto
	// by the async-registration Fire wrappers.
	hookResultAsyncVeto hookResultKind = "asyncVeto"
)

// hookSpec is one hook's machine-readable contract: the payload the engine
// sends and the category of result it will read back.
type hookSpec struct {
	// Payload is a zero-valued exemplar of what arrives at the handler.
	// Reflection over it yields the JSON field names a client SDK must
	// accept. A nil Payload means the hook fires with no payload; a string
	// exemplar means the engine sends a bare string (which the transport
	// wraps as {"_payload": "..."} — see payloadWrapperKey).
	Payload any
	// Result is the category of return value the forwarder will decode.
	Result hookResultKind
	// ResultType is a zero-valued exemplar of the structured result, set
	// only when Result is hookResultStructured. Reflection over it yields
	// the field names a client SDK must produce.
	ResultType any
}

// hookSpecs returns the full engine hook surface as data. Every Hook*
// constant in sdk.go has exactly one entry.
func hookSpecs() map[string]hookSpec {
	return map[string]hookSpec{
		// --- Lifecycle ---
		HookSessionStart: {Payload: nil, Result: hookResultNone},
		HookSessionEnd:   {Payload: nil, Result: hookResultNone},
		HookBeforePrompt: {Payload: "", Result: hookResultStructured, ResultType: BeforePromptResult{}},
		HookTurnStart:    {Payload: TurnInfo{}, Result: hookResultNone},
		HookTurnEnd:      {Payload: TurnInfo{}, Result: hookResultNone},
		HookMessageStart: {Payload: nil, Result: hookResultNone},
		HookMessageEnd:   {Payload: nil, Result: hookResultNone},
		HookToolStart:    {Payload: ToolStartInfo{}, Result: hookResultNone},
		HookToolEnd:      {Payload: nil, Result: hookResultNone},
		HookToolCall:     {Payload: ToolCallInfo{}, Result: hookResultBlock},
		HookOnError:      {Payload: ErrorInfo{}, Result: hookResultNone},
		HookAgentStart:   {Payload: AgentInfo{}, Result: hookResultNone},
		HookAgentEnd:     {Payload: AgentInfo{}, Result: hookResultNone},

		// --- Session management ---
		HookSessionBeforeCompact:  {Payload: CompactionInfo{}, Result: hookResultBool},
		HookSessionCompact:        {Payload: CompactionInfo{}, Result: hookResultNone},
		HookSessionBeforeFork:     {Payload: ForkInfo{}, Result: hookResultBool},
		HookSessionFork:           {Payload: ForkInfo{}, Result: hookResultNone},
		HookSessionBeforeSwitch:   {Payload: nil, Result: hookResultNone},
		HookCompactSummaryRequest: {Payload: CompactSummaryRequestInfo{}, Result: hookResultStructured, ResultType: CompactSummaryRequestResult{}},

		// --- Pre-action ---
		HookBeforeAgentStart:      {Payload: AgentInfo{}, Result: hookResultStructured, ResultType: BeforeAgentStartResult{}},
		HookBeforeProviderRequest: {Payload: nil, Result: hookResultNone},

		// --- Early stop ---
		HookBeforeEarlyStopDecision: {Payload: EarlyStopDecisionInfo{}, Result: hookResultStructured, ResultType: EarlyStopDecisionResult{}},
		HookEarlyStopContinued:      {Payload: EarlyStopContinuedInfo{}, Result: hookResultNone},

		// --- Content ---
		HookContext:              {Payload: nil, Result: hookResultString},
		HookMessageUpdate:        {Payload: MessageUpdateInfo{}, Result: hookResultContent},
		HookToolResult:           {Payload: nil, Result: hookResultContent},
		HookInput:                {Payload: "", Result: hookResultString},
		HookModelSelect:          {Payload: ModelSelectInfo{}, Result: hookResultString},
		HookUserBash:             {Payload: "", Result: hookResultNone},
		HookSlashCommandResolved: {Payload: SlashResolvedInfo{}, Result: hookResultString},

		// --- Per-tool call ---
		HookBashToolCall:  {Payload: nil, Result: hookResultPerToolCall},
		HookReadToolCall:  {Payload: nil, Result: hookResultPerToolCall},
		HookWriteToolCall: {Payload: nil, Result: hookResultPerToolCall},
		HookEditToolCall:  {Payload: nil, Result: hookResultPerToolCall},
		HookGrepToolCall:  {Payload: nil, Result: hookResultPerToolCall},
		HookGlobToolCall:  {Payload: nil, Result: hookResultPerToolCall},
		HookAgentToolCall: {Payload: nil, Result: hookResultPerToolCall},

		// --- Per-tool result ---
		HookBashToolResult:  {Payload: nil, Result: hookResultNone},
		HookReadToolResult:  {Payload: nil, Result: hookResultNone},
		HookWriteToolResult: {Payload: nil, Result: hookResultNone},
		HookEditToolResult:  {Payload: nil, Result: hookResultNone},
		HookGrepToolResult:  {Payload: nil, Result: hookResultNone},
		HookGlobToolResult:  {Payload: nil, Result: hookResultNone},
		HookAgentToolResult: {Payload: nil, Result: hookResultNone},

		// --- Context discovery ---
		HookContextDiscover: {Payload: ContextDiscoverInfo{}, Result: hookResultBool},
		HookContextLoad:     {Payload: ContextLoadInfo{}, Result: hookResultRejection},
		HookInstructionLoad: {Payload: ContextLoadInfo{}, Result: hookResultRejection},

		// --- Permissions ---
		HookPermissionRequest:  {Payload: PermissionRequestInfo{}, Result: hookResultNone},
		HookPermissionDenied:   {Payload: PermissionDeniedInfo{}, Result: hookResultNone},
		HookPermissionClassify: {Payload: PermissionClassifyInfo{}, Result: hookResultString},

		// --- File changes ---
		HookFileChanged:          {Payload: FileChangedInfo{}, Result: hookResultNone},
		HookWorkspaceFileChanged: {Payload: WorkspaceFileChangedInfo{}, Result: hookResultNone},

		// --- Tasks ---
		HookTaskCreated:             {Payload: TaskLifecycleInfo{}, Result: hookResultNone},
		HookTaskCompleted:           {Payload: TaskLifecycleInfo{}, Result: hookResultNone},
		HookBackgroundTaskCompleted: {Payload: BackgroundTaskCompletedInfo{}, Result: hookResultNone},

		// --- Dispatch loss ---
		HookDispatchLost: {Payload: DispatchLostInfo{}, Result: hookResultNone},

		// --- Elicitation ---
		HookElicitationRequest: {Payload: ElicitationRequestInfo{}, Result: hookResultContent},
		HookElicitationResult:  {Payload: ElicitationResultInfo{}, Result: hookResultNone},

		// --- Plan mode ---
		HookPlanModePrompt:         {Payload: "", Result: hookResultString},
		HookBeforePlanModeEnter:    {Payload: PlanModeEnterInfo{}, Result: hookResultStructured, ResultType: BeforePlanModeEnterResult{}},
		HookBeforePlanModeExit:     {Payload: BeforePlanModeExitInfo{}, Result: hookResultStructured, ResultType: BeforePlanModeExitResult{}},
		HookBeforePlanModeAutoExit: {Payload: BeforePlanModeAutoExitInfo{}, Result: hookResultStructured, ResultType: BeforePlanModeAutoExitResult{}},
		HookSystemInject:           {Payload: SystemInjectInfo{}, Result: hookResultString},

		// --- Context injection ---
		HookContextInject: {Payload: ContextInjectInfo{}, Result: hookResultString},

		// --- Capabilities ---
		HookCapabilityDiscover: {Payload: nil, Result: hookResultString},
		HookCapabilityMatch:    {Payload: CapabilityMatchInfo{}, Result: hookResultString},
		HookCapabilityInvoke:   {Payload: nil, Result: hookResultString},

		// --- Extension lifecycle ---
		HookExtensionRespawned:     {Payload: ExtensionRespawnedInfo{}, Result: hookResultNone},
		HookTurnAborted:            {Payload: TurnAbortedInfo{}, Result: hookResultNone},
		HookPeerExtensionDied:      {Payload: PeerExtensionInfo{}, Result: hookResultNone},
		HookPeerExtensionRespawned: {Payload: PeerExtensionInfo{}, Result: hookResultNone},

		// --- Async-trigger registration ---
		HookWebhookRegistered:    {Payload: AsyncRegistrationInfo{}, Result: hookResultAsyncVeto},
		HookWebhookDeregistered:  {Payload: AsyncRegistrationInfo{}, Result: hookResultNone},
		HookScheduleRegistered:   {Payload: AsyncRegistrationInfo{}, Result: hookResultAsyncVeto},
		HookScheduleDeregistered: {Payload: AsyncRegistrationInfo{}, Result: hookResultNone},
		HookScheduleMissed:       {Payload: ScheduleMissedInfo{}, Result: hookResultNone},

		// --- Cross-session messaging ---
		HookSessionMessage: {Payload: SessionMessageInfo{}, Result: hookResultNone},

		// --- Run recovery ---
		HookBeforeRunRecovery: {Payload: BeforeRunRecoveryInfo{}, Result: hookResultStructured, ResultType: BeforeRunRecoveryResult{}},
	}
}
