package session

import (
	"strings"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// prompt_cli_plan_notice.go — plan-mode notices for a delegated claude-code
// run.
//
// A claude-code run is spawned with the same arguments whatever the session's
// mode, so plan mode reaches the model the way it does on the API backend: as a
// notice in the conversation where the mode changed. The CLI keeps its own
// session history, so the notice travels as the leading block of the user turn
// the engine writes to its stdin, and stays in that history from then on.
//
// The conversation Ion stores records the same notice as an entry of its own,
// which is what the next dispatch reads to decide whether the model has been
// told.

// cliPlanNotice is a plan-mode notice sent to a delegated CLI.
type cliPlanNotice struct {
	kind         types.InjectionKind
	text         string
	planFilePath string
}

// cliPlanNoticeMemo is what the model was last told about plan mode, held on
// the session when the notice itself was kept out of the conversation.
type cliPlanNoticeMemo struct {
	active       bool
	planFilePath string
}

// deliverCliPlanNotice puts the plan-mode notice this run owes the model at
// the front of its user turn, and records it in the conversation.
//
// userPrompt is opts.Prompt as it stood before the resume-or-bridge decision.
// When that decision bridged (a fresh CLI session seeded with a transcript of
// the conversation), opts.Prompt is now the transcript followed by userPrompt,
// and the notice goes between the two so it sits next to the turn it governs.
//
// A bridged run starts a CLI session that holds none of the earlier notices
// as instructions, only whatever the bounded transcript kept. A planning
// session is therefore always given the full enter notice when it bridges,
// whatever the conversation says the model was told before.
func (m *Manager) deliverCliPlanNotice(s *engineSession, key string, extGroup *extension.ExtensionGroup, skipExtensions bool, opts *types.RunOptions, userPrompt string) {
	if kind, ok := mcpCapableCli(m.resolvedBackend(opts.Model)); !ok || kind != "claude-code" {
		return
	}

	m.mu.Lock()
	planning := s.planMode
	planFilePath := s.planFilePath
	convID := s.conversationID
	memo := s.cliPlanNoticeMemo
	s.pendingCliPlanNotice = nil
	m.mu.Unlock()

	var told conversation.PlanModeTold
	if convID != "" && conversation.Exists(convID, "") {
		conv, err := conversation.Load(convID, "")
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "session.plan_mode", "cli plan notice: conversation load failed, treating the model as not told", map[string]any{
				"key": key, "conversation_id": convID, "error": err.Error(),
			})
		} else {
			told = conversation.PlanModeToldAt(conv)
		}
	}
	if memo != nil {
		told.Active = memo.active
		told.PlanFilePath = memo.planFilePath
	}
	resuming := opts.CliResumeSessionID != ""
	if planning && !resuming {
		told = conversation.PlanModeTold{}
	}

	kind := conversation.ReconcilePlanMode(told, planning, planFilePath, backend.PlanModeReminderInterval)
	if kind == types.InjectionKindNone {
		utils.LogWithFields(utils.LevelDebug, "session.plan_mode", "cli plan notice not due", map[string]any{
			"key": key, "planning": planning, "told_active": told.Active, "turns_since": told.TurnsSince, "resuming": resuming,
		})
		return
	}
	if kind == types.InjectionKindPlanModeReminder && opts.DisablePlanModeReminder {
		utils.LogWithFields(utils.LevelDebug, "session.plan_mode", "cli plan reminder disabled by limits", map[string]any{"key": key})
		return
	}

	notice := cliPlanNotice{kind: kind, planFilePath: planFilePath}
	switch kind {
	case types.InjectionKindPlanModeEnter:
		notice.text = backend.CliPlanModeEnterNotice(*opts, planFilePath)
	case types.InjectionKindPlanModeReminder:
		notice.text = backend.CliPlanModeReminder(*opts, planFilePath)
	case types.InjectionKindPlanModeExit:
		if told.PlanFilePath != "" {
			notice.planFilePath = told.PlanFilePath
		}
		notice.text = backend.PlanModeExitNotice(notice.planFilePath)
	}

	suppressed := false
	if extGroup != nil && !extGroup.IsEmpty() && !skipExtensions {
		hookText, suppress := extGroup.FireSystemInject(m.newExtContext(s, key), extension.SystemInjectInfo{
			Kind:        string(kind),
			DefaultText: notice.text,
		})
		suppressed = suppress
		if hookText != "" {
			notice.text = hookText
		}
	}

	transient := opts.SuppressSystemMessages
	m.mu.Lock()
	if suppressed || transient {
		s.cliPlanNoticeMemo = &cliPlanNoticeMemo{active: planning, planFilePath: planFilePath}
	} else {
		s.cliPlanNoticeMemo = nil
	}
	m.mu.Unlock()
	if suppressed {
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "cli plan notice suppressed by system_inject hook", map[string]any{"key": key, "kind": string(kind)})
		return
	}

	seed := strings.TrimSuffix(opts.Prompt, userPrompt)
	opts.Prompt = seed + "<system-reminder>\n" + notice.text + "\n</system-reminder>\n\n" + userPrompt

	recorded := false
	if !transient {
		recorded = m.recordCliPlanNotice(key, notice.kind, notice.text, notice.planFilePath)
	}
	utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "cli plan notice sent", map[string]any{
		"key": key, "kind": string(kind), "plan_file": notice.planFilePath, "len": len(notice.text),
		"resuming": resuming, "recorded": recorded, "transient": transient,
	})
}

// recordCliPlanNotice appends a plan-mode notice to the session's stored
// conversation. When there is no conversation on disk yet, or the write fails,
// the notice is held on the session and persistCliTurn writes it with the turn.
// Reports whether the notice was written now.
func (m *Manager) recordCliPlanNotice(key string, kind types.InjectionKind, text, planFilePath string) bool {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelWarn, "session.plan_mode", "cli plan notice not recorded: session not found", map[string]any{"key": key, "kind": string(kind)})
		return false
	}
	convID := s.conversationID
	m.mu.Unlock()

	hold := func(reason string) bool {
		m.mu.Lock()
		s.pendingCliPlanNotice = &cliPlanNotice{kind: kind, text: text, planFilePath: planFilePath}
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "cli plan notice held for the turn write", map[string]any{"key": key, "kind": string(kind), "reason": reason})
		return false
	}
	if convID == "" || !conversation.Exists(convID, "") {
		return hold("no conversation on disk yet")
	}
	err := conversation.UpdateOnDisk(convID, "", func(conv *conversation.Conversation) (bool, error) {
		conversation.AddPlanModeNotice(conv, kind, text, planFilePath, false)
		return true, nil
	})
	if err != nil {
		return hold("write failed: " + err.Error())
	}
	return true
}
