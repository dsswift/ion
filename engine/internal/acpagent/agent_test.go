package acpagent

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

var testProfiles = []Profile{
	{ID: "p-cos", Name: "cos2", Extensions: []string{"/ext/cos2/main"}},
	{ID: "p-jar", Name: "jarvis", Extensions: []string{"/ext/jarvis/main"}},
}

func idle(reason string) map[string]any {
	fields := map[string]any{"state": "idle", "contextWindow": 200000, "contextTokens": 1200, "conversationCostUsd": 0.5}
	if reason != "" {
		fields["completionReason"] = reason
	}
	return map[string]any{"type": "engine_status", "fields": fields}
}

func TestInitializeAdvertisesTheAgent(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{Version: "test-1"})
	res := c.initialize(ClientCapabilities{})
	if res.ProtocolVersion != 1 || !res.AgentCapabilities.LoadSession || res.AgentInfo.Name != "ion" || res.AgentInfo.Version != "test-1" {
		t.Fatalf("initialize = %+v", res)
	}
	if !res.AgentCapabilities.PromptCapabilities.Image {
		t.Fatal("image prompts should be advertised")
	}
}

func TestSessionNewStartsAnEngineSessionWithTheProfile(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	f.models = []map[string]any{{"id": "m-1", "displayName": "Model One", "providerId": "anthropic"}}
	_, c := startAgent(t, f, Options{Profile: "cos2", Profiles: testProfiles, DefaultModel: "m-1"})
	c.initialize(ClientCapabilities{})
	res := c.newSession("/work/dir")

	start := f.waitCmd("start_session")
	if !strings.HasPrefix(res.SessionID, "acp-") || start["key"] != res.SessionID {
		t.Fatalf("session id %q, start key %v", res.SessionID, start["key"])
	}
	cfg := start["config"].(map[string]any)
	if cfg["workingDirectory"] != "/work/dir" || cfg["profileId"] != "p-cos" || cfg["forceNewConversation"] != true {
		t.Fatalf("start config = %v", cfg)
	}
	if exts, _ := cfg["extensions"].([]any); len(exts) != 1 || exts[0] != "/ext/cos2/main" {
		t.Fatalf("extensions = %v", cfg["extensions"])
	}
	if res.Modes == nil || res.Modes.CurrentModeID != ModeBuild || len(res.Modes.AvailableModes) != 2 {
		t.Fatalf("modes = %+v", res.Modes)
	}
	byID := map[string]ConfigOption{}
	for _, o := range res.ConfigOptions {
		byID[o.ID] = o
	}
	if byID[ConfigProfile].CurrentValue != "p-cos" || len(byID[ConfigProfile].Options) != 3 {
		t.Fatalf("profile option = %+v", byID[ConfigProfile])
	}
	if byID[ConfigModel].CurrentValue != "m-1" || byID[ConfigModel].Category != "model" || byID[ConfigModel].Options[0].Name != "Model One" {
		t.Fatalf("model option = %+v", byID[ConfigModel])
	}
}

func TestPromptStreamsTheRunAndEndsOnIdle(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	res := c.newSession("/w")
	f.waitCmd("start_session")
	key := res.SessionID

	done := c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "hello"}, {Type: "image", Data: "AAA=", MimeType: "image/png"}}})
	sent := f.waitCmd("send_prompt")
	if sent["text"] != "hello" {
		t.Fatalf("send_prompt text = %v", sent["text"])
	}
	if atts, _ := sent["attachments"].([]any); len(atts) != 1 {
		t.Fatalf("attachments = %v", sent["attachments"])
	}

	f.emit(key, map[string]any{"type": "engine_text_delta", "text": "Hi "})
	f.emit(key, map[string]any{"type": "engine_thinking_delta", "thinkingText": "hmm"})
	f.emit(key, map[string]any{"type": "engine_tool_start", "toolName": "Bash", "toolId": "t1"})
	f.emit(key, map[string]any{"type": "engine_tool_update", "toolId": "t1", "partialInput": `{"command":"ls`})
	f.emit(key, map[string]any{"type": "engine_tool_update", "toolId": "t1", "partialInput": ` -la"}`})
	f.emit(key, map[string]any{"type": "engine_tool_end", "toolId": "t1", "toolName": "Bash", "result": "a.txt", "isError": false})
	f.emit(key, map[string]any{"type": "engine_command_registry", "commands": []map[string]any{{"name": "brief", "description": "Briefing"}}})
	f.emit(key, map[string]any{"type": "engine_message_end", "contextTokens": 1000, "contextWindow": 200000})
	f.emit(key, idle("normal"))

	if u := c.next(UpdateAgentMessageChunk); u.Content == nil || u.Content.Text != "Hi " {
		t.Fatalf("message chunk = %+v", u)
	}
	if u := c.next(UpdateAgentThoughtChunk); u.Content == nil || u.Content.Text != "hmm" {
		t.Fatalf("thought chunk = %+v", u)
	}
	if u := c.next(UpdateToolCall); u.ToolCallID != "t1" || u.Kind != "execute" || u.Status != "in_progress" {
		t.Fatalf("tool_call = %+v", u)
	}
	// The input completes before the tool ends: the client learns the
	// command while the tool still runs, then the result closes the card.
	described := c.next(UpdateToolCallUpdate)
	if described.Status != "" || described.Title != "ls -la" || string(described.RawInput) != `{"command":"ls -la"}` || described.Meta["claudeCode"].(map[string]any)["toolName"] != "Bash" {
		t.Fatalf("described tool_call_update = %+v raw=%s", described, described.RawInput)
	}
	end := c.next(UpdateToolCallUpdate)
	if end.Status != "completed" || end.ToolCallID != "t1" {
		t.Fatalf("tool_call_update = %+v raw=%s", end, end.RawInput)
	}
	raw, _ := json.Marshal(end)
	if !strings.Contains(string(raw), `"content":[{"type":"content","content":{"type":"text","text":"a.txt"}}]`) {
		t.Fatalf("tool content wire shape = %s", raw)
	}
	if u := c.next(UpdateAvailableCommands); len(u.AvailableCommands) != 1 || u.AvailableCommands[0].Name != "brief" {
		t.Fatalf("available commands = %+v", u)
	}
	if u := c.next(UpdateUsage); u.Used == nil || *u.Used != 1000 || u.Size == nil || *u.Size != 200000 {
		t.Fatalf("usage = %+v", u)
	}
	select {
	case pr := <-done:
		if pr.err != "" || pr.StopReason != StopEndTurn {
			t.Fatalf("prompt = %+v", pr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("prompt never returned")
	}
}

func TestSlashCommandDispatchesAsACommand(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	res := c.newSession("/w")
	f.waitCmd("start_session")
	key := res.SessionID
	f.emit(key, map[string]any{"type": "engine_command_registry", "commands": []map[string]any{{"name": "brief", "description": "Briefing"}}})
	c.next(UpdateAvailableCommands)

	go c.send(MethodSessionPrompt, PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "/brief today please"}}})
	cmd := f.waitCmd("command")
	if cmd["command"] != "brief" || cmd["args"] != "today please" {
		t.Fatalf("command = %v", cmd)
	}
	f.emit(key, idle("normal"))
}

func TestCancelAbortsAndReportsCancelled(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	res := c.newSession("/w")
	f.waitCmd("start_session")
	key := res.SessionID
	done := c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "go"}}})
	f.waitCmd("send_prompt")
	c.notify(MethodSessionCancel, CancelNotification{SessionID: key})
	f.waitCmd("abort")
	f.emit(key, idle("aborted"))
	if pr := <-done; pr.StopReason != StopCancelled {
		t.Fatalf("prompt = %+v", pr)
	}
}

func TestEngineErrorFailsThePrompt(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	res := c.newSession("/w")
	f.waitCmd("start_session")
	key := res.SessionID
	errCh := make(chan string, 1)
	go func() {
		errCh <- c.call(MethodSessionPrompt, PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "go"}}}, nil)
	}()
	f.waitCmd("send_prompt")
	f.emit(key, map[string]any{"type": "engine_error", "message": "no model configured", "errorCode": "no_model"})
	if msg := <-errCh; !strings.Contains(msg, "no model configured") {
		t.Fatalf("prompt error = %q", msg)
	}
}

func TestPermissionRoundTrip(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	asked := make(chan RequestPermissionRequest, 1)
	c.onReq = func(method string, params json.RawMessage) any {
		if method != ReqRequestPermission {
			t.Errorf("unexpected agent request %s", method)
			return nil
		}
		var req RequestPermissionRequest
		if err := json.Unmarshal(params, &req); err != nil {
			t.Errorf("decode permission: %v", err)
		}
		asked <- req
		return RequestPermissionResponse{Outcome: PermissionOutcome{Outcome: "selected", OptionID: "allow-session"}}
	}
	c.initialize(ClientCapabilities{})
	res := c.newSession("/w")
	f.waitCmd("start_session")
	key := res.SessionID
	f.emit(key, map[string]any{"type": "engine_permission_request", "questionId": "q1", "permToolName": "Bash",
		"permToolInput": map[string]any{"command": "rm -rf build"},
		"permOptions":   []map[string]any{{"id": "allow", "label": "Allow once"}, {"id": "allow-session", "label": "Allow for this session"}, {"id": "deny", "label": "Deny"}}})
	req := <-asked
	if req.SessionID != key || req.ToolCall.ToolCallID != "q1" || req.ToolCall.Title != "rm -rf build" || req.ToolCall.Kind != "execute" {
		t.Fatalf("permission request = %+v", req)
	}
	kinds := map[string]string{}
	for _, o := range req.Options {
		kinds[o.OptionID] = o.Kind
	}
	if kinds["allow"] != "allow_once" || kinds["allow-session"] != "allow_always" || kinds["deny"] != "reject_once" {
		t.Fatalf("option kinds = %v", kinds)
	}
	answer := f.waitCmd("permission_response")
	if answer["questionId"] != "q1" || answer["optionId"] != "allow-session" {
		t.Fatalf("permission_response = %v", answer)
	}
}

func TestElicitationBecomesAForm(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.onReq = func(method string, params json.RawMessage) any {
		var req ElicitationCreateRequest
		if err := json.Unmarshal(params, &req); err != nil || req.Mode != "form" || req.RequestedSchema["type"] != "object" {
			t.Errorf("elicitation request = %s (%v)", params, err)
		}
		return ElicitationCreateResponse{Action: "accept", Content: map[string]any{"name": "Ada"}}
	}
	c.initialize(ClientCapabilities{Elicitation: &ElicitationCapabilities{Form: json.RawMessage(`{}`)}})
	res := c.newSession("/w")
	f.waitCmd("start_session")
	key := res.SessionID
	f.emit(key, map[string]any{"type": "engine_elicitation_request", "requestId": "e1", "elicitMessage": "Who?", "schema": map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string"}}}})
	answer := f.waitCmd("elicitation_response")
	if answer["elicitRequestId"] != "e1" || answer["elicitResponse"].(map[string]any)["name"] != "Ada" || answer["elicitCancelled"] != nil {
		t.Fatalf("elicitation_response = %v", answer)
	}
}

func TestElicitationIsCancelledWhenTheClientHasNoForms(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	res := c.newSession("/w")
	f.waitCmd("start_session")
	key := res.SessionID
	f.emit(key, map[string]any{"type": "engine_elicitation_request", "requestId": "e1", "elicitMessage": "Who?", "schema": map[string]any{"type": "object"}})
	answer := f.waitCmd("elicitation_response")
	if answer["elicitCancelled"] != true {
		t.Fatalf("elicitation_response = %v", answer)
	}
	if u := c.next(UpdateAgentMessageChunk); !strings.Contains(u.Content.Text, "cannot show the form") {
		t.Fatalf("fallback notice = %+v", u)
	}
}

func TestSetModeTogglesPlanMode(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	res := c.newSession("/w")
	f.waitCmd("start_session")
	key := res.SessionID
	if msg := c.call(MethodSessionSetMode, SetSessionModeRequest{SessionID: key, ModeID: ModePlan}, nil); msg != "" {
		t.Fatal(msg)
	}
	cmd := f.waitCmd("set_plan_mode")
	if cmd["enabled"] != true {
		t.Fatalf("set_plan_mode = %v", cmd)
	}
	f.emit(key, map[string]any{"type": "engine_plan_mode_changed", "planModeEnabled": true})
	if u := c.next(UpdateCurrentMode); u.CurrentModeID != ModePlan {
		t.Fatalf("mode update = %+v", u)
	}
	if msg := c.call(MethodSessionSetMode, SetSessionModeRequest{SessionID: key, ModeID: "architect"}, nil); msg == "" {
		t.Fatal("unknown mode should fail")
	}
}

func TestSetConfigOptionProfileRestartsTheSession(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{Profile: "cos2", Profiles: testProfiles})
	c.initialize(ClientCapabilities{})
	res := c.newSession("/w")
	f.waitCmd("start_session")
	key := res.SessionID
	var out SetConfigOptionResponse
	if msg := c.call(MethodSessionSetConfigOption, SetConfigOptionRequest{SessionID: key, ConfigID: ConfigProfile, Value: json.RawMessage(`"jarvis"`)}, &out); msg != "" {
		t.Fatal(msg)
	}
	stop := f.waitCmd("stop_session")
	start := f.waitCmd("start_session")
	cfg := start["config"].(map[string]any)
	if stop["key"] != key || start["key"] != key || cfg["profileId"] != "p-jar" || cfg["forceNewConversation"] != nil {
		t.Fatalf("restart: stop=%v start=%v", stop, start)
	}
	for _, o := range out.ConfigOptions {
		if o.ID == ConfigProfile && o.CurrentValue != "p-jar" {
			t.Fatalf("profile option after switch = %+v", o)
		}
	}
	if u := c.next(UpdateConfigOption); len(u.ConfigOptions) != 2 {
		t.Fatalf("config option update = %+v", u)
	}

	if msg := c.call(MethodSessionSetConfigOption, SetConfigOptionRequest{SessionID: key, ConfigID: ConfigModel, Value: json.RawMessage(`"m-9"`)}, nil); msg != "" {
		t.Fatal(msg)
	}
	go c.send(MethodSessionPrompt, PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "x"}}})
	if sent := f.waitCmd("send_prompt"); sent["model"] != "m-9" {
		t.Fatalf("send_prompt model = %v", sent["model"])
	}
	f.emit(key, idle("normal"))
}

func TestSessionLoadResumesAndReplaysHistory(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	f.history = []map[string]any{
		{"role": "user", "content": "first"},
		{"role": "tool", "toolName": "Read", "toolId": "r1", "toolInput": `{"file_path":"/a.go"}`, "content": "package a"},
		{"role": "assistant", "content": "done"},
		{"role": "user", "content": "hidden", "internal": true},
	}
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	var res SessionResponse
	if msg := c.call(MethodSessionLoad, LoadSessionRequest{SessionID: "acp-0011", Cwd: "/w"}, &res); msg != "" {
		t.Fatal(msg)
	}
	start := f.waitCmd("start_session")
	if start["key"] != "acp-0011" || start["config"].(map[string]any)["forceNewConversation"] != nil {
		t.Fatalf("load start = %v", start)
	}
	if u := c.next(UpdateUserMessageChunk); u.Content.Text != "first" {
		t.Fatalf("user chunk = %+v", u)
	}
	if u := c.next(UpdateToolCall); u.ToolCallID != "r1" || u.Kind != "read" || u.Title != "Read /a.go" || u.Status != "completed" || len(u.Locations) != 1 || u.Locations[0].Path != "/a.go" {
		t.Fatalf("replayed tool call = %+v", u)
	}
	if u := c.next(UpdateAgentMessageChunk); u.Content.Text != "done" {
		t.Fatalf("assistant chunk = %+v", u)
	}
	select {
	case n := <-c.notes:
		t.Fatalf("internal row leaked: %+v", n)
	case <-time.After(200 * time.Millisecond):
	}
	if msg := c.call(MethodSessionLoad, LoadSessionRequest{SessionID: "studio-1", Cwd: "/w"}, nil); !strings.Contains(msg, "not opened by ion acp") {
		t.Fatalf("foreign session load = %q", msg)
	}
}

func TestNoticesGoToClientsThatRenderThem(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{Session: &ClientSessionCapabilities{Notices: json.RawMessage(`{}`)}})
	res := c.newSession("/w")
	f.waitCmd("start_session")
	f.emit(res.SessionID, map[string]any{"type": "engine_notify", "level": "warning", "message": "disk low"})
	if u := c.next(UpdateNotice); u.Severity != "warning" || u.Title != "disk low" {
		t.Fatalf("notice = %+v", u)
	}
}

func TestShutdownStopsEverySession(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	a, c := startAgent(t, f, Options{})
	c.initialize(ClientCapabilities{})
	res := c.newSession("/w")
	f.waitCmd("start_session")
	a.Shutdown(t.Context())
	if stop := f.waitCmd("stop_session"); stop["key"] != res.SessionID {
		t.Fatalf("stop_session = %v", stop)
	}
}
