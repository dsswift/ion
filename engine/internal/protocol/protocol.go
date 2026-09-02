package protocol

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/types"
)

// ─── Client -> Server ───

// ClientCommand represents any command sent from a client to the engine server.
// The Cmd field discriminates which fields are relevant.
type ClientCommand struct {
	Cmd          string              `json:"cmd"`
	Key          string              `json:"key,omitempty"`
	Config       *types.EngineConfig `json:"config,omitempty"`
	RequestID    string              `json:"requestId,omitempty"`
	Text         string              `json:"text,omitempty"`
	Model        string              `json:"model,omitempty"`
	MaxTurns     int                 `json:"maxTurns,omitempty"`
	MaxBudgetUsd float64             `json:"maxBudgetUsd,omitempty"`
	AgentName    string              `json:"agentName,omitempty"`
	// abort_agent: retain the published name-and-subtree addressing surface.
	Subtree *bool `json:"subtree,omitempty"`

	// abort: how much of the session tree the abort tears down. Empty means
	// "all" — the historical behavior — so a client that predates this field
	// is unaffected. "orchestrator" cancels only the active run and leaves
	// background dispatches alive. See session.AbortScope for the semantics.
	AbortScope string `json:"abortScope,omitempty"`

	// abort_dispatch: the collision-safe dispatch ID (the agentID minted at
	// dispatch time and surfaced as `dispatchId` on engine_agent_state
	// dispatch members) identifying the single background dispatch to cancel.
	DispatchID string `json:"dispatchId,omitempty"`
	// stop_background_task: exact session-owned Bash task to stop.
	TaskID             string   `json:"taskId,omitempty"`
	Message            string   `json:"message,omitempty"`
	DialogID           string   `json:"dialogId,omitempty"`
	Value              any      `json:"value,omitempty"`
	Command            string   `json:"command,omitempty"`
	Args               string   `json:"args,omitempty"`
	Prefix             string   `json:"prefix,omitempty"`
	MessageIndex       *int     `json:"messageIndex,omitempty"`
	UserTurnIndex      *int     `json:"userTurnIndex,omitempty"`
	NewKey             string   `json:"newKey,omitempty"`
	Enabled            *bool    `json:"enabled,omitempty"`
	AllowedTools       []string `json:"allowedTools,omitempty"`
	EntryID            string   `json:"entryId,omitempty"`
	TargetID           string   `json:"targetId,omitempty"`
	ExtensionDir       string   `json:"extensionDir,omitempty"`
	Extensions         []string `json:"extensions,omitempty"`
	NoExtensions       bool     `json:"noExtensions,omitempty"`
	QuestionID         string   `json:"questionId,omitempty"`
	OptionID           string   `json:"optionId,omitempty"`
	SessionIDs         []string `json:"sessionIds,omitempty"`
	Label              string   `json:"label,omitempty"`
	Limit              int      `json:"limit,omitempty"`
	Offset             int      `json:"offset,omitempty"`
	AppendSystemPrompt string   `json:"appendSystemPrompt,omitempty"`
	Source             string   `json:"source,omitempty"`
	Provider           string   `json:"provider,omitempty"`
	Credential         string   `json:"credential,omitempty"`
	// set_model_tier: ordered fallback model identifiers. Empty explicitly
	// replaces a prior fallback chain with none.
	Fallbacks []string `json:"fallbacks,omitempty"`

	// elicitation_response: client reply to an engine_elicitation_request event.
	// ElicitDeclined is the ternary middle: "no, but continue" vs
	// ElicitCancelled "no, and abort".
	ElicitRequestID string                 `json:"elicitRequestId,omitempty"`
	ElicitResponse  map[string]interface{} `json:"elicitResponse,omitempty"`
	ElicitCancelled bool                   `json:"elicitCancelled,omitempty"`
	ElicitDeclined  bool                   `json:"elicitDeclined,omitempty"`

	// early_stop_decision_response: client reply to an
	// engine_early_stop_decision_request event. All fields are optional; an
	// empty reply expresses no opinion (engine falls through to its existing
	// merge logic — typically meaning no continuation when nothing supplied
	// a ContinueMessage). Mirrors the extension-side EarlyStopDecisionResult
	// shape; see types.go for the request-event field documentation.
	EarlyStopRequestID            string `json:"earlyStopRequestId,omitempty"`
	EarlyStopForceContinue        *bool  `json:"earlyStopForceContinue,omitempty"`
	EarlyStopOverrideBudget       int    `json:"earlyStopOverrideBudget,omitempty"`
	EarlyStopOverrideThresholdPct int    `json:"earlyStopOverrideThresholdPct,omitempty"`
	EarlyStopContinueMessage      string `json:"earlyStopContinueMessage,omitempty"`

	// tool_gate_response: client reply to an engine_tool_gate_request event
	// (the opt-in client tool gate — see types.ToolGateConfig). For a
	// "policy" request, GateDecision is "allow" or "deny" (anything else
	// resolves to allow, because an unrecognized decision must not invent a
	// refusal) and GateReason is the model-facing message a deny carries into
	// the tool result. For a "tool" request (a client-declared tool call),
	// GateContent carries the tool result text and GateIsError marks it as a
	// failure. A late reply (after the gate's declared timeout applied the
	// declared fallback) is logged and dropped.
	GateRequestID string `json:"gateRequestId,omitempty"`
	GateDecision  string `json:"gateDecision,omitempty"`
	GateReason    string `json:"gateReason,omitempty"`
	GateContent   string `json:"gateContent,omitempty"`
	GateIsError   bool   `json:"gateIsError,omitempty"`
	// GateImages carries optional image results for a client-declared tool.
	// It uses the same base64 attachment shape as send_prompt. The engine
	// converts it to ToolResult.Images before the result reaches the provider.
	GateImages []types.ImageAttachment `json:"gateImages,omitempty"`

	// oidc_begin_login: which grant flow to start. "pkce" (default when
	// empty) runs the interactive authorization-code + PKCE flow — the
	// engine returns an authorization URL for the consumer to open and its
	// loopback callback server completes the exchange. "device" runs the
	// device-code flow for headless hosts — the engine returns a user code
	// + verification URI and polls the token endpoint to completion.
	OidcFlow string `json:"oidcFlow,omitempty"`

	// oidc_token: downstream resource scope for the minted access token
	// (e.g. "api://<app-id>/Telemetry.Write"). Empty uses the operator
	// grant's base scope.
	OidcScope string `json:"oidcScope,omitempty"`

	// oidc_token: explicit audience/resource for the minted token, for
	// identity providers that bind grants to one (Auth0, RFC 8707) instead
	// of encoding the resource in the scope string. Empty uses the
	// provider's configured default audience.
	OidcAudience string `json:"oidcAudience,omitempty"`

	// oidc_token: bypass a fresh cached or base-grant access token and use
	// the provider refresh grant. Providers without the optional refresh
	// capability retain their normal token behavior.
	OidcForceRefresh bool `json:"oidcForceRefresh,omitempty"`

	// mcp_add / mcp_remove / mcp_login / mcp_logout: which configured MCP
	// server the command applies to. Matches the key under engine.json's
	// mcpServers map.
	McpName string `json:"mcpName,omitempty"`

	// mcp_add: transport for the new server. One of "http", "sse", "ws"
	// (aliases: "websocket"), or "stdio". Empty is resolved by the engine
	// from the other fields — a server with a URL defaults to "http", one
	// with a command to "stdio" — so a consumer that knows only the endpoint
	// need not restate the obvious.
	McpTransport string `json:"mcpTransport,omitempty"`

	// mcp_add: endpoint for a network transport (http/sse/ws).
	McpURL string `json:"mcpUrl,omitempty"`

	// mcp_add: executable and arguments for the stdio transport. The engine
	// spawns McpCommand with McpArgs and speaks MCP over its stdin/stdout.
	McpCommand string   `json:"mcpCommand,omitempty"`
	McpArgs    []string `json:"mcpArgs,omitempty"`

	// mcp_add: environment variables for a stdio server's subprocess, and
	// static HTTP headers for a network transport. Headers are the
	// pre-shared-token path; a server using OAuth needs none of them (see
	// mcp_login).
	McpEnv     map[string]string `json:"mcpEnv,omitempty"`
	McpHeaders map[string]string `json:"mcpHeaders,omitempty"`

	// mcp_login: OAuth scope to request, overriding whatever the server's
	// protected-resource metadata advertises. Empty uses the discovered
	// (or operator-configured) scope, which is the right default.
	McpScope string `json:"mcpScope,omitempty"`

	// list_directory: absolute path to enumerate on the engine's host.
	// Empty or "~" resolves to the engine user's home directory. ShowHidden
	// includes dotfiles in the result.
	Path string `json:"path,omitempty"`
	// Paths is the batch form of resolve_new_conversation_defaults. It is
	// additive: Path remains the single-directory form and older clients are
	// unaffected.
	Paths      []string `json:"paths,omitempty"`
	ShowHidden bool     `json:"showHidden,omitempty"`

	// send_prompt: pre-encoded attachments (images, PDF documents) to
	// attach to the user message as native image/document content blocks.
	// The engine has no opinion on any client-side marker syntax inside
	// Text — clients pass attachment bytes here and the backend forwards
	// them to the provider via its multimodal content format.
	// Supported media_type values: "image/*" (any image subtype) and
	// "application/pdf" (routed to native document blocks). Other values
	// are silently skipped. See types.ImageAttachment for the full contract.
	Attachments []types.ImageAttachment `json:"attachments,omitempty"`

	// send_prompt: when true, the engine maps this onto
	// RunOptions.ImplementationPhase for the dispatched run, which
	// suppresses the EnterPlanMode sentinel-tool injection. Clients set
	// this on the "implement" half of a plan-then-implement flow so the
	// model can't re-propose plan-mode entry against the user's already-
	// approved intent. Optional; defaults to false. See the field comment
	// in engine/internal/types/types.go for the full rationale.
	ImplementationPhase bool `json:"implementationPhase,omitempty"`

	// send_prompt: per-prompt extended-thinking effort for this run. One of
	// "low" | "medium" | "high"; "" or "off" means NO thinking directive for
	// this prompt (overriding any session default to off). This is the LIVE
	// per-conversation control — a client changes the level and it takes
	// effect on the very next prompt with no session restart, mirroring the
	// ImplementationPhase per-prompt override pattern above. The engine maps a
	// non-empty value onto RunOptions.Thinking{Enabled:true, Effort:<level>};
	// the provider body-builders then resolve the per-model mechanism via the
	// shared resolveThinking helper. Additive optional field on the scrutinized
	// engine wire — non-breaking.
	ThinkingEffort string `json:"thinkingEffort,omitempty"`

	// send_prompt: harness-supplied description prose for the
	// EnterPlanMode sentinel tool that the engine injects during
	// auto-mode runs. When non-empty, the engine forwards this string
	// verbatim as the tool's description to the model. When empty (or
	// omitted), the engine falls back to a one-line neutral default.
	// Per ADR-004, the prose belongs in the harness — the Ion desktop
	// client is the reference implementation and supplies its prose
	// from desktop/src/main/prompt-pipeline.ts; any harness supplies
	// its own. Mirrors RunOptions.EnterPlanModeDescription one-for-one.
	EnterPlanModeDescription string `json:"enterPlanModeDescription,omitempty"`

	// send_prompt: harness-supplied text for the per-turn sparse plan-mode
	// reminder the engine injects every planModeReminderInterval turns.
	// When non-empty, the engine uses this string verbatim instead of
	// buildPlanModeSparseReminder. When empty (or omitted), the engine
	// builds the reminder from the plan file path. Parallel override to
	// EnterPlanModeDescription / RunOptions.PlanModePrompt — same additive
	// omitempty contract. Mirrors RunOptions.PlanModeSparseReminder.
	PlanModeSparseReminder string `json:"planModeSparseReminder,omitempty"`

	// send_prompt: persisted plan file path from the desktop's tab state.
	// When non-empty, the engine restores the session's planFilePath from
	// this value instead of allocating a fresh slug — preserving plan file
	// continuity across desktop restarts. The engine validates that the
	// file exists on disk; if missing it falls back to fresh allocation.
	// Additive optional field; omitted by clients that have no persisted
	// plan file path.
	PlanFilePath string `json:"planFilePath,omitempty"`

	// set_plan_mode: list of bash command prefixes that the engine
	// allows in plan mode. Tri-valued:
	//   - omitted (JSON nil)    → no change to existing allowlist
	//   - []                    → clear; Bash blocked entirely
	//   - ["gh", "git log", ...] → replace allowlist with this set
	// Token-based prefix matching (whitespace-split, exact-token
	// comparison) prevents false positives ("gh" matches "gh pr view"
	// but not "ghost"). Existing clients (omitted or non-empty) keep
	// their prior behavior; the empty-array case is the explicit-clear
	// path. Additive optional field; omitted by clients that do not
	// need to extend the plan-mode bash allowlist.
	PlanModeAllowedBashCommands []string `json:"planModeAllowedBashCommands,omitempty"`

	// set_plan_mode: named MCP tools or `mcp__server` prefixes permitted in plan mode.
	PlanModeAllowedMcpTools []string `json:"planModeAllowedMcpTools,omitempty"`

	// send_prompt: per-prompt bash-allowlist additions. Distinct from
	// PlanModeAllowedBashCommands above (which is a SESSION-scoped
	// override carried on set_plan_mode). The additions here are
	// **transient**: the engine unions them with the session allowlist
	// when building the prompt's run-time tool list, then drops them at
	// run end. They never persist on engineSession.planModeAllowedBashCommands.
	//
	// Use case: slash commands whose YAML frontmatter declares an
	// `allowed_bash_commands` list (e.g. `/ion--review-changes` needing
	// `gh pr diff` for that turn only). The harness attaches the
	// frontmatter list here so the engine grants the additional
	// permissions for exactly one run; subsequent prompts in the same
	// session run against the unmodified session allowlist.
	//
	// Set semantics (union with session allowlist, de-duplicated,
	// order-preserved): the engine computes the effective allowlist for
	// the run as session ∪ additions. Duplicates are dropped; the
	// session-side entries win position-wise. Additive optional field;
	// omitted by clients that do not need per-prompt additions. The
	// session allowlist itself is never mutated by this field — that
	// invariant is the entire point of the field's existence.
	BashAllowlistAdditionsForThisPrompt []string `json:"bashAllowlistAdditionsForThisPrompt,omitempty"`
	McpAllowlistAdditionsForThisPrompt  []string `json:"mcpAllowlistAdditionsForThisPrompt,omitempty"`

	// send_prompt: signals that Text is a slash-command invocation
	// (`/name args`) the engine should resolve and expand, rather than a plain
	// user message. When true the engine resolves the command across the
	// conventional roots (extension registry, .ion/commands, .claude/commands,
	// skills, project), expands the template ($ARGUMENTS substitution +
	// frontmatter handling), feeds the EXPANDED body to the model, and persists
	// the RAW invocation as the displayed user turn (so the user sees the
	// command, the model sees the expansion).
	//
	// Default false: Text is treated as a plain message verbatim — byte-for-byte
	// the engine's prior behavior. Additive: a client that sends `/`-leading
	// content as an ordinary message (a path, a diff, a regex) is unaffected
	// because it does not set the flag. The engine never sniffs Text for a
	// leading slash on its own; the client classifies the invocation (the same
	// trivial check it already does to drive slash-command autocomplete).
	ResolveSlash bool `json:"resolveSlash,omitempty"`

	// send_prompt / command: per-invocation override for command-owned model
	// tiers. Nil inherits engine.json slashModelTier policy. True permits a tier
	// to switch a conversation that already has model-visible history; false
	// retains the current serving model. The extension decision hook has final say.
	SlashModelTierApplyMidConversation *bool `json:"slashModelTierApplyMidConversation,omitempty"`

	// TemporaryAutoFromPlan runs this command with auto-mode tools while preserving
	// the session's active planning workflow and plan file. On successful terminal
	// completion, the engine surfaces the existing plan approval proposal.
	TemporaryAutoFromPlan bool `json:"temporaryAutoFromPlan,omitempty"`

	// ClientWorkspaceContext is a per-prompt client-supplied workspace
	// descriptor that overrides both the session-level EngineConfig value
	// and the engine's own worktree-registry-derived context for this
	// prompt. Nil means "use session-level or engine-derived context."
	ClientWorkspaceContext *types.ClientWorkspaceContext `json:"clientWorkspaceContext,omitempty"`

	// Compaction overrides — per-prompt tuning of context compaction behavior.
	CompactTargetPercent  float64 `json:"compactTargetPercent,omitempty"`
	CompactMicroKeepTurns int     `json:"compactMicroKeepTurns,omitempty"`
	CompactEnabled        *bool   `json:"compactEnabled,omitempty"`
	CompactSummaryEnabled *bool   `json:"compactSummaryEnabled,omitempty"`
	CompactMemoryEnabled  *bool   `json:"compactMemoryEnabled,omitempty"`

	// send_prompt: client-supplied delivery identifier for idempotent prompt
	// submission. When non-empty the engine checks the conversation's persisted
	// entries for an existing message carrying this ID before starting a run.
	// If found, the prompt is silently de-duplicated (no run, no error) and the
	// server result carries {"accepted":false,"alreadyAccepted":true}. When
	// absent (the default) the engine's legacy fire-and-forget semantics apply.
	// Additive optional field -- non-breaking.
	DeliveryId string `json:"deliveryId,omitempty"`

	// send_prompt: optional user-facing text for a structured client surface.
	// Text remains the provider-visible prompt. When DisplayText is non-empty,
	// the engine persists it as the transcript content and keeps Text in
	// MessageData.LlmContent for context reconstruction. This is the generic
	// display-vs-model split already used by resolved slash commands, exposed to
	// clients that render forms or other structured input. Empty preserves the
	// historical byte-for-byte behavior.
	DisplayText string `json:"displayText,omitempty"`

	// send_prompt: how this turn was authored, as a types.InjectionKind wire
	// value ("structured_answer", "agent_completion", "revive", ...).
	//
	// The engine already classifies turns IT injects (dispatch callbacks,
	// background-task wakes, scheduler check-ins) and publishes the derived
	// machineAuthored flag so consumers can tell an engine-authored turn from
	// something a human typed. Until now a CLIENT had no way to state the same
	// fact about a turn IT delivers, so a client that owns its own answer
	// surface — a questions wizard, a form, any structured input UI — had to
	// send the engine-facing rendering of that submission as an ordinary user
	// turn, and every consumer then rendered it as if the operator had typed
	// it at the prompt.
	//
	// The engine still only classifies and publishes; suppression remains the
	// consumer's policy (ADR-017). An unrecognized value is treated as
	// user-authored rather than trusted, so a client cannot hide content by
	// inventing a kind. Empty (the default) means an ordinary user turn —
	// byte-for-byte the engine's prior behavior. Additive optional field --
	// non-breaking.
	InjectionKind string `json:"injectionKind,omitempty"`

	// resource_subscribe / resource_unsubscribe
	//
	// ResourceKind names the resource kind to subscribe to. The sentinel
	// value "*" subscribes to every kind on the target broker — every kind
	// with a producer now plus every kind registered or published later.
	// Wildcard delivery carries the real item kind in each snapshot/delta
	// (never "*"), so consumers bucket by the true kind. This is pure data
	// routing; the engine encodes no render policy. An exact kind string
	// subscribes to that one kind only (unchanged behavior).
	ResourceKind   string                `json:"resourceKind,omitempty"`
	ResourceFilter *types.ResourceFilter `json:"resourceFilter,omitempty"`
	ResourceSubID  string                `json:"resourceSubId,omitempty"`
	// resource_subscribe: when true, subscribe to the global (workspace-level)
	// broker instead of the per-session broker.
	ResourceGlobal bool `json:"resourceGlobal,omitempty"`
	// resource_publish: operation and item for client-side resource publishing.
	ResourceOp   string              `json:"resourceOp,omitempty"`
	ResourceItem *types.ResourceItem `json:"resourceItem,omitempty"`
	// ResourceProducer selects the trusted producer for a client operation.
	// Empty preserves producerless and legacy single-producer behavior.
	ResourceProducer string `json:"resourceProducer,omitempty"`
	// resource_get: fetch a single item's full content from the producer.
	// ResourceKind and ResourceID identify the item. ResourceGlobal selects
	// the global broker (workspace-scoped) vs. the per-session broker.
	// The engine emits engine_resource_item on the requesting connection when
	// the item is found; returns an error result when not found or when no
	// producer is registered for the kind.
	ResourceID string `json:"resourceId,omitempty"`

	// delete_stored_sessions: cleanup stale conversation files.
	MaxAgeDays int      `json:"maxAgeDays,omitempty"`
	ExcludeIDs []string `json:"excludeIds,omitempty"`
	DryRun     bool     `json:"dryRun,omitempty"`
	// delete_stored_conversations: exact, operator-requested deletion.
	// SessionIDs carries the complete file-set identities to remove.

	// steer_agent: optional client-generated correlation id for this one
	// steer message. When the steer reaches a live API-backed main-loop run
	// (agentName empty) and persists as a genuine client-originated user
	// turn, the engine echoes ClientMessageID back on engine_steer_injected
	// alongside the durable EntryID it assigned the persisted entry — so the
	// sender can re-key its optimistic UI row by identity instead of trusting
	// buffer position, without the engine ever needing to know the client's
	// row-rendering scheme. Omitted or empty: no correlation identity is
	// echoed (legacy behavior, unchanged). Additive optional field on the
	// scrutinized engine wire — non-breaking.
	ClientMessageID string `json:"clientMessageId,omitempty"`

	// rewind_session: exact durable engine entry id to rewind before. Takes
	// priority over UserTurnIndex when both are present. A client that has
	// learned a persisted user turn's EntryID (from a prior
	// engine_steer_injected confirmation, or from loaded conversation
	// history) should send it here instead of an ordinal it computed from
	// its own rendered rows — a queued-but-undelivered message occupying a
	// position in the client's local list has no corresponding tree entry,
	// so an ordinal computed against that list can point at the wrong turn.
	// Reuses the EntryID field already defined above for branch/branch_before.
	// Additive: a rewind_session command that omits EntryID and sends only
	// UserTurnIndex behaves exactly as before.
}

var validCommands = map[string]bool{
	"start_session":        true,
	"send_prompt":          true,
	"abort":                true,
	"abort_agent":          true,
	"abort_dispatch":       true,
	"stop_background_task": true,
	"steer_agent":          true,
	"dialog_response":      true,
	"command":              true,
	"stop_session":         true,
	// settle_session: pause a session's async subsystems (schedules,
	// webhooks) and cancel any active run WITHOUT destroying the session.
	// The session stays in the map; StartSession for the same key is
	// still idempotent. Extension subprocesses and MCP connections stay
	// alive. Resume with resume_session. Requires key.
	"settle_session": true,
	// resume_session: reverse a settle — re-wire async hosts, clear the
	// settled flag, and emit idle status. Requires key.
	"resume_session":               true,
	"stop_by_prefix":               true,
	"list_sessions":                true,
	"fork_session":                 true,
	"set_plan_mode":                true,
	"branch":                       true,
	"branch_before":                true,
	"rewind_session":               true,
	"navigate_tree":                true,
	"get_tree":                     true,
	"shutdown":                     true,
	"permission_response":          true,
	"list_stored_sessions":         true,
	"load_session_history":         true,
	"save_session_label":           true,
	"get_conversation":             true,
	"generate_title":               true,
	"elicitation_response":         true,
	"early_stop_decision_response": true,
	"tool_gate_response":           true,
	"health":                       true,
	"reconcile_state":              true,
	// query_session_status: on-demand counterpart to reconcile_state that
	// emits ONLY the engine_status snapshot (no agent state). Used by
	// freshly-reconnected clients to learn current status for a key
	// without waiting for the next heartbeat tick or paying the cost of
	// a full reconcile. Phase 2 of the state-management overhaul.
	"query_session_status": true,
	// resolve_permission_denials: drop the session's retained
	// AskUserQuestion / ExitPlanMode denials because the consumer has
	// resolved them by its own means (the user dismissed the card, answered
	// out of band, or the consumer decided the question no longer applies).
	//
	// The engine retains unresolved denials so that a re-attaching consumer
	// sees the still-pending question on every status snapshot, and clears
	// them when a new prompt supersedes them (prompt_dispatch.go) or on
	// /clear (clear_core.go). Neither covers a resolution that produces no
	// prompt: a consumer that dismisses the card had no way to say so, so the
	// engine kept re-publishing the denial and the consumer had to suppress
	// the echo locally and permanently — which turns any later loss of its
	// local state into an unrecoverable one.
	//
	// This is the missing third path. Mechanism only: the engine takes no
	// position on WHY the consumer resolved the question, and a consumer that
	// never sends it behaves exactly as before. Requires key.
	"resolve_permission_denials": true,
	// get_agent_state returns a full-fidelity roster in the requesting
	// command result. It is intentionally not an engine event because events
	// broadcast to every socket consumer.
	"get_agent_state":      true,
	"migrate_conversation": true,
	"list_models":          true,
	// resolve_model_tier: map a tier name from ~/.ion/models.json to its
	// configured model + fallback chain. Consumers gate tier-dependent
	// features on this (e.g. "requires a standard tier") instead of parsing
	// models.json themselves — the engine owns the file's semantics.
	"resolve_model_tier": true,
	"list_model_tiers":   true,
	"set_model_tier":     true,
	"remove_model_tier":  true,
	"store_credential":   true,
	"refresh_models":     true,
	// provider_login / provider_login_cancel / provider_logout: delegated-CLI
	// (codex/claude-code/grok/cursor) interactive auth lifecycle. The engine
	// drives the CLI login/logout and broadcasts engine_provider_login stage
	// events plus engine_providers_updated so clients refresh. Dispatched in
	// server/dispatch_provider_login.go.
	//
	// provider_login_code returns an authorization code to a login parked on the
	// await_auth_code stage. Required by flows the engine drives through a CLI's
	// manual-paste fallback rather than its own callback (claude-code): the
	// provider issues the code to the user in the browser and the CLI waits on
	// stdin for it, so the consumer must hand it back to the engine.
	"provider_login":        true,
	"provider_login_cancel": true,
	"provider_logout":       true,
	"provider_login_code":   true,
	// oidc_begin_login / oidc_logout / oidc_identity: operator OIDC
	// identity lifecycle. The engine owns the token (storage, refresh,
	// per-scope minting); these commands let a consumer start a login
	// (the engine returns what to surface — an authorization URL or a
	// device code — and completes the exchange itself), sign out, and
	// query the current identity snapshot. Identity state transitions
	// broadcast engine_oidc_identity to all clients.
	"oidc_begin_login": true,
	"oidc_logout":      true,
	"oidc_identity":    true,
	// oidc_token: mint a short-lived access token for the signed-in
	// operator, scoped to cmd.oidcScope (empty = base grant scope).
	// Delivered ONLY to the requester via the result payload -- never
	// broadcast. This is how a trusted local client (e.g. the desktop
	// shipping its own logs) authenticates without owning the grant:
	// the engine keeps the refresh token; clients pull ephemeral access
	// tokens on demand.
	"oidc_token": true,
	// mcp_list / mcp_add / mcp_remove / mcp_login / mcp_logout: MCP server
	// administration. The engine owns the mechanism — engine.json CRUD, OAuth
	// metadata discovery, dynamic client registration, the PKCE exchange, and
	// token storage — so every consumer drives the same surface instead of
	// reimplementing it. mcp_login returns an authorization URL immediately and
	// completes the exchange on a background goroutine; state transitions
	// broadcast engine_mcp_servers (a complete snapshot) to all clients.
	"mcp_list":       true,
	"mcp_add":        true,
	"mcp_remove":     true,
	"mcp_login":      true,
	"mcp_logout":     true,
	"get_host_info":  true,
	"list_directory": true,
	// clear_conversation_file: wipes the LLM-visible Messages on a stored
	// conversation file by sessionId, without requiring a live engine session. Used by
	// consumers that need to reset a conversation file when no in-memory
	// session is running against it (so dispatchClear cannot be used).
	// Non-breaking additive command. Requires key (sessionId).
	"clear_conversation_file": true,
	// delete_stored_sessions: removes stale conversation files from disk.
	// All fields optional with sane defaults (maxAgeDays=14, dryRun=false).
	"delete_stored_sessions": true,
	// delete_stored_conversations: exact inactive conversation deletion. Requires sessionIds.
	"delete_stored_conversations": true,
	// resource_subscribe / resource_unsubscribe: client-side resource
	// collection management. resource_subscribe attaches a live subscription
	// to a resource kind; the engine streams snapshot + delta events back
	// over the connection. resource_unsubscribe tears down an active
	// subscription by its ID.
	"resource_subscribe":   true,
	"resource_unsubscribe": true,
	"resource_publish":     true,
	"resource_get":         true,
	// get_plan_content: fetch a bounded byte-range window of a plan file.
	// Key (session key) scopes the plan directory for the security check.
	// Path is the absolute plan file path the engine emitted in a prior
	// plan_mode_changed / plan_proposal / plan_mode_auto_exit event.
	// Offset + Limit select the window (Limit 0 = server default 64 KB).
	// The engine replies with a plan_content event on the same connection.
	"get_plan_content": true,
	// discover_slash_commands: lists the filesystem slash-command templates and
	// skills available across the conventional roots for a working directory.
	// Path carries the working directory (optional; user-level roots are always
	// included). The optional Config carries claudeCompat; when false (or the
	// Config is absent), the engine skips the .claude / ~/.claude roots, matching
	// the slash-resolution and skill-loading gates. Replaces per-consumer
	// filesystem walks so every consumer's autocomplete menu is fed by one owner.
	// Stateless; no session required. The engine replies with the listing in the
	// result data.
	"discover_slash_commands": true,
	// get_enterprise_policy: read the enterprise NewConversationDefaults policy
	// so clients can decide whether the new-conversation flow is locked.
	// Stateless (no session key); the engine replies with
	// { newConversationDefaults } in the result data (null when no enterprise
	// config / no section is present).
	"get_enterprise_policy": true,
	// resolve_new_conversation_defaults resolves portable global, project, and
	// enterprise defaults for Path or Paths without starting a session.
	"resolve_new_conversation_defaults": true,
	// resolve_new_conversation_defaults accepts either one path or a batch.
	// Both fields are optional: no path resolves only global defaults.
	// get_context_breakdown: on-demand context breakdown outside of an active
	// run. Reconstructs the full assembly pipeline (system prompt + tools +
	// conversation messages) for the given session key and emits
	// engine_context_breakdown. For a fresh session the breakdown reflects
	// system prompt + tools with zero conversation tokens; for a historical
	// session it reflects all on-disk messages. Requires only key.
	"get_context_breakdown": true,
	// plugin_install: download and install a Claude Code-compatible plugin from
	// a GitHub source ("owner/repo"). The source field carries the repo path.
	// Returns the installed plugin record in the result data.
	"plugin_install": true,
	// plugin_list: list all installed plugins. Returns a slice of plugin records.
	"plugin_list": true,
	// plugin_remove: uninstall a plugin by name. The label field carries the
	// plugin name to remove.
	"plugin_remove": true,
}

// ParseClientCommand parses a single NDJSON line into a ClientCommand.
// Returns nil if the line is invalid JSON, has an unknown cmd, or is
// missing required fields for the given command type.
func ParseClientCommand(line string) *ClientCommand {
	// First pass: raw map to check field presence and types.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return nil
	}

	cmdRaw, ok := raw["cmd"]
	if !ok {
		return nil
	}
	var cmd string
	if err := json.Unmarshal(cmdRaw, &cmd); err != nil || cmd == "" {
		return nil
	}
	if !validCommands[cmd] {
		return nil
	}

	if !validateRaw(cmd, raw) {
		return nil
	}

	// Second pass: unmarshal into the struct.
	var result ClientCommand
	if err := json.Unmarshal([]byte(line), &result); err != nil {
		return nil
	}
	return &result
}

// ExtractRequestID pulls the requestId from raw JSON without full parsing.
// Used when ParseClientCommand returns nil so error responses can still be matched.
func ExtractRequestID(line string) string {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return ""
	}
	v, ok := raw["requestId"]
	if !ok {
		return ""
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return ""
	}
	return s
}
