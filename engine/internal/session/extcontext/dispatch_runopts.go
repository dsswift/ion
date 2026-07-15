package extcontext

import (
	"context"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// buildDispatchRunOptions assembles the types.RunOptions for a dispatched
// child run from the dispatch opts, the resolved model, the project path, and
// the cancellation parent context. Extracted from BuildDispatchAgentFunc
// (dispatch_agent.go) to keep that file under the 800-line cap; the logic is
// otherwise identical to the inline assembly it replaced.
//
// dispatchParentCtx is the cancellation parent the child run derives from:
// opts.ParentCtx when the caller supplied one (e.g. the orchestrator's
// per-tool-call context), else the session cancellation root. Threading it
// here makes in-process backends (ApiBackend) cascade an abort; process-backed
// backends (CliBackend) are additionally reaped by PID kill in the manager's
// abortAllDescendants.
func buildDispatchRunOptions(opts *extension.DispatchAgentOpts, model, projectPath string, dispatchParentCtx context.Context, claudeCompat bool, sa SessionAccessor) types.RunOptions {
	runOpts := types.RunOptions{
		Prompt:      opts.Task,
		Model:       model,
		ProjectPath: projectPath,
		ParentCtx:   dispatchParentCtx,
		// Mirror the parent session's Claude-compatibility setting onto the
		// child run so the backend's read-triggered nested context loader
		// applies the same Ion-vs-Claude gate during the child's own run. Root
		// sessions set this in prompt_options.go:buildRunOptions; the dispatch
		// path is the child analogue. Without this, a compat-enabled parent
		// dispatched children whose nested descent ran with compat off,
		// silently dropping CLAUDE.md discovery for the child.
		ClaudeCompat: claudeCompat,
		// Mark every dispatched child as a subagent so the early-stop
		// continuation gate skips it by default. Dispatched agents have tight
		// remits and should not be poked to keep working after they stop. This
		// unifies the dispatch path with the orchestrator's Agent-tool path,
		// which has always set IsSubagent for the same reason; the two paths
		// now share this single dispatch implementation.
		IsSubagent: true,
	}
	// Propagate plugin SessionStart messages so dispatched child agents receive
	// the same plugin instructions as the root conversation. These are the
	// pre-built <system-reminder> user messages from installed plugins' hooks.
	if msgs := sa.PluginSessionMessages(); len(msgs) > 0 {
		runOpts.InitialMessages = append(runOpts.InitialMessages, msgs...)
	}
	if opts.SystemPrompt != "" {
		runOpts.AppendSystemPrompt = opts.SystemPrompt
	}
	if len(opts.AllowedTools) > 0 {
		// Scope the child to the caller-supplied tool allowlist (e.g. a
		// matched agent spec's declared tools). Empty means no restriction --
		// the child inherits the engine's default set.
		runOpts.AllowedTools = opts.AllowedTools
	}
	if len(opts.SuppressTools) > 0 {
		// Targeted blacklist layered on top of the child's tool set (e.g.
		// suppressing the built-in Agent tool so child delegation routes
		// through the harness dispatch tool). Mirrors the root-session
		// suppressedTools threading in prompt_dispatch.go.
		runOpts.SuppressTools = opts.SuppressTools
	}
	if opts.ImplementationPhase {
		// Plan already approved: skip the EnterPlanMode sentinel injection so
		// the child executes directly and can never stall by re-proposing
		// plan mode. Mirrors RunOptions.ImplementationPhase on root prompts.
		runOpts.ImplementationPhase = true
	}
	if len(opts.FallbackChain) > 0 {
		// Walk these alternative models on overload (typically the tail of a
		// resolved tier chain). Empty leaves the child relying solely on the
		// DefaultModel threading for the unresolvable-model case.
		runOpts.FallbackChain = opts.FallbackChain
	}
	if opts.SessionID != "" {
		runOpts.ConversationID = opts.SessionID
	}
	if opts.MaxTurns > 0 {
		runOpts.MaxTurns = opts.MaxTurns
	}
	if opts.PlanMode {
		runOpts.PlanMode = true
		if opts.PlanFilePath != "" {
			runOpts.PlanFilePath = opts.PlanFilePath
		}
		if len(opts.PlanModeTools) > 0 {
			runOpts.PlanModeTools = opts.PlanModeTools
		}
	}
	return runOpts
}
