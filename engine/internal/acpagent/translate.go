package acpagent

import (
	"github.com/dsswift/ion/engine/internal/utils"
)

// translate maps one engine event onto the ACP surface. Events the client
// has no use for are dropped here, by name, so a new engine event never
// leaks through as something the client misreads.
func (s *Session) translate(ev EngineEvent) {
	e := ev.Event
	switch ev.Type {
	case "engine_text_delta", "engine_text_chunk":
		s.chunk(UpdateAgentMessageChunk, str(e, "text"))
	case "engine_thinking_delta":
		s.chunk(UpdateAgentThoughtChunk, str(e, "thinkingText"))
	case "engine_harness_message":
		s.chunk(UpdateAgentMessageChunk, str(e, "message")+"\n")
	case "engine_notify":
		s.notice(str(e, "level"), str(e, "message"))
	case "engine_tool_start", "engine_tool_call":
		s.toolStart(e)
	case "engine_tool_update", "engine_tool_call_update":
		s.toolUpdate(e)
	case "engine_tool_end", "engine_tool_result":
		s.toolEnd(e)
	case "engine_image_content":
		s.imageContent(e)
	case "engine_command_registry":
		s.commandRegistry(e)
	case "engine_plan_mode_changed":
		s.planModeChanged(e)
	case "engine_plan_proposal":
		s.planProposal(e)
	case "engine_plan_file_written":
		s.planFileWritten(e)
	case "engine_message_end":
		s.usage(e)
	case "engine_status":
		s.status(e)
	case "engine_command_result":
		s.commandResult(e)
	case "engine_error":
		s.engineError(e)
	case "engine_dead":
		s.engineDead(e)
	case "engine_session_released":
		s.markReleased(e)
	case "engine_permission_request":
		go s.permissionRequest(e)
	case "engine_elicitation_request":
		go s.elicitationRequest(e)
	case "engine_dialog":
		go s.dialogRequest(e)
	case "engine_dispatch_start":
		s.dispatchStart(e)
	case "engine_dispatch_activity":
		s.dispatchActivity(e)
	case "engine_dispatch_end":
		s.dispatchEnd(e)
	case "engine_dispatch_lost":
		s.dispatchLost(e)
	case "engine_compacting":
		s.compacting(e)
	case "engine_native_compaction":
		s.nativeCompaction(e)
	case "engine_prompt_injected":
		s.promptInjected(e)
	case "engine_background_task_complete":
		s.backgroundTaskComplete(e)
	case "engine_notification":
		s.notification(e)
	case "engine_intercept":
		s.intercept(e)
	case "engine_model_fallback":
		s.modelFallback(e)
	case "engine_capability_unsupported":
		s.capabilityUnsupported(e)
	case "engine_run_stalled":
		s.runStalled(e)
	case "engine_rate_limit":
		s.rateLimit(e)
	default:
		utils.TraceWithFields("acp", "event not surfaced", map[string]any{"session_id": s.id, "event_type": ev.Type})
	}
}

func (s *Session) chunk(kind, text string) {
	if text == "" {
		return
	}
	s.agent.notify(s.id, SessionUpdate{SessionUpdate: kind, Content: &ContentBlock{Type: "text", Text: text}})
}

// notice sends a notice when the client renders them, else an agent chunk
// so the text is not lost.
func (s *Session) notice(level, message string) {
	s.noticeDetail(level, message, "")
}

// noticeDetail is notice with a description under the title. A client
// without notices gets the title and the description as text.
func (s *Session) noticeDetail(level, title, description string) {
	if title == "" {
		return
	}
	severity := "info"
	switch level {
	case "warning", "warn":
		severity = "warning"
	case "error":
		severity = "error"
	}
	if s.agent.clientSupportsNotices() {
		s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateNotice, Severity: severity, Title: title, Description: description})
		return
	}
	text := "\n" + title + "\n"
	if description != "" {
		text += description + "\n"
	}
	s.chunk(UpdateAgentMessageChunk, text)
}

func (s *Session) imageContent(e map[string]any) {
	path := str(e, "imagePath")
	if path == "" {
		return
	}
	block := ContentBlock{Type: "resource_link", URI: "file://" + path, MimeType: str(e, "imageMediaType")}
	if toolID := str(e, "imageToolId"); toolID != "" {
		s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateToolCallUpdate, ToolCallID: toolID, ToolContent: []ToolCallContent{{Type: "content", Content: &block}}})
		return
	}
	s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateAgentMessageChunk, Content: &block})
}

func (s *Session) commandRegistry(e map[string]any) {
	var listed []AvailableCommand
	if raw, ok := e["commands"].([]any); ok {
		for _, item := range raw {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			listed = append(listed, AvailableCommand{Name: str(m, "name"), Description: str(m, "description")})
		}
	}
	if listed == nil {
		listed = []AvailableCommand{}
	}
	s.mu.Lock()
	s.commands = listed
	s.mu.Unlock()
	s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateAvailableCommands, AvailableCommands: listed})
}

func (s *Session) planModeChanged(e map[string]any) {
	enabled, _ := e["planModeEnabled"].(bool) //nolint:errcheck // absent means exited
	s.mu.Lock()
	s.planMode = enabled
	s.mu.Unlock()
	mode := ModeBuild
	if enabled {
		mode = ModePlan
	}
	s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateCurrentMode, CurrentModeID: mode})
}

func (s *Session) usage(e map[string]any) {
	tokens := num(e, "contextTokens")
	window := num(e, "contextWindow")
	if window == 0 {
		return
	}
	used, size := tokens, window
	s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateUsage, Used: &used, Size: &size})
}

// status ends the prompt turn on the idle that ends its run, unless the
// idle owes the turn more: a question the client must answer, a plan
// approval in flight, or background work the engine will resume on. The
// completion reason the run carried picks the ACP stop reason.
func (s *Session) status(e map[string]any) {
	fields, _ := e["fields"].(map[string]any) //nolint:errcheck // a status without fields carries no state
	if fields == nil {
		return
	}
	state := str(fields, "state")
	if !s.observeRunEpoch(fields, state) || state != "idle" {
		return
	}
	if cost := numF(fields, "conversationCostUsd"); cost > 0 {
		window := num(fields, "contextWindow")
		if window > 0 {
			used := num(fields, "contextTokens")
			s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateUsage, Used: &used, Size: &window, Cost: &Cost{Amount: cost, Currency: "USD"}})
		}
	}
	s.mu.Lock()
	t := s.turn
	sawEpoch := s.sawEpoch
	s.mu.Unlock()
	if t == nil {
		return
	}
	if _, hasEpoch := fields["runEpoch"]; !hasEpoch && sawEpoch {
		// The run's completion idle carries no epoch and no work inventory;
		// the snapshot the engine emits right after it carries both, and
		// the turn is settled on that one.
		return
	}
	if s.askPendingQuestions(t, fields) {
		return
	}
	s.mu.Lock()
	awaiting := t.awaiting()
	holds := idleHoldsWork(fields)
	if holds {
		t.hold()
	}
	s.mu.Unlock()
	if awaiting {
		return
	}
	if holds {
		utils.LogWithFields(utils.LevelInfo, "acp", "turn held open for the engine's pending work", map[string]any{"session_id": s.id, "background_shells": num(fields, "backgroundShells"), "polls": num(fields, "pollsWaiting"), "background_agents": num(fields, "backgroundAgents")})
		return
	}
	switch str(fields, "completionReason") {
	case "aborted":
		s.finishTurn(StopCancelled, nil)
	case "max_turns":
		s.finishTurn(StopMaxTurnRequests, nil)
	default:
		s.finishTurn(StopEndTurn, nil)
	}
}

// idleHoldsWork reports whether an idle status says the engine will run
// again on its own for this session: it is parked on background commands,
// waiting on polls, or has agents working that will deliver into a run.
func idleHoldsWork(fields map[string]any) bool {
	pending, _ := fields["hasPendingWork"].(bool) //nolint:errcheck // absent means none
	if !pending {
		return false
	}
	return num(fields, "backgroundShells") > 0 || num(fields, "pollsWaiting") > 0 || num(fields, "backgroundAgents") > 0
}

// observeRunEpoch records the status's run epoch and reports whether the
// status describes the active turn's run (always true with no turn, or from
// an engine whose statuses carry no epoch). A status whose epoch has not
// passed the turn's baseline was built before the engine took the prompt. A
// lower epoch than the last one seen means the engine recreated the session,
// so the baseline is rebased onto the new count.
func (s *Session) observeRunEpoch(fields map[string]any, state string) bool {
	raw, ok := fields["runEpoch"].(float64)
	if !ok {
		return true
	}
	epoch := int64(raw)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sawEpoch = true
	t := s.turn
	if t != nil && epoch < s.runEpoch {
		t.baseline = epoch
		if state == "running" {
			t.baseline = epoch - 1
		}
	}
	s.runEpoch = epoch
	if t == nil {
		return true
	}
	if epoch <= t.baseline {
		utils.LogWithFields(utils.LevelDebug, "acp", "status predates the prompt; turn continues", map[string]any{"session_id": s.id, "state": state, "run_epoch": epoch, "baseline": t.baseline})
		return false
	}
	if state == "running" {
		t.started = true
		t.holding = false
	}
	return true
}

// commandResult ends a slash command's turn when the command finished
// without starting a run; a command that started one ends on its idle.
func (s *Session) commandResult(e map[string]any) {
	s.mu.Lock()
	t := s.turn
	waitForRun := t == nil || !t.command || t.started
	s.mu.Unlock()
	if waitForRun {
		return
	}
	if msg := str(e, "commandError"); msg != "" {
		s.finishTurn(StopEndTurn, &engineError{msg: msg, code: "command_failed"})
		return
	}
	s.finishTurn(StopEndTurn, nil)
}

// engineError ends the turn with the engine's message. A warning-level
// error (a retry the engine recovered from) is shown and the run goes on.
func (s *Session) engineError(e map[string]any) {
	msg := str(e, "message")
	level := str(e, "level")
	if level == "warn" || level == "warning" || level == "info" {
		s.notice(level, msg)
		return
	}
	s.mu.Lock()
	inTurn := s.turn != nil
	s.mu.Unlock()
	if !inTurn {
		// Outside a prompt the JSON-RPC error has nowhere to go; the text
		// reaches the client as a notice instead.
		s.notice("error", msg)
		return
	}
	s.finishTurn(StopEndTurn, &engineError{msg: msg, code: str(e, "errorCode")})
}

// engineDead ends the turn: the run's process died abnormally and no idle
// for it is coming.
func (s *Session) engineDead(e map[string]any) {
	detail := "the run's process died"
	if code, ok := e["exitCode"].(float64); ok {
		detail += " (exit " + itoa(int(code)) + ")"
	}
	if signal := str(e, "signal"); signal != "" {
		detail += " (" + signal + ")"
	}
	s.mu.Lock()
	inTurn := s.turn != nil
	s.mu.Unlock()
	if !inTurn {
		s.notice("error", detail)
		return
	}
	s.finishTurn(StopEndTurn, &engineError{msg: detail, code: "engine_dead"})
}

type engineError struct{ msg, code string }

func (e *engineError) Error() string {
	if e.code != "" {
		return e.code + ": " + e.msg
	}
	return e.msg
}

func str(m map[string]any, key string) string {
	v, _ := m[key].(string) //nolint:errcheck // absent or non-string reads as empty
	return v
}

func num(m map[string]any, key string) int {
	v, _ := m[key].(float64) //nolint:errcheck // absent reads as zero
	return int(v)
}

func numF(m map[string]any, key string) float64 {
	v, _ := m[key].(float64) //nolint:errcheck // absent reads as zero
	return v
}
