package acpagent

import (
	"context"
	"encoding/json"
	"os"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// The model ending a plan with ExitPlanMode is a proposal: the engine emits
// engine_plan_proposal, ends the run, and waits for a consumer to approve
// the exit. The bridge shows the plan and asks the client through
// session/request_permission. Approval leaves plan mode and continues the
// turn with the instruction to implement; refusal ends the turn in plan
// mode, so the person's next prompt is feedback on the plan.

// planReadMax bounds the plan text sent to a client.
const planReadMax = 256 * 1024

const (
	planOptionImplement = "implement"
	planOptionKeep      = "keep-planning"
	planApprovedPrompt  = "The plan is approved. Implement it now."
)

// planProposal handles engine_plan_proposal: inside a turn the client is
// asked; outside one the proposal is only announced.
func (s *Session) planProposal(e map[string]any) {
	if str(e, "planProposalKind") != "exit" {
		return
	}
	path, slug := str(e, "planFilePath"), str(e, "planSlug")
	s.sendPlan(path, slug)
	s.mu.Lock()
	t := s.turn
	var a *ask
	if t != nil {
		a = t.beginAsk()
	}
	s.mu.Unlock()
	if t == nil {
		s.notice("info", "Plan ready for review: "+slug)
		return
	}
	go s.proposePlan(t, a, path, slug)
}

// planFileWritten handles engine_plan_file_written: the client sees the
// plan as it is written.
func (s *Session) planFileWritten(e map[string]any) {
	s.sendPlan(str(e, "planFilePath"), str(e, "planSlug"))
}

// sendPlan sends the plan file's markdown as a plan_update keyed by its
// slug. An unreadable or empty file sends nothing.
func (s *Session) sendPlan(path, slug string) {
	text := readPlan(path)
	if text == "" {
		return
	}
	if slug == "" {
		slug = path
	}
	s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdatePlanUpdate, Plan: &PlanPayload{PlanID: slug, Type: "markdown", Content: text}})
}

func readPlan(path string) string {
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "plan file unreadable", map[string]any{"path": path, "error": err.Error()})
		return ""
	}
	if len(data) > planReadMax {
		data = data[:planReadMax]
	}
	return string(data)
}

// proposePlan asks the client whether to implement the plan and acts on
// the answer.
func (s *Session) proposePlan(t *turn, a *ask, path, slug string) {
	defer s.endAsk(a)
	ref := ToolCallRef{ToolCallID: "plan-exit:" + slug, Title: "Ready to implement the plan?", Kind: "switch_mode"}
	if text := readPlan(path); text != "" {
		ref.Content = []ToolCallContent{textContent(text)}
	}
	if path != "" {
		ref.Locations = []ToolLocation{{Path: path}}
		if raw, err := json.Marshal(map[string]any{"planFilePath": path, "planSlug": slug}); err == nil {
			ref.RawInput = raw
		}
	}
	req := RequestPermissionRequest{SessionID: s.id, ToolCall: ref, Options: []PermissionOption{
		{OptionID: planOptionImplement, Name: "Yes, implement the plan", Kind: "allow_once"},
		{OptionID: planOptionKeep, Name: "No, keep planning", Kind: "reject_once"},
	}}
	ctx, cancel := context.WithTimeout(context.Background(), clientAnswerTimeout)
	defer cancel()
	raw, err := s.agent.rpc.Request(ctx, ReqRequestPermission, req)
	approved := false
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "plan approval request failed", map[string]any{"session_id": s.id, "plan": slug, "error": err.Error()})
	} else {
		var res RequestPermissionResponse
		if err := json.Unmarshal(raw, &res); err != nil {
			utils.LogWithFields(utils.LevelWarn, "acp", "plan approval response unreadable", map[string]any{"session_id": s.id, "plan": slug, "error": err.Error()})
		}
		approved = res.Outcome.Outcome == "selected" && res.Outcome.OptionID == planOptionImplement
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "plan approval answered", map[string]any{"session_id": s.id, "plan": slug, "approved": approved})
	if !approved {
		s.notice("info", "Plan not approved; still planning. Reply with what to change.")
		s.finishTurn(StopEndTurn, nil)
		return
	}
	modeCtx, cancelMode := context.WithTimeout(context.Background(), 10*time.Second)
	_, err = s.agent.engine.Send(modeCtx, map[string]any{"cmd": "set_plan_mode", "key": s.id, "enabled": false})
	cancelMode()
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "leave plan mode after approval failed", map[string]any{"session_id": s.id, "error": err.Error()})
		s.finishTurn(StopEndTurn, err)
		return
	}
	s.mu.Lock()
	s.planMode = false
	s.mu.Unlock()
	s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateCurrentMode, CurrentModeID: ModeBuild})
	s.continueTurn(t, a, planApprovedPrompt, "")
}
