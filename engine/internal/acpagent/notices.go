package acpagent

import (
	"fmt"
	"strconv"
	"strings"
)

// Engine signals with no ACP shape of their own reach the client as
// notices, as the compaction update, or as the user turn they are, so a
// person watching the thread sees what the engine did on its own.

// noticeDescriptionMax bounds a notice's description.
const noticeDescriptionMax = 4000

func itoa(n int) string { return strconv.Itoa(n) }

// compacting reports the engine's own compaction: in progress when it
// starts, completed with its summary when it ends.
func (s *Session) compacting(e map[string]any) {
	active, _ := e["active"].(bool) //nolint:errcheck // absent means finished
	update := SessionUpdate{SessionUpdate: UpdateCompaction, CompactionID: "engine-compaction", Status: "completed"}
	if active {
		update.Status = "in_progress"
	} else {
		text := str(e, "summary")
		if before, after := num(e, "messagesBefore"), num(e, "messagesAfter"); before > 0 {
			text = strings.TrimSpace(fmt.Sprintf("Compacted %d messages to %d.\n\n%s", before, after, text))
		}
		if text != "" {
			update.Summary = []ContentBlock{{Type: "text", Text: bound(text, noticeDescriptionMax)}}
		}
	}
	s.agent.notify(s.id, update)
}

// nativeCompaction reports a delegated CLI compacting its own session.
func (s *Session) nativeCompaction(e map[string]any) {
	text := fmt.Sprintf("The model compacted its context (%s): %d messages summarized from %d tokens.", str(e, "nativeCompactionTrigger"), num(e, "nativeCompactionMessagesSummarized"), num(e, "nativeCompactionPreTokens"))
	s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateCompaction, CompactionID: "native-compaction", Status: "completed", Summary: []ContentBlock{{Type: "text", Text: text}}})
}

// promptInjected shows a turn the engine started on its own. A person's
// turn delivered by an extension is a user message; a machine-authored one
// (a background result, an agent's completion, a check-in) is a notice
// that names its kind.
func (s *Session) promptInjected(e map[string]any) {
	text := str(e, "injectedPrompt")
	machine, _ := e["injectedPromptMachineAuthored"].(bool) //nolint:errcheck // absent means a person's turn
	if !machine {
		s.chunk(UpdateUserMessageChunk, text)
		return
	}
	title := map[string]string{
		"agent_completion":           "An agent finished; its result was delivered to the conversation",
		"background_task_completion": "A background command finished; its result was delivered to the conversation",
		"poll_result":                "A poll finished; its result was delivered to the conversation",
		"checkin":                    "A scheduled check-in started a turn",
		"revive":                     "The conversation was revived",
		"run_recovery":               "The run was recovered after an engine restart",
	}[str(e, "injectedPromptKind")]
	if title == "" {
		title = "The engine started a turn on its own"
	}
	s.noticeDetail("info", title, bound(text, noticeDescriptionMax))
}

// backgroundTaskComplete announces a background command's end with its
// output tail.
func (s *Session) backgroundTaskComplete(e map[string]any) {
	done, _ := e["backgroundTaskComplete"].(map[string]any) //nolint:errcheck // absent means nothing to show
	if done == nil {
		return
	}
	title := "Background command " + str(done, "status")
	if code, ok := done["exitCode"].(float64); ok {
		title += fmt.Sprintf(" (exit %d)", int(code))
	}
	var lines []string
	if command := str(done, "command"); command != "" {
		lines = append(lines, "$ "+firstLine(command, 200))
	}
	if tail, ok := done["tail"].([]any); ok {
		for _, line := range tail {
			if text, ok := line.(string); ok {
				lines = append(lines, text)
			}
		}
	}
	s.noticeDetail("info", title, bound(strings.Join(lines, "\n"), noticeDescriptionMax))
}

// notification shows an extension's ctx.Notify.
func (s *Session) notification(e map[string]any) {
	title := firstString(e, "notifyTitle", "pushTitle", "message")
	body := firstString(e, "notifyBody", "pushBody")
	s.noticeDetail("info", title, bound(body, noticeDescriptionMax))
}

// intercept shows an extension's ctx.Intercept; a redirect is a warning.
func (s *Session) intercept(e map[string]any) {
	level := "info"
	if str(e, "interceptLevel") == "redirect" {
		level = "warning"
	}
	s.noticeDetail(level, firstString(e, "interceptTitle", "interceptMessage"), bound(str(e, "interceptMessage"), noticeDescriptionMax))
}

func (s *Session) modelFallback(e map[string]any) {
	s.noticeDetail("warning", "Model "+str(e, "fallbackRequestedModel")+" is unavailable; running on "+str(e, "fallbackModel"), str(e, "fallbackReason"))
}

// capabilityUnsupported ends the turn: the engine declined the prompt and
// no run will start.
func (s *Session) capabilityUnsupported(e map[string]any) {
	s.noticeDetail("error", "The "+str(e, "capabilityBackend")+" backend does not support "+str(e, "capability"), str(e, "capabilityReason"))
	s.finishTurn(StopEndTurn, nil)
}

func (s *Session) runStalled(e map[string]any) {
	s.noticeDetail("warning", fmt.Sprintf("The run made no progress for %.0fs and is being stopped", numF(e, "runStalledDuration")), "Last activity: "+str(e, "runStalledLastActivity"))
}

// rateLimit shows a usage-limit verdict other than allowed.
func (s *Session) rateLimit(e map[string]any) {
	limit, _ := e["rateLimit"].(map[string]any) //nolint:errcheck // absent means nothing to show
	status := str(limit, "status")
	if status == "" || status == "allowed" {
		return
	}
	level := "warning"
	if status == "rejected" {
		level = "error"
	}
	s.noticeDetail(level, "Usage limit: "+status, "Window: "+str(limit, "rateLimitType"))
}

func bound(text string, max int) string {
	if len(text) <= max {
		return text
	}
	return text[:max-1] + "…"
}
