// Package types — RunOptions and its supporting payload structs. Lives
// in its own file because the run-configuration surface naturally grows
// (every new engine feature that needs per-run wiring adds a field
// here); keeping it separate from the EngineEvent struct and the
// session/agent types reduces churn on shared files.
package types

// --- Run Options ---

// RunOptions configures a Claude run.
type RunOptions struct {
	Prompt             string          `json:"prompt"`
	ProjectPath        string          `json:"projectPath"`
	SessionID          string          `json:"sessionId,omitempty"`
	AllowedTools       []string        `json:"allowedTools,omitempty"`
	SuppressTools      []string        `json:"suppressTools,omitempty"`
	MaxTurns           int             `json:"maxTurns,omitempty"`
	MaxBudgetUsd       float64         `json:"maxBudgetUsd,omitempty"`
	SystemPrompt       string          `json:"systemPrompt,omitempty"`
	Model              string          `json:"model,omitempty"`
	HookSettingsPath   string          `json:"hookSettingsPath,omitempty"`
	AddDirs            []string        `json:"addDirs,omitempty"`
	PermissionModeCli  string          `json:"permissionModeCli,omitempty"`
	AppendSystemPrompt string          `json:"appendSystemPrompt,omitempty"`
	Source             string          `json:"source,omitempty"`
	McpConfig          string          `json:"mcpConfig,omitempty"`
	MaxTokens          int             `json:"maxTokens,omitempty"`
	Thinking           *ThinkingConfig `json:"thinking,omitempty"`
	MaxRetries         int             `json:"maxRetries,omitempty"`
	FallbackChain      []string        `json:"fallbackChain,omitempty"`
	Persistent         bool            `json:"persistent,omitempty"`
	PlanMode           bool            `json:"planMode,omitempty"`
	PlanModeTools      []string        `json:"planModeTools,omitempty"`
	PlanFilePath       string          `json:"planFilePath,omitempty"`
	PlanModePrompt     string          `json:"planModePrompt,omitempty"`
	// PlanModeSparseReminder is the harness-supplied text for the sparse
	// plan-mode reminder injected periodically during plan-mode runs.
	// Empty (the default) means the engine builds the reminder via
	// buildPlanModeSparseReminder. When non-empty, the engine forwards this
	// string verbatim instead. Parallel override path to PlanModePrompt:
	// both are additive omitempty fields; third-party harnesses that don't
	// set either inherit the engine defaults unchanged.
	// See docs/protocol/client-commands.md for the three-layer precedence
	// (RunOptions field → plan_mode_prompt hook → engine default).
	PlanModeSparseReminder      string   `json:"planModeSparseReminder,omitempty"`
	PlanModeReentry             bool     `json:"planModeReentry,omitempty"`
	PlanModeAllowedBashCommands []string `json:"planModeAllowedBashCommands,omitempty"`
	// BashAllowlistAdditionsForThisPrompt are per-prompt additions
	// unioned with PlanModeAllowedBashCommands when the engine builds
	// the run-time tool list. The additions live only for this run;
	// the engine does NOT mutate the session-level allowlist with
	// them. Intended carrier: slash-command frontmatter (e.g.
	// `/ion--review-changes` declares `gh pr diff` in its
	// `allowed_bash_commands` list and wants the permission for one
	// turn). The engine de-duplicates the union and preserves the
	// session-side entries' positions. Mirrors
	// ClientCommand.BashAllowlistAdditionsForThisPrompt one-for-one.
	BashAllowlistAdditionsForThisPrompt []string `json:"bashAllowlistAdditionsForThisPrompt,omitempty"`
	// ImplementationPhase tells the engine that this run is the "implement"
	// half of a plan-then-implement flow — the user has already approved a
	// plan and the model should execute it directly without proposing
	// another plan-mode entry. When set, the engine skips injecting the
	// EnterPlanMode sentinel tool entirely, so the model never sees the
	// option and cannot re-propose plan mode mid-run.
	//
	// Replaces the prior mechanism, which was a harness prepending a
	// "You are implementing a user-approved plan. Do not re-enter plan
	// mode..." preamble to the user prompt and the EnterPlanMode tool's
	// docstring instructing the model to recognize those phrases. That
	// substring-matching approach was brittle (translation-sensitive,
	// easy to bypass with paraphrasing) and bled UI/harness policy into
	// engine-visible prompt text. The boolean is the mechanical
	// equivalent: harness sets the flag, engine acts on it.
	//
	// Third-party harnesses doing implement-then-execute flows should
	// set this to true on the implementation run. The engine has no
	// opinion on what counts as "implementation"; that's the harness's
	// call.
	ImplementationPhase bool `json:"implementationPhase,omitempty"`
	// EnterPlanModeDescription is the harness-supplied prompt text for the
	// EnterPlanMode sentinel tool injected during auto-mode runs. When this
	// field is empty (the default), the engine falls back to a one-line
	// neutral fallback: "Switch the current session into plan mode."
	// When the harness supplies a non-empty string, the engine forwards it
	// verbatim as the tool's description so the model sees the harness's
	// framing — e.g. the conditions under which plan mode is appropriate,
	// the rules that apply once enabled, and any policy text the harness
	// wants the model to follow.
	//
	// Per ADR-004 (Move EnterPlanMode prose to harness): the engine ships
	// only the sentinel mechanism (tool injection + runloop interception);
	// the policy prose that tells the model *when* to enter plan mode and
	// *what* the rules are belongs in the harness. The Ion desktop client
	// is the reference harness implementation and ships its prose as the
	// ENTER_PLAN_MODE_DESCRIPTION constant in
	// desktop/src/main/prompt-pipeline.ts; it has no special status — any
	// harness supplies its own. See ADR-001 (parent boundary) and ADR-002
	// (the same pattern applied to early-stop continuation).
	//
	// Forward-compat: when the harness wants the engine default (a TUI
	// might prefer minimal framing, for instance), it leaves this empty.
	// The engine never imposes its own opinionated default beyond the
	// one-line fallback.
	EnterPlanModeDescription     string  `json:"enterPlanModeDescription,omitempty"`
	CompactThreshold             float64 `json:"compactThreshold,omitempty"`
	CompactTargetPercent         float64 `json:"compactTargetPercent,omitempty"`
	CompactMicroKeepTurns        int     `json:"compactMicroKeepTurns,omitempty"`
	CompactMinKeepTurns          int     `json:"compactMinKeepTurns,omitempty"`
	CompactEstimationPadding     float64 `json:"compactEstimationPadding,omitempty"`
	CompactEnabled               *bool   `json:"compactEnabled,omitempty"`
	CompactSummaryEnabled        *bool   `json:"compactSummaryEnabled,omitempty"`
	CompactSummaryModel          string  `json:"compactSummaryModel,omitempty"`
	CompactSummaryMaxTokens      int     `json:"compactSummaryMaxTokens,omitempty"`
	CompactMemoryEnabled         *bool   `json:"compactMemoryEnabled,omitempty"`
	CompactMemoryModel           string  `json:"compactMemoryModel,omitempty"`
	CompactMemoryUpdateThreshold int     `json:"compactMemoryUpdateThreshold,omitempty"`
	CompactMemoryUpdateMinTurns  int     `json:"compactMemoryUpdateMinTurns,omitempty"`
	CompactMemoryMaxTokens       int     `json:"compactMemoryMaxTokens,omitempty"`
	// MaxToolResultChars caps the character count of any single tool result
	// for this run. Results exceeding this limit are persisted to disk and
	// replaced with a preview. Zero means "inherit from engine.json or
	// built-in default". Negative disables the cap entirely for this run.
	MaxToolResultChars      int          `json:"maxToolResultChars,omitempty"`
	SuppressSystemMessages  bool         `json:"suppressSystemMessages,omitempty"`
	DisablePlanModeReminder bool         `json:"disablePlanModeReminder,omitempty"`
	DisableTurnLimitWarning bool         `json:"disableTurnLimitWarning,omitempty"`
	DisableMaxTokenContinue bool         `json:"disableMaxTokenContinue,omitempty"`
	CapabilityTools         []LlmToolDef `json:"-"` // capability tools injected by session manager
	CapabilityPrompt        string       `json:"-"` // capability prompt content injected by session manager
	WebSearchMode           string       `json:"-"` // "auto", "client", or "server", propagated from config

	// --- Early-stop continuation (Claude-Code-style "keep working" nudge) ---
	//
	// The engine watches output-token usage across the run. When the model
	// emits end_turn / stop below `EarlyStopThresholdPct` of the configured
	// budget, the engine injects a continuation user message and re-runs the
	// turn. Defaults ship on with a sensible budget; harness engineers can
	// disable, retune, or override per-run via these fields.
	//
	// Resolution order (highest priority last): built-in defaults <
	// engine.json `earlyStopContinue` block < RunOptions fields below <
	// `before_early_stop_decision` hook return value at runtime.
	//
	// Field stability: additive only (per CLAUDE.md contract rules). Zero
	// values mean "inherit from a lower layer"; pointer fields exist so that
	// "explicitly false / explicitly zero" can be distinguished from "unset".

	// EarlyStopEnabled is the per-run override. Pointer (not bool) so nil
	// means "use engine.json default", `&false` disables for this run, and
	// `&true` forces on (e.g. for a subagent that the harness specifically
	// wants nudged).
	EarlyStopEnabled *bool `json:"earlyStopEnabled,omitempty"`

	// EarlyStopBudget is the output-token target for the run. Zero means
	// "use the engine.json default"; a negative value disables the feature
	// for this run.
	EarlyStopBudget int `json:"earlyStopBudget,omitempty"`

	// EarlyStopThresholdPct is the completion threshold (percent of budget).
	// Zero means "use the default" (90).
	EarlyStopThresholdPct int `json:"earlyStopThresholdPct,omitempty"`

	// EarlyStopMaxContinuations caps the number of continuation nudges per
	// run. Zero means "use the default" (3).
	EarlyStopMaxContinuations int `json:"earlyStopMaxContinuations,omitempty"`

	// EarlyStopDiminishingDelta is the per-continuation output-token delta
	// below which the engine considers the agent to be making diminishing
	// progress and stops nudging. Zero means "use the default" (500 tokens).
	EarlyStopDiminishingDelta int `json:"earlyStopDiminishingDelta,omitempty"`

	// DisableEarlyStopContinue mirrors the existing per-injection disable
	// flags (DisablePlanModeReminder etc.). When true, the continuation
	// _message_ is suppressed even if the engine would otherwise decide to
	// continue. Rarely useful on its own — prefer EarlyStopEnabled = &false
	// to disable the whole loop. Kept for parity with the existing pattern.
	DisableEarlyStopContinue bool `json:"disableEarlyStopContinue,omitempty"`

	// IsSubagent marks a child agent run dispatched by the Agent tool. The
	// early-stop continuation is **off by default for subagents** even when
	// the global feature is on — a sub-agent is summoned for a tight remit
	// and should not be poked to keep working. Harness can still force it on
	// with `EarlyStopEnabled = &true`.
	IsSubagent bool `json:"isSubagent,omitempty"`

	// Attachments are pre-encoded images supplied by the client alongside the
	// text prompt. When non-empty the backend appends one image content block
	// per attachment to the user message, in addition to the text block.
	Attachments []ImageAttachment `json:"attachments,omitempty"`
}
