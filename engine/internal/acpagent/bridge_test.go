package acpagent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// snapshot is an engine_status the way the engine's run-exit snapshot
// carries it: with the epoch and whatever work inventory the test adds.
func snapshot(state string, epoch int64, extra map[string]any) map[string]any {
	fields := map[string]any{"state": state, "runEpoch": epoch}
	for k, v := range extra {
		fields[k] = v
	}
	return map[string]any{"type": "engine_status", "fields": fields}
}

func questionDenial(id, question string, options ...string) map[string]any {
	input := map[string]any{"question": question}
	if len(options) > 0 {
		input["options"] = options
	}
	return map[string]any{"toolName": "mcp__ion-extensions__AskUserQuestion", "toolUseId": id, "toolInput": input}
}

// formClient answers every elicitation with the given content and records
// what it was asked.
func formClient(t *testing.T, c *acpClient, content map[string]any) <-chan ElicitationCreateRequest {
	t.Helper()
	asked := make(chan ElicitationCreateRequest, 4)
	c.onReq = func(method string, params json.RawMessage) any {
		if method != ReqElicitationCreate {
			t.Errorf("unexpected agent request %s", method)
			return nil
		}
		var req ElicitationCreateRequest
		if err := json.Unmarshal(params, &req); err != nil {
			t.Errorf("decode elicitation: %v", err)
		}
		asked <- req
		if content == nil {
			return ElicitationCreateResponse{Action: "cancel"}
		}
		return ElicitationCreateResponse{Action: "accept", Content: content}
	}
	c.initialize(ClientCapabilities{Elicitation: &ElicitationCapabilities{Form: json.RawMessage(`{}`)}, Session: &ClientSessionCapabilities{Notices: json.RawMessage(`{}`)}})
	return asked
}

func openSession(t *testing.T, f *fakeEngine, c *acpClient, epoch int64) string {
	t.Helper()
	res := c.newSession("/w")
	f.waitCmd("start_session")
	f.emit(res.SessionID, statusAt("idle", epoch))
	f.emit(res.SessionID, map[string]any{"type": "engine_command_registry", "commands": []map[string]any{}})
	c.next(UpdateAvailableCommands)
	return res.SessionID
}

// A question the model asks reaches the client as a form, the answer goes
// back as the next prompt inside the same turn, and the turn ends on the
// run the answer starts. A repeated snapshot never asks twice.
func TestQuestionBecomesAFormAndTheAnswerContinuesTheTurn(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	asked := formClient(t, c, map[string]any{"q1": "Blue"})
	key := openSession(t, f, c, 1)

	done := c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "pick"}}})
	f.waitCmd("send_prompt")
	f.emit(key, statusAt("running", 2))
	denials := []map[string]any{questionDenial("tu_1", "Which color?", "Red", "Blue")}
	f.emit(key, snapshot("idle", 2, map[string]any{"permissionDenials": denials, "completionReason": "normal"}))

	req := <-asked
	props := req.RequestedSchema["properties"].(map[string]any)
	q1 := props["q1"].(map[string]any)
	if req.Mode != "form" || req.Message != "Which color?" || q1["description"] != "Which color?" || q1["title"] != "Question" {
		t.Fatalf("form = %+v", req)
	}
	if enum, _ := q1["enum"].([]any); len(enum) != 2 || enum[1] != "Blue" {
		t.Fatalf("options = %v", q1["enum"])
	}
	answer := f.waitCmd("send_prompt")
	if answer["text"] != "Blue" || answer["injectionKind"] != "structured_answer" {
		t.Fatalf("answer prompt = %v", answer)
	}
	assertPending(t, done)
	// A heartbeat that still carries the answered denial is not a new ask.
	f.emit(key, snapshot("idle", 2, map[string]any{"permissionDenials": denials}))
	assertPending(t, done)
	select {
	case again := <-asked:
		t.Fatalf("asked twice: %+v", again)
	case <-time.After(100 * time.Millisecond):
	}
	f.emit(key, statusAt("running", 3))
	f.emit(key, snapshot("idle", 3, map[string]any{"completionReason": "normal"}))
	if r := assertEnded(t, done); r.err != "" || r.StopReason != StopEndTurn {
		t.Fatalf("turn = %+v", r)
	}
}

// Several questions are one form; the answers come back labelled.
func TestQuestionBatchAnswersAreLabelled(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	formClient(t, c, map[string]any{"q1": "Blue", "q2": "Large"})
	key := openSession(t, f, c, 1)
	done := c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "pick"}}})
	f.waitCmd("send_prompt")
	f.emit(key, statusAt("running", 2))
	batch := map[string]any{"toolName": "AskUserQuestions", "toolUseId": "tu_2", "toolInput": map[string]any{"questions": []map[string]any{
		{"header": "Color", "question": "Which color?", "options": []map[string]any{{"label": "Red"}, {"label": "Blue"}}},
		{"header": "Size", "question": "Which size?"},
	}}}
	f.emit(key, snapshot("idle", 2, map[string]any{"permissionDenials": []map[string]any{batch}}))
	answer := f.waitCmd("send_prompt")
	if answer["text"] != "Q: Which color?\nA: Blue\n\nQ: Which size?\nA: Large" {
		t.Fatalf("answer prompt = %q", answer["text"])
	}
	f.emit(key, statusAt("running", 3))
	f.emit(key, snapshot("idle", 3, nil))
	assertEnded(t, done)
}

// A client without forms gets the question as text and the turn ends, so
// the person answers in the prompt box; a cancelled form does the same.
func TestQuestionFallsBackToTextWithoutForms(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	key := openSession(t, f, c, 1)
	done := c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "pick"}}})
	f.waitCmd("send_prompt")
	f.emit(key, statusAt("running", 2))
	f.emit(key, snapshot("idle", 2, map[string]any{"permissionDenials": []map[string]any{questionDenial("tu_1", "Which color?", "Red", "Blue")}}))
	if u := c.next(UpdateAgentMessageChunk); !strings.Contains(u.Content.Text, "Which color? (Red / Blue)") {
		t.Fatalf("question text = %+v", u)
	}
	if r := assertEnded(t, done); r.StopReason != StopEndTurn {
		t.Fatalf("turn = %+v", r)
	}

	f2 := newFakeEngine(t)
	defer f2.close()
	_, c2 := startAgent(t, f2, Options{})
	formClient(t, c2, nil)
	key2 := openSession(t, f2, c2, 1)
	done2 := c2.sendPrompt(PromptRequest{SessionID: key2, Prompt: []ContentBlock{{Type: "text", Text: "pick"}}})
	f2.waitCmd("send_prompt")
	f2.emit(key2, statusAt("running", 2))
	f2.emit(key2, snapshot("idle", 2, map[string]any{"permissionDenials": []map[string]any{questionDenial("tu_1", "Which color?")}}))
	if u := c2.next(UpdateAgentMessageChunk); !strings.Contains(u.Content.Text, "Which color?") {
		t.Fatalf("question text = %+v", u)
	}
	assertEnded(t, done2)
}

// An idle that still owes the turn a run (background commands the engine
// parked on, agents working) keeps the turn open; the run the engine
// resumes with ends it. Cancelling a held turn ends it at once.
func TestIdleWithPendingWorkHoldsTheTurn(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	key := openSession(t, f, c, 1)
	done := c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "build"}}})
	f.waitCmd("send_prompt")
	f.emit(key, statusAt("running", 2))
	// The completion idle without an epoch is not the settlement signal.
	f.emit(key, idle("normal"))
	assertPending(t, done)
	f.emit(key, snapshot("idle", 2, map[string]any{"hasPendingWork": true, "backgroundShells": 1}))
	assertPending(t, done)
	f.emit(key, statusAt("running", 3))
	f.emit(key, map[string]any{"type": "engine_text_delta", "text": "The build passed."})
	f.emit(key, snapshot("idle", 3, map[string]any{"completionReason": "normal"}))
	if u := c.next(UpdateAgentMessageChunk); u.Content.Text != "The build passed." {
		t.Fatalf("wake text = %+v", u)
	}
	if r := assertEnded(t, done); r.StopReason != StopEndTurn {
		t.Fatalf("turn = %+v", r)
	}

	done = c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "again"}}})
	f.waitCmd("send_prompt")
	f.emit(key, statusAt("running", 4))
	f.emit(key, snapshot("idle", 4, map[string]any{"hasPendingWork": true, "backgroundAgents": 2}))
	assertPending(t, done)
	c.notify(MethodSessionCancel, CancelNotification{SessionID: key})
	f.waitCmd("abort")
	if r := assertEnded(t, done); r.StopReason != StopCancelled {
		t.Fatalf("cancelled held turn = %+v", r)
	}
}

// The engine reports a parked session's work gone the moment a command
// finishes, then starts the run that delivers it. A held turn survives that
// gap and ends on the delivering run's idle; with no run coming, it ends
// once the grace window passes.
func TestHeldTurnSurvivesTheGapBeforeTheWakeRun(t *testing.T) {
	prev := heldTurnGrace
	heldTurnGrace = 200 * time.Millisecond
	defer func() { heldTurnGrace = prev }()
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	key := openSession(t, f, c, 1)
	done := c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "build"}}})
	f.waitCmd("send_prompt")
	f.emit(key, statusAt("running", 2))
	f.emit(key, snapshot("idle", 2, map[string]any{"hasPendingWork": true, "backgroundShells": 1}))
	assertPending(t, done)
	f.emit(key, snapshot("idle", 2, nil))
	assertPending(t, done)
	f.emit(key, statusAt("running", 3))
	time.Sleep(300 * time.Millisecond)
	assertPending(t, done)
	f.emit(key, map[string]any{"type": "engine_text_delta", "text": "Finished."})
	f.emit(key, snapshot("idle", 3, map[string]any{"completionReason": "normal"}))
	if u := c.next(UpdateAgentMessageChunk); u.Content.Text != "Finished." {
		t.Fatalf("wake text = %+v", u)
	}
	if r := assertEnded(t, done); r.StopReason != StopEndTurn {
		t.Fatalf("turn = %+v", r)
	}

	done = c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "again"}}})
	f.waitCmd("send_prompt")
	f.emit(key, statusAt("running", 4))
	f.emit(key, snapshot("idle", 4, map[string]any{"hasPendingWork": true, "backgroundShells": 1}))
	f.emit(key, snapshot("idle", 4, nil))
	assertPending(t, done)
	if r := assertEnded(t, done); r.StopReason != StopEndTurn {
		t.Fatalf("released held turn = %+v", r)
	}
}

// A plan the model proposes is shown as a plan, offered for approval, and
// on approval the session leaves plan mode and the turn continues with the
// go-ahead; a refusal ends the turn still in plan mode.
func TestPlanProposalAsksForApproval(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	planPath := filepath.Join(t.TempDir(), "bold-fix.md")
	if err := os.WriteFile(planPath, []byte("# Plan\n\n1. Fix it."), 0o600); err != nil {
		t.Fatal(err)
	}
	decisions := make(chan string, 2)
	asked := make(chan RequestPermissionRequest, 2)
	c.onReq = func(method string, params json.RawMessage) any {
		var req RequestPermissionRequest
		if err := json.Unmarshal(params, &req); err != nil || method != ReqRequestPermission {
			t.Errorf("request = %s %s", method, params)
		}
		asked <- req
		return RequestPermissionResponse{Outcome: PermissionOutcome{Outcome: "selected", OptionID: <-decisions}}
	}
	c.initialize(ClientCapabilities{Session: &ClientSessionCapabilities{Notices: json.RawMessage(`{}`)}})
	key := openSession(t, f, c, 1)

	decisions <- planOptionImplement
	done := c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "plan it"}}})
	f.waitCmd("send_prompt")
	f.emit(key, statusAt("running", 2))
	f.emit(key, map[string]any{"type": "engine_plan_proposal", "planProposalKind": "exit", "planFilePath": planPath, "planSlug": "bold-fix"})
	if u := c.next(UpdatePlanUpdate); u.Plan == nil || u.Plan.PlanID != "bold-fix" || u.Plan.Type != "markdown" || !strings.Contains(u.Plan.Content, "Fix it") {
		t.Fatalf("plan update = %+v", u)
	}
	req := <-asked
	if req.ToolCall.Kind != "switch_mode" || len(req.Options) != 2 || req.Options[0].Kind != "allow_once" || len(req.ToolCall.Content) != 1 || req.ToolCall.Locations[0].Path != planPath {
		t.Fatalf("approval request = %+v", req)
	}
	mode := f.waitCmd("set_plan_mode")
	if mode["enabled"] != false {
		t.Fatalf("set_plan_mode = %v", mode)
	}
	if u := c.next(UpdateCurrentMode); u.CurrentModeID != ModeBuild {
		t.Fatalf("mode = %+v", u)
	}
	goAhead := f.waitCmd("send_prompt")
	if goAhead["text"] != planApprovedPrompt {
		t.Fatalf("go-ahead = %v", goAhead)
	}
	f.emit(key, snapshot("idle", 2, map[string]any{"permissionDenials": []map[string]any{{"toolName": "ExitPlanMode", "toolUseId": "tu_9"}}}))
	assertPending(t, done)
	f.emit(key, statusAt("running", 3))
	f.emit(key, snapshot("idle", 3, nil))
	assertEnded(t, done)

	decisions <- planOptionKeep
	done = c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "plan more"}}})
	f.waitCmd("send_prompt")
	f.emit(key, statusAt("running", 4))
	f.emit(key, map[string]any{"type": "engine_plan_proposal", "planProposalKind": "exit", "planFilePath": planPath, "planSlug": "bold-fix"})
	<-asked
	if u := c.next(UpdateNotice); !strings.Contains(u.Title, "not approved") {
		t.Fatalf("refusal notice = %+v", u)
	}
	if r := assertEnded(t, done); r.StopReason != StopEndTurn {
		t.Fatalf("refused turn = %+v", r)
	}
}

// Tool cards carry what a client renders natively: a diff for an edit, the
// files a call touches, a plan for a TodoWrite, and the server and tool of
// an MCP call.
func TestToolInputWithoutAnIDFillsTheNewestCard(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	key := openSession(t, f, c, 1)

	f.emit(key, map[string]any{"type": "engine_tool_start", "toolName": "Bash", "toolId": "b1"})
	f.emit(key, map[string]any{"type": "engine_tool_update", "toolId": "", "partialInput": `{"command":"ls`})
	f.emit(key, map[string]any{"type": "engine_tool_update", "toolId": "", "partialInput": ` -la"}`})
	c.next(UpdateToolCall)
	if u := c.next(UpdateToolCallUpdate); u.ToolCallID != "b1" || u.Title != "ls -la" || string(u.RawInput) != `{"command":"ls -la"}` {
		t.Fatalf("bash card = %+v", u)
	}
	f.emit(key, map[string]any{"type": "engine_tool_end", "toolId": "b1", "result": "total 0"})
	if u := c.next(UpdateToolCallUpdate); u.Status != "completed" {
		t.Fatalf("bash end = %+v", u)
	}
}

func TestToolCardsDescribeTheirInput(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	key := openSession(t, f, c, 1)

	f.emit(key, map[string]any{"type": "engine_tool_start", "toolName": "Edit", "toolId": "e1"})
	f.emit(key, map[string]any{"type": "engine_tool_update", "toolId": "e1", "partialInput": `{"file_path":"/w/src/a.go","old_string":"x := 1","new_string":"x := 2"}`})
	c.next(UpdateToolCall)
	edit := c.next(UpdateToolCallUpdate)
	if edit.Title != "Edit src/a.go" || len(edit.Locations) != 1 || edit.Locations[0].Path != "/w/src/a.go" {
		t.Fatalf("edit card = %+v", edit)
	}
	if len(edit.ToolContent) != 1 || edit.ToolContent[0].Type != "diff" || *edit.ToolContent[0].OldText != "x := 1" || *edit.ToolContent[0].NewText != "x := 2" {
		t.Fatalf("edit diff = %+v", edit.ToolContent)
	}
	f.emit(key, map[string]any{"type": "engine_tool_end", "toolId": "e1", "result": "ok"})
	end := c.next(UpdateToolCallUpdate)
	raw, _ := json.Marshal(end)
	if end.Status != "completed" || !strings.Contains(string(raw), `"type":"diff"`) || !strings.Contains(string(raw), `"text":"ok"`) {
		t.Fatalf("edit end = %s", raw)
	}

	f.emit(key, map[string]any{"type": "engine_tool_start", "toolName": "Write", "toolId": "w1"})
	f.emit(key, map[string]any{"type": "engine_tool_update", "toolId": "w1", "partialInput": `{"file_path":"/w/b.txt","content":"hello"}`})
	c.next(UpdateToolCall)
	if u := c.next(UpdateToolCallUpdate); u.Title != "Write b.txt" || u.ToolContent[0].OldText != nil || *u.ToolContent[0].NewText != "hello" {
		t.Fatalf("write card = %+v", u)
	}

	f.emit(key, map[string]any{"type": "engine_tool_start", "toolName": "mcp__ion-extensions__TodoWrite", "toolId": "td"})
	f.emit(key, map[string]any{"type": "engine_tool_update", "toolId": "td", "partialInput": `{"todos":[{"content":"one","status":"completed"},{"content":"two","status":"pending"}]}`})
	if u := c.next(UpdateToolCall); u.Kind != "think" {
		t.Fatalf("todo card = %+v", u)
	}
	if u := c.next(UpdatePlan); len(u.Entries) != 2 || u.Entries[0].Status != "completed" || u.Entries[1].Content != "two" {
		t.Fatalf("plan = %+v", u)
	}

	f.emit(key, map[string]any{"type": "engine_tool_start", "toolName": "mcp__t3-code__delegate_task", "toolId": "m1"})
	f.emit(key, map[string]any{"type": "engine_tool_update", "toolId": "m1", "partialInput": `{"prompt":"review the diff"}`})
	c.next(UpdateToolCall)
	if u := c.next(UpdateToolCallUpdate); u.Title != "t3-code: delegate_task: review the diff" || u.Meta["claudeCode"].(map[string]any)["toolName"] != "mcp__t3-code__delegate_task" {
		t.Fatalf("mcp card = %+v", u)
	}
}

// A dispatched agent is a tool call whose content is the child's transcript
// as it streams, closed with its outcome.
func TestDispatchesBecomeToolCalls(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	key := openSession(t, f, c, 1)
	f.emit(key, map[string]any{"type": "engine_dispatch_start", "dispatchId": "d1", "dispatchAgent": "reviewer", "dispatchTask": "Review the diff\nin detail"})
	start := c.next(UpdateToolCall)
	if start.ToolCallID != "dispatch:d1" || start.Title != "Agent reviewer: Review the diff" || start.Kind != "think" || start.Status != "in_progress" {
		t.Fatalf("dispatch card = %+v", start)
	}
	f.emit(key, map[string]any{"type": "engine_dispatch_activity", "dispatchAgentId": "d1", "dispatchActivityKind": "tool_start", "toolName": "mcp__ion-extensions__Read"})
	f.emit(key, map[string]any{"type": "engine_dispatch_activity", "dispatchAgentId": "d1", "dispatchActivityKind": "text", "dispatchTextDelta": "Looks fine."})
	c.next(UpdateToolCallUpdate)
	if u := c.next(UpdateToolCallUpdate); u.ToolContent[0].Content.Text != "\n▸ Read\nLooks fine." {
		t.Fatalf("activity = %q", u.ToolContent[0].Content.Text)
	}
	f.emit(key, map[string]any{"type": "engine_dispatch_end", "dispatchId": "d1", "dispatchExitCode": 0, "dispatchElapsed": 12.0, "dispatchToolCount": 3, "dispatchCost": 0.01})
	if u := c.next(UpdateToolCallUpdate); u.Status != "completed" || !strings.Contains(u.ToolContent[0].Content.Text, "3 tool calls") {
		t.Fatalf("dispatch end = %+v", u)
	}
}

// The MCP servers a client brings on session/new reach the engine on
// start_session, in the engine's own server shape, and again on reopen.
func TestSessionNewPassesClientMcpServers(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	init := c.initialize(ClientCapabilities{})
	if !init.AgentCapabilities.McpCapabilities["http"] {
		t.Fatalf("mcp capabilities = %v", init.AgentCapabilities.McpCapabilities)
	}
	var res SessionResponse
	if msg := c.call(MethodSessionNew, NewSessionRequest{Cwd: "/w", McpServers: []McpServerSpec{
		{Name: "t3-code", Command: "/app/t3", Args: []string{"acp-mcp-bridge"}, Env: []NamedVar{{Name: "T3_ACP_MCP_ENDPOINT", Value: "http://127.0.0.1:1/mcp"}}},
		{Name: "docs", Type: "http", URL: "https://docs.example/mcp", Headers: []NamedVar{{Name: "Authorization", Value: "Bearer x"}}},
		{Name: "", Command: "ignored"},
	}}, &res); msg != "" {
		t.Fatal(msg)
	}
	start := f.waitCmd("start_session")
	servers := start["config"].(map[string]any)["mcpServers"].(map[string]any)
	t3 := servers["t3-code"].(map[string]any)
	if len(servers) != 2 || t3["type"] != "stdio" || t3["command"] != "/app/t3" || t3["env"].(map[string]any)["T3_ACP_MCP_ENDPOINT"] != "http://127.0.0.1:1/mcp" {
		t.Fatalf("mcpServers = %v", servers)
	}
	if docs := servers["docs"].(map[string]any); docs["type"] != "http" || docs["url"] != "https://docs.example/mcp" || docs["headers"].(map[string]any)["Authorization"] != "Bearer x" {
		t.Fatalf("docs server = %v", servers["docs"])
	}
}

// History loads by the conversation the key is bound to, and every replayed
// update is marked as replay.
func TestHistoryLoadsByConversationAndIsMarkedReplay(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	f.conversationID = "1793315415928-ff738dc57677"
	f.history = []map[string]any{{"role": "user", "content": "first"}}
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	if msg := c.call(MethodSessionLoad, LoadSessionRequest{SessionID: "acp-0022", Cwd: "/w"}, nil); msg != "" {
		t.Fatal(msg)
	}
	f.waitCmd("start_session")
	load := f.waitCmd("load_session_history")
	if ids, _ := load["sessionIds"].([]any); len(ids) != 1 || ids[0] != f.conversationID {
		t.Fatalf("load_session_history = %v", load)
	}
	select {
	case n := <-c.notes:
		if n.Meta["isReplay"] != true || n.Update.SessionUpdate != UpdateUserMessageChunk {
			t.Fatalf("replayed update = %+v", n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no replay arrived")
	}
}

// Engine signals with no ACP shape of their own reach the client: a declined
// capability ends the turn, a machine-authored turn and a finished
// background command are notices, a compaction is a compaction update.
func TestEngineSignalsReachTheClient(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{Session: &ClientSessionCapabilities{Notices: json.RawMessage(`{}`)}})
	key := openSession(t, f, c, 1)
	done := c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "plan"}}})
	f.waitCmd("send_prompt")
	f.emit(key, map[string]any{"type": "engine_capability_unsupported", "capability": "plan mode", "capabilityBackend": "codex", "capabilityReason": "no plan tool"})
	if u := c.next(UpdateNotice); u.Severity != "error" || !strings.Contains(u.Title, "plan mode") {
		t.Fatalf("notice = %+v", u)
	}
	if r := assertEnded(t, done); r.StopReason != StopEndTurn {
		t.Fatalf("turn = %+v", r)
	}
	f.emit(key, map[string]any{"type": "engine_prompt_injected", "injectedPrompt": "Task 7 finished: ok", "injectedPromptKind": "background_task_completion", "injectedPromptMachineAuthored": true})
	if u := c.next(UpdateNotice); !strings.Contains(u.Title, "background command finished") || u.Description != "Task 7 finished: ok" {
		t.Fatalf("injected notice = %+v", u)
	}
	f.emit(key, map[string]any{"type": "engine_prompt_injected", "injectedPrompt": "from the phone", "injectedPromptOrigin": "relay"})
	if u := c.next(UpdateUserMessageChunk); u.Content.Text != "from the phone" {
		t.Fatalf("injected user turn = %+v", u)
	}
	f.emit(key, map[string]any{"type": "engine_background_task_complete", "backgroundTaskComplete": map[string]any{"taskId": "t7", "status": "completed", "exitCode": 0, "command": "make test", "tail": []string{"ok"}}})
	if u := c.next(UpdateNotice); u.Title != "Background command completed (exit 0)" || u.Description != "$ make test\nok" {
		t.Fatalf("background notice = %+v", u)
	}
	f.emit(key, map[string]any{"type": "engine_compacting", "active": true})
	if u := c.next(UpdateCompaction); u.Status != "in_progress" || u.CompactionID == "" {
		t.Fatalf("compaction start = %+v", u)
	}
	f.emit(key, map[string]any{"type": "engine_compacting", "active": false, "messagesBefore": 40, "messagesAfter": 6, "summary": "We fixed the build."})
	if u := c.next(UpdateCompaction); u.Status != "completed" || !strings.Contains(u.Summary[0].Text, "Compacted 40 messages to 6") {
		t.Fatalf("compaction end = %+v", u)
	}
}
