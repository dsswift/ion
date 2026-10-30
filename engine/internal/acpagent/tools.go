package acpagent

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// toolCard is one tool call in flight: its name and the input streamed for
// it so far. described is set once the input parsed and the client was
// told what the call is (title, files, diff).
type toolCard struct {
	name      string
	input     strings.Builder
	described bool
}

// toolDescription is what a client shows for a tool call once its input is
// known: a title, the files it touches, and a diff for an edit.
type toolDescription struct {
	title     string
	locations []ToolLocation
	content   []ToolCallContent
	// entries is the plan a TodoWrite carries; it is sent as a plan update
	// rather than as tool content.
	entries []PlanEntry
}

// toolStart opens a tool card and tells the client a call began. The input
// is not known yet; it follows on tool updates.
func (s *Session) toolStart(e map[string]any) {
	name := str(e, "toolName")
	id := str(e, "toolId")
	s.mu.Lock()
	if s.tools == nil {
		s.tools = map[string]*toolCard{}
	}
	s.tools[id] = &toolCard{name: name}
	s.mu.Unlock()
	bare := bareToolName(name)
	s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateToolCall, ToolCallID: id, Title: bare, Name: name, Kind: toolKind(name), Status: "in_progress", Meta: toolMeta(name)})
}

// toolUpdate appends streamed input. The moment the input is whole JSON the
// client learns what the call is, while the tool still runs.
func (s *Session) toolUpdate(e map[string]any) {
	id := str(e, "toolId")
	partial := str(e, "partialInput")
	s.mu.Lock()
	card, ok := s.tools[id]
	if ok {
		card.input.WriteString(partial)
	}
	var raw string
	describe := ok && !card.described && json.Valid([]byte(card.input.String()))
	if describe {
		card.described = true
		raw = card.input.String()
	}
	s.mu.Unlock()
	if !describe {
		return
	}
	update := SessionUpdate{SessionUpdate: UpdateToolCallUpdate, ToolCallID: id, Meta: toolMeta(card.name)}
	s.applyInput(&update, card.name, raw)
	s.agent.notify(s.id, update)
}

// toolEnd closes the card: the status, the input when it was never
// described (a run that streams no partial input carries it whole on the
// end event), and the result as text content.
func (s *Session) toolEnd(e map[string]any) {
	id := str(e, "toolId")
	s.mu.Lock()
	card, ok := s.tools[id]
	var name, raw string
	described := false
	if ok {
		name, raw, described = card.name, card.input.String(), card.described
		delete(s.tools, id)
	}
	s.mu.Unlock()
	if name == "" {
		name = str(e, "toolName")
	}
	status := "completed"
	if isErr, _ := e["isError"].(bool); isErr { //nolint:errcheck // absent means success
		status = "failed"
	}
	update := SessionUpdate{SessionUpdate: UpdateToolCallUpdate, ToolCallID: id, Status: status, Meta: toolMeta(name)}
	if raw == "" {
		if input, ok := e["toolInput"].(map[string]any); ok && len(input) > 0 {
			if encoded, err := json.Marshal(input); err == nil {
				raw = string(encoded)
			}
		}
	}
	if !described && raw != "" && json.Valid([]byte(raw)) {
		s.applyInput(&update, name, raw)
	}
	if result := str(e, "result"); result != "" {
		if !described {
			update.ToolContent = append(update.ToolContent, textContent(result))
		} else {
			// The diff an edit was described with stays on the card beside
			// the result, because a content update replaces the list.
			update.ToolContent = append(describeTool(bareToolName(name), s.cwd, parseInput(raw)).content, textContent(result))
		}
	}
	s.agent.notify(s.id, update)
}

// applyInput stamps an update with the call's parsed input: the raw input,
// the title, the files, and the diff. A TodoWrite also sends its plan.
func (s *Session) applyInput(update *SessionUpdate, name, raw string) {
	update.RawInput = json.RawMessage(raw)
	input := parseInput(raw)
	desc := describeTool(bareToolName(name), s.cwd, input)
	update.Title = desc.title
	update.Locations = desc.locations
	if len(desc.content) > 0 {
		update.ToolContent = desc.content
	}
	if len(desc.entries) > 0 {
		s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdatePlan, Entries: desc.entries})
	}
}

func parseInput(raw string) map[string]any {
	var input map[string]any
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		utils.TraceWithFields("acp", "tool input is not an object", map[string]any{"error": err.Error()})
		return nil
	}
	return input
}

// toolMeta is the _meta a client reads to learn the tool behind a call:
// the tool's wire name, under the key the Claude agent adapter uses.
func toolMeta(name string) map[string]any {
	if name == "" {
		return nil
	}
	return map[string]any{"claudeCode": map[string]any{"toolName": name}}
}

// describeTool derives what a client shows for a tool call from its input,
// the way the Claude agent adapter does: a path for a file tool, the
// command for a shell, the pattern for a search, a diff for an edit.
func describeTool(name, cwd string, input map[string]any) toolDescription {
	d := toolDescription{title: name}
	if input == nil {
		return d
	}
	path := firstString(input, "file_path", "path", "notebook_path")
	switch name {
	case "Read", "NotebookRead":
		if path == "" {
			return d
		}
		offset, limit := num(input, "offset"), num(input, "limit")
		lines := ""
		if limit > 0 {
			start := offset
			if start == 0 {
				start = 1
			}
			lines = fmt.Sprintf(" (%d - %d)", start, start+limit-1)
		} else if offset > 0 {
			lines = fmt.Sprintf(" (from line %d)", offset)
		}
		d.title = "Read " + displayPath(path, cwd) + lines
		line := offset
		if line == 0 {
			line = 1
		}
		d.locations = []ToolLocation{{Path: path, Line: &line}}
	case "Write":
		if path == "" {
			return d
		}
		d.title = "Write " + displayPath(path, cwd)
		d.locations = []ToolLocation{{Path: path}}
		content := str(input, "content")
		d.content = []ToolCallContent{{Type: "diff", Path: path, NewText: &content}}
	case "Edit", "MultiEdit", "NotebookEdit":
		if path == "" {
			return d
		}
		d.title = name + " " + displayPath(path, cwd)
		d.locations = []ToolLocation{{Path: path}}
		d.content = editDiffs(path, input)
	case "Glob":
		d.title = "Find"
		if dir := str(input, "path"); dir != "" {
			d.title += " `" + displayPath(dir, cwd) + "`"
			d.locations = []ToolLocation{{Path: dir}}
		}
		if pattern := str(input, "pattern"); pattern != "" {
			d.title += " `" + pattern + "`"
		}
	case "Grep":
		d.title = "grep"
		if pattern := str(input, "pattern"); pattern != "" {
			d.title += " \"" + pattern + "\""
		}
		if dir := str(input, "path"); dir != "" {
			d.title += " " + displayPath(dir, cwd)
			d.locations = []ToolLocation{{Path: dir}}
		}
	case "Bash":
		if command := str(input, "command"); command != "" {
			d.title = firstLine(command, 120)
		}
	case "WebFetch":
		if url := str(input, "url"); url != "" {
			d.title = "Fetch " + url
		}
	case "WebSearch":
		if query := str(input, "query"); query != "" {
			d.title = "\"" + query + "\""
		}
	case "Agent", "Task":
		if desc := str(input, "description"); desc != "" {
			d.title = desc
		} else if task := firstString(input, "task", "prompt"); task != "" {
			d.title = firstLine(task, 120)
		}
		if prompt := firstString(input, "prompt", "task"); prompt != "" {
			d.content = []ToolCallContent{textContent(prompt)}
		}
	case "TodoWrite":
		d.title = "Update TODOs"
		d.entries = planEntries(input)
	case "ExitPlanMode":
		d.title = "Ready to code?"
		if plan := str(input, "plan"); plan != "" {
			d.content = []ToolCallContent{textContent(plan)}
		}
	case "AskUserQuestion", "AskUserQuestions":
		d.title = "Question"
		if question := firstQuestion(input); question != "" {
			d.title = "Question: " + firstLine(question, 120)
		}
	default:
		if server, tool, ok := mcpToolParts(name); ok {
			d.title = server + ": " + tool
		}
		if detail := firstString(input, "command", "file_path", "path", "pattern", "query", "url", "description", "prompt"); detail != "" {
			d.title += ": " + firstLine(detail, 120)
		}
	}
	return d
}

// editDiffs builds the diff content of an Edit (one replacement) or a
// MultiEdit (a list of edits) from its input.
func editDiffs(path string, input map[string]any) []ToolCallContent {
	var diffs []ToolCallContent
	add := func(edit map[string]any) {
		oldText, newText := str(edit, "old_string"), str(edit, "new_string")
		if oldText == "" && newText == "" {
			return
		}
		diff := ToolCallContent{Type: "diff", Path: path, NewText: &newText}
		if oldText != "" {
			diff.OldText = &oldText
		}
		diffs = append(diffs, diff)
	}
	if edits, ok := input["edits"].([]any); ok {
		for _, item := range edits {
			if edit, ok := item.(map[string]any); ok {
				add(edit)
			}
		}
		return diffs
	}
	if source := str(input, "new_source"); source != "" {
		return []ToolCallContent{{Type: "diff", Path: path, NewText: &source}}
	}
	add(input)
	return diffs
}

// planEntries reads a TodoWrite's todos as plan entries.
func planEntries(input map[string]any) []PlanEntry {
	todos, ok := input["todos"].([]any)
	if !ok {
		return nil
	}
	var entries []PlanEntry
	for _, item := range todos {
		todo, ok := item.(map[string]any)
		if !ok {
			continue
		}
		content := str(todo, "content")
		if content == "" {
			continue
		}
		status := str(todo, "status")
		if status == "" {
			status = "pending"
		}
		entries = append(entries, PlanEntry{Content: content, Status: status, Priority: "medium"})
	}
	return entries
}

// firstQuestion is the question a question tool carries: the single
// question, or the first of a batch.
func firstQuestion(input map[string]any) string {
	if q := str(input, "question"); q != "" {
		return q
	}
	if questions, ok := input["questions"].([]any); ok && len(questions) > 0 {
		if first, ok := questions[0].(map[string]any); ok {
			return str(first, "question")
		}
	}
	return ""
}

// mcpToolParts splits an MCP tool name into its server and tool.
func mcpToolParts(name string) (server, tool string, ok bool) {
	rest, found := strings.CutPrefix(name, "mcp__")
	if !found {
		return "", "", false
	}
	server, tool, found = strings.Cut(rest, "__")
	if !found || server == "" || tool == "" {
		return "", "", false
	}
	return server, tool, true
}

// displayPath shows a path inside the working directory relative to it.
func displayPath(path, cwd string) string {
	if cwd == "" || !filepath.IsAbs(path) {
		return path
	}
	rel, err := filepath.Rel(cwd, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		return path
	}
	return rel
}

func firstString(input map[string]any, keys ...string) string {
	for _, key := range keys {
		if v := str(input, key); v != "" {
			return v
		}
	}
	return ""
}

func firstLine(text string, max int) string {
	line := strings.SplitN(strings.TrimSpace(text), "\n", 2)[0]
	if len(line) > max {
		line = line[:max-3] + "..."
	}
	return line
}

// toolKind maps an engine tool name onto the ACP tool kind vocabulary. A
// delegated-CLI run names Ion's tools through its MCP bridge
// (`mcp__ion-extensions__Bash`); the bare name decides the kind.
func toolKind(name string) string {
	switch bareToolName(name) {
	case "Read", "NotebookRead":
		return "read"
	case "Glob", "Grep", "LS", "WorktreeList", "WorktreeCommits", "WorktreeDiff":
		return "search"
	case "Edit", "Write", "MultiEdit", "NotebookEdit":
		return "edit"
	case "Bash", "BashOutput", "KillShell":
		return "execute"
	case "WebFetch", "WebSearch":
		return "fetch"
	case "EnterPlanMode", "ExitPlanMode":
		return "switch_mode"
	case "Agent", "Task", "TodoWrite":
		return "think"
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
