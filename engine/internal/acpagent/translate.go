package acpagent

import (
	"encoding/json"
	"strings"

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
	case "engine_message_end":
		s.usage(e)
	case "engine_status":
		s.status(e)
	case "engine_error":
		s.engineError(e)
	case "engine_permission_request":
		go s.permissionRequest(e)
	case "engine_elicitation_request":
		go s.elicitationRequest(e)
	case "engine_dialog":
		go s.dialogRequest(e)
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
	if message == "" {
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
		s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateNotice, Severity: severity, Title: message})
		return
	}
	s.chunk(UpdateAgentMessageChunk, "\n"+message+"\n")
}

// toolInputs accumulates a tool call's streamed partial input by tool id so
// the completed update can carry the parsed rawInput.
func (s *Session) toolStart(e map[string]any) {
	name := str(e, "toolName")
	id := str(e, "toolId")
	s.mu.Lock()
	if s.toolInput == nil {
		s.toolInput = map[string]*strings.Builder{}
	}
	s.toolInput[id] = &strings.Builder{}
	s.mu.Unlock()
	s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateToolCall, ToolCallID: id, Title: bareToolName(name), Name: name, Kind: toolKind(name), Status: "in_progress"})
}

func (s *Session) toolUpdate(e map[string]any) {
	id := str(e, "toolId")
	partial := str(e, "partialInput")
	s.mu.Lock()
	if b, ok := s.toolInput[id]; ok {
		b.WriteString(partial)
	}
	s.mu.Unlock()
}

func (s *Session) toolEnd(e map[string]any) {
	id := str(e, "toolId")
	s.mu.Lock()
	var raw string
	if b, ok := s.toolInput[id]; ok {
		raw = b.String()
		delete(s.toolInput, id)
	}
	s.mu.Unlock()
	status := "completed"
	if isErr, _ := e["isError"].(bool); isErr { //nolint:errcheck // absent means success
		status = "failed"
	}
	update := SessionUpdate{SessionUpdate: UpdateToolCallUpdate, ToolCallID: id, Status: status}
	if raw == "" {
		// A delegated-CLI run streams no partial input; the end event
		// carries the whole input instead.
		if input, ok := e["toolInput"].(map[string]any); ok && len(input) > 0 {
			if encoded, err := json.Marshal(input); err == nil {
				raw = string(encoded)
			}
		}
	}
	if raw != "" && json.Valid([]byte(raw)) {
		update.RawInput = json.RawMessage(raw)
		if title := toolTitle(bareToolName(str(e, "toolName")), raw); title != "" {
			update.Title = title
		}
	}
	if result := str(e, "result"); result != "" {
		update.ToolContent = []ToolCallContent{{Type: "content", Content: ContentBlock{Type: "text", Text: result}}}
	}
	s.agent.notify(s.id, update)
}

func (s *Session) imageContent(e map[string]any) {
	path := str(e, "imagePath")
	if path == "" {
		return
	}
	block := ContentBlock{Type: "resource_link", URI: "file://" + path, MimeType: str(e, "imageMediaType")}
	if toolID := str(e, "imageToolId"); toolID != "" {
		s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateToolCallUpdate, ToolCallID: toolID, ToolContent: []ToolCallContent{{Type: "content", Content: block}}})
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

// status ends the prompt turn on idle. The completion reason the run
// carried picks the ACP stop reason.
func (s *Session) status(e map[string]any) {
	fields, _ := e["fields"].(map[string]any) //nolint:errcheck // a status without fields carries no state
	if fields == nil || str(fields, "state") != "idle" {
		return
	}
	if cost := numF(fields, "conversationCostUsd"); cost > 0 {
		window := num(fields, "contextWindow")
		if window > 0 {
			used := num(fields, "contextTokens")
			s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateUsage, Used: &used, Size: &window, Cost: &Cost{Amount: cost, Currency: "USD"}})
		}
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

type engineError struct{ msg, code string }

func (e *engineError) Error() string {
	if e.code != "" {
		return e.code + ": " + e.msg
	}
	return e.msg
}

// toolKind maps an engine tool name onto the ACP tool kind vocabulary. A
// delegated-CLI run names Ion's tools through its MCP bridge
// (`mcp__ion-extensions__Bash`); the bare name decides the kind.
func toolKind(name string) string {
	switch bareToolName(name) {
	case "Read", "NotebookRead":
		return "read"
	case "Glob", "Grep", "WorktreeList", "WorktreeCommits", "WorktreeDiff":
		return "search"
	case "Edit", "Write", "MultiEdit", "NotebookEdit":
		return "edit"
	case "Bash", "BashOutput", "KillShell":
		return "execute"
	case "WebFetch", "WebSearch":
		return "fetch"
	case "EnterPlanMode", "ExitPlanMode":
		return "switch_mode"
	}
	return "other"
}

// bareToolName strips the MCP bridge prefix a delegated CLI puts on Ion's
// own tools, leaving third-party MCP tool names untouched.
func bareToolName(name string) string {
	const bridge = "mcp__ion-extensions__"
	if strings.HasPrefix(name, bridge) {
		return strings.TrimPrefix(name, bridge)
	}
	return name
}

// toolTitle derives a one-line title from a tool's parsed input: the
// command for a shell, the path for a file tool, the pattern for a search.
func toolTitle(name, rawInput string) string {
	var input map[string]any
	if err := json.Unmarshal([]byte(rawInput), &input); err != nil {
		return ""
	}
	for _, key := range []string{"command", "file_path", "path", "pattern", "query", "url", "description", "prompt"} {
		if v := str(input, key); v != "" {
			line := strings.SplitN(v, "\n", 2)[0]
			if len(line) > 120 {
				line = line[:117] + "..."
			}
			return name + ": " + line
		}
	}
	return name
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
