package backend

import (
	"fmt"
	"os"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// plan_mode_notice.go — delivering plan-mode instructions as notices in the
// conversation.
//
// The instructions used to be appended to the system prompt. A provider caches
// a prompt as a prefix (tools, then system prompt, then messages), so text that
// appears in the system prompt only while planning discards the whole cache
// each time the mode changes. A notice appended where the mode changed leaves
// the prefix alone.
//
// Every notice is saved exactly as it was sent. An enter notice stays true in
// history because a later exit notice ends it: the two read as a timeline, and
// the wording of each states a fact as of its own position.

// planNoticeMemo records a plan-mode notice the run delivered (or was told to
// withhold) without writing it to the entry tree, so the reconciler does not
// conclude from the tree that nothing was said.
type planNoticeMemo struct {
	active       bool
	planFilePath string
	turn         int
}

// resolvePlanModeHarness asks the harness, once per run, for its plan-mode
// prompt, tool list, and sparse reminder. RunOptions.PlanModePrompt wins over
// the plan_mode_prompt hook; when it is set the hook is not consulted.
func (b *ApiBackend) resolvePlanModeHarness(run *activeRun, hooks RunHooks, opts *types.RunOptions) {
	run.mu.Lock()
	if run.planHarnessResolved {
		run.mu.Unlock()
		return
	}
	run.planHarnessResolved = true
	planFilePath := run.planFilePath
	run.mu.Unlock()

	prompt := opts.PlanModePrompt
	source := "run_options"
	var tools []string
	sparse := ""
	if prompt == "" {
		source = "default"
		if hooks.OnPlanModePrompt != nil {
			customPrompt, customTools, customSparse := hooks.OnPlanModePrompt(planFilePath)
			if customPrompt != "" {
				prompt = customPrompt
				source = "hook"
			}
			tools = customTools
			sparse = customSparse
		}
	}

	run.mu.Lock()
	run.planModePromptOverride = prompt
	if tools != nil {
		run.planModeTools = tools
		opts.PlanModeTools = tools
	}
	// RunOptions.PlanModeSparseReminder was installed at run creation and
	// takes precedence over the hook.
	sparseFromHook := sparse != "" && run.planModeSparseReminderOverride == ""
	if sparseFromHook {
		run.planModeSparseReminderOverride = sparse
	}
	run.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "plan-mode harness inputs resolved", map[string]any{
		"run_id":               run.requestID,
		"prompt_source":        source,
		"prompt_len":           len(prompt),
		"custom_tools":         len(tools),
		"sparse_reminder_hook": sparseFromHook,
	})
}

// announcePlanModeAtRunStart emits the state-transition event for a run that
// starts while the session is already in plan mode, so consumers can mirror
// the flag. It carries the plan identity (path and slug) so a consumer can
// name the plan and tell the first announcement for a path from later ones.
func (b *ApiBackend) announcePlanModeAtRunStart(run *activeRun) {
	b.emit(run, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{
		Enabled:      true,
		PlanFilePath: run.planFilePath,
		PlanSlug:     types.PlanSlugFromPath(run.planFilePath),
	}})
	utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "run started in plan mode", map[string]any{
		"run_id":         run.requestID,
		"plan_file":      run.planFilePath,
		"bash_allowlist": run.planModeAllowedBashCommands,
	})
}

// reconcilePlanMode appends the plan-mode notice the run owes the model, if
// any. Called at the top of every turn, before the provider call.
func (b *ApiBackend) reconcilePlanMode(
	run *activeRun,
	conv *conversation.Conversation,
	hooks RunHooks,
	opts *types.RunOptions,
	turn, maxTurns int,
) {
	run.mu.Lock()
	planning := run.planMode
	planFilePath := run.planFilePath
	memo := run.planNoticeMemo
	run.mu.Unlock()

	if planning {
		b.resolvePlanModeHarness(run, hooks, opts)
	}

	told := conversation.PlanModeToldAt(conv)
	if memo != nil {
		told.Active = memo.active
		told.PlanFilePath = memo.planFilePath
		told.TurnsSince = turn - memo.turn
	}

	kind := conversation.ReconcilePlanMode(told, planning, planFilePath, planModeReminderInterval)
	if kind == types.InjectionKindNone {
		utils.LogWithFields(utils.LevelDebug, "backend.plan_mode", "plan-mode notice not due", map[string]any{
			"run_id": run.requestID, "turn": turn, "planning": planning, "told_active": told.Active, "turns_since": told.TurnsSince,
		})
		return
	}
	if kind == types.InjectionKindPlanModeReminder && opts.DisablePlanModeReminder {
		utils.LogWithFields(utils.LevelDebug, "backend.plan_mode", "plan-mode reminder disabled by limits", map[string]any{
			"run_id": run.requestID, "turn": turn,
		})
		return
	}

	noticeFile := planFilePath
	var text string
	switch kind {
	case types.InjectionKindPlanModeEnter:
		reentry := opts.PlanModeReentry || told.HasExited(planFilePath)
		text = b.planModeEnterText(run, opts, planFilePath, reentry)
	case types.InjectionKindPlanModeReminder:
		run.mu.Lock()
		text = run.planModeSparseReminderOverride
		run.mu.Unlock()
		if text == "" {
			text = buildPlanModeSparseReminder(planFilePath)
		}
		text = "[SYSTEM] " + text
	case types.InjectionKindPlanModeExit:
		if told.PlanFilePath != "" {
			noticeFile = told.PlanFilePath
		}
		text = buildPlanModeExitNotice(noticeFile)
	}

	suppressed := false
	if hooks.OnSystemInject != nil {
		hookText, suppress := hooks.OnSystemInject(string(kind), text, turn, maxTurns)
		suppressed = suppress
		if hookText != "" {
			text = hookText
		}
	}

	transient := opts.SuppressSystemMessages
	if suppressed || transient {
		run.mu.Lock()
		run.planNoticeMemo = &planNoticeMemo{active: planning, planFilePath: planFilePath, turn: turn}
		run.mu.Unlock()
	}
	if suppressed {
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "plan-mode notice suppressed by system_inject hook", map[string]any{
			"run_id": run.requestID, "turn": turn, "kind": string(kind),
		})
		return
	}

	entry := conversation.AddPlanModeNotice(conv, kind, text, noticeFile, transient)
	entryID := ""
	if entry != nil {
		entryID = entry.ID
		run.mu.Lock()
		run.planNoticeMemo = nil
		run.mu.Unlock()
		if err := persistConversation(run, conv); err != nil {
			utils.LogWithFields(utils.LevelError, "backend.plan_mode", "failed to save conversation after plan-mode notice", map[string]any{
				"run_id": run.requestID, "kind": string(kind), "error": utils.ErrStr(err),
			})
		}
	}
	utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "plan-mode notice appended", map[string]any{
		"run_id":      run.requestID,
		"turn":        turn,
		"kind":        string(kind),
		"plan_file":   noticeFile,
		"len":         len(text),
		"persisted":   entry != nil,
		"entry_id":    entryID,
		"turns_since": told.TurnsSince,
	})
}

// planModeEnterText builds the enter notice: the harness prompt when one was
// supplied, otherwise the engine default, with the re-entry guidance in front
// when the model is coming back to a plan it already left.
func (b *ApiBackend) planModeEnterText(run *activeRun, opts *types.RunOptions, planFilePath string, reentry bool) string {
	run.mu.Lock()
	text := run.planModePromptOverride
	run.mu.Unlock()
	if text == "" {
		_, err := os.Stat(planFilePath)
		text = buildPlanModePrompt(planFilePath, err == nil, effectiveBashAllowlist(*opts), effectiveMcpAllowlist(*opts))
	}
	if reentry {
		text = buildPlanModeReentryPrompt(planFilePath) + "\n\n" + text
	}
	return text
}

// buildPlanModeExitNotice is the notice that ends an earlier enter notice.
func buildPlanModeExitNotice(planFilePath string) string {
	text := "[PLAN MODE ENDED] Plan mode has ended. The plan-mode restrictions above no longer apply: you may make edits, run tools, and change the system."
	if planFilePath != "" {
		text += fmt.Sprintf(" The plan file is at %s if you need to refer to it.", planFilePath)
	}
	return text
}
