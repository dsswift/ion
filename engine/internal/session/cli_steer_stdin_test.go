package session

// A steer sent while a delegated Claude CLI run is working reaches the CLI over
// stdin. Before the CLI confirmed it, such a steer reached the model but never
// the conversation: the turn written at run exit had no record of it, so the
// message vanished from every surface on reload, and the client's pending
// bubble was never resolved. These tests pin both halves: the session routes a
// main-loop stdin steer through the confirming path with its identity intact,
// and a confirmed steer is persisted at the point in the turn where it applied.

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

type stdinSteerCall struct {
	requestID, message, kind, clientMessageID string
}

// stdinSteerMockBackend is a backend that is not API-steerable (every
// SteerWithReason answers NoRun) and confirms stdin steers itself.
type stdinSteerMockBackend struct {
	*steerableMockBackend
	mu          sync.Mutex
	steerErr    error
	stdinSteers []stdinSteerCall
	rawWrites   int
}

func (m *stdinSteerMockBackend) SteerViaStdin(requestID, message, kind, clientMessageID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.steerErr != nil {
		return m.steerErr
	}
	m.stdinSteers = append(m.stdinSteers, stdinSteerCall{requestID, message, kind, clientMessageID})
	return nil
}

func (m *stdinSteerMockBackend) WriteToStdin(_ string, _ interface{}) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rawWrites++
	return nil
}

func newStdinSteerMock(steerErr error) *stdinSteerMockBackend {
	return &stdinSteerMockBackend{steerableMockBackend: newSteerableMockBackend(backend.SteerResultNoRun), steerErr: steerErr}
}

func TestSteerAgent_StdinSteerCarriesIdentityToBackend(t *testing.T) {
	mb := newStdinSteerMock(nil)
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("cli", defaultConfig())
	withActiveRun(t, mgr, "cli", "run-cli-1")

	got := mgr.SteerAgentWithClientID("cli", "", "change course", "", "msg-abc-7")
	if got != SteerDeliveredViaStdin {
		t.Fatalf("expected SteerDeliveredViaStdin, got %s", got)
	}
	if len(mb.stdinSteers) != 1 {
		t.Fatalf("want one confirmed stdin steer, got %d", len(mb.stdinSteers))
	}
	call := mb.stdinSteers[0]
	if call.requestID != "run-cli-1" || call.message != "change course" || call.clientMessageID != "msg-abc-7" {
		t.Errorf("steer reached the backend as %+v", call)
	}
	if mb.rawWrites != 0 {
		t.Errorf("a confirmed stdin steer must not also be written unconfirmed; got %d raw writes", mb.rawWrites)
	}
}

func TestSteerAgent_StdinSteerUnsupportedFallsBackToRawWrite(t *testing.T) {
	mb := newStdinSteerMock(backend.ErrStdinSteerUnsupported)
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("cli", defaultConfig())
	withActiveRun(t, mgr, "cli", "run-cli-1")

	if got := mgr.SteerAgent("cli", "", "follow up"); got != SteerDeliveredViaStdin {
		t.Fatalf("expected SteerDeliveredViaStdin, got %s", got)
	}
	if mb.rawWrites != 1 {
		t.Errorf("want the unconfirmed fallback write, got %d raw writes", mb.rawWrites)
	}
}

func TestSteerAgent_StdinSteerWriteFailureIsRejected(t *testing.T) {
	mb := newStdinSteerMock(errors.New("stdin pipe closed"))
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("cli", defaultConfig())
	withActiveRun(t, mgr, "cli", "run-cli-1")

	if got := mgr.SteerAgent("cli", "", "too late"); got != SteerRejectedNoRun {
		t.Fatalf("expected SteerRejectedNoRun, got %s", got)
	}
	if mb.rawWrites != 0 {
		t.Errorf("a failed confirmed write must not be retried unconfirmed; got %d raw writes", mb.rawWrites)
	}
}

// The recorder places a confirmed steer where the CLI reported consuming it,
// and ignores a confirmation without text (a backend that persists its own).
func TestCliTranscriptRecorder_RecordsConfirmedSteerInPlace(t *testing.T) {
	r := newCliTranscriptRecorder()
	r.record(types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "working"}})
	r.record(types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: "Bash", ToolID: "tu_1", Index: 0}})
	r.record(types.NormalizedEvent{Data: &types.ToolCallCompleteEvent{Index: 0}})
	r.record(types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: "tu_1", Content: "done"}})
	r.record(types.NormalizedEvent{Data: &types.SteerInjectedEvent{MessageLength: 13, Text: "change course"}})
	r.record(types.NormalizedEvent{Data: &types.SteerInjectedEvent{MessageLength: 5}})
	r.record(types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "changed"}})

	items := r.drain()
	kinds := make([]string, len(items))
	for i, it := range items {
		kinds[i] = it.kind
	}
	want := []string{"text", "tool_use", "tool_result", "steer", "text"}
	if len(kinds) != len(want) {
		t.Fatalf("items %v, want %v", kinds, want)
	}
	for i := range want {
		if kinds[i] != want[i] {
			t.Fatalf("items %v, want %v", kinds, want)
		}
	}
	if items[3].text != "change course" {
		t.Errorf("steer text %q", items[3].text)
	}
}

// A persisted steer is a user message between the tool results the model had
// already seen and the reply it wrote after reading the steer, followed by the
// steer marker a reload renders from.
func TestAppendStructuredCliTurn_PersistsSteerBetweenResultsAndReply(t *testing.T) {
	conv := conversation.CreateConversation("cli-steer-test", "", "m")
	items := []cliTranscriptItem{
		{kind: "text", text: "working"},
		{kind: "tool_use", toolID: "tu_1", toolName: "Bash", input: map[string]any{"command": "ls"}},
		{kind: "tool_result", toolID: "tu_1", resultContent: "done"},
		{kind: "steer", text: "change course"},
		{kind: "text", text: "changed"},
	}
	if wrote, _ := appendStructuredCliTurn(conv, items, "cli-model", nil); !wrote {
		t.Fatal("appendStructuredCliTurn wrote nothing")
	}

	msgs := conv.Messages
	if len(msgs) != 4 {
		t.Fatalf("want 4 messages (assistant, tool results, steer, assistant), got %d", len(msgs))
	}
	if msgs[2].Role != "user" || userText(msgs[2].Content) != "change course" {
		t.Fatalf("msg 2 must be the steer as a user turn, got role %s content %#v", msgs[2].Role, msgs[2].Content)
	}
	if msgs[3].Role != "assistant" {
		t.Fatalf("msg 3 role %s, want the reply after the steer", msgs[3].Role)
	}

	steerMsgAt, markerAt := -1, -1
	for i, entry := range conv.Entries {
		if data, ok := entry.Data.(conversation.MessageData); ok && data.Role == "user" && userText(data.Content) == "change course" {
			steerMsgAt = i
		}
		if entry.Type == conversation.EntrySteerMarker {
			markerAt = i
		}
	}
	if steerMsgAt == -1 || markerAt != steerMsgAt+1 {
		t.Fatalf("want the steer marker right after the steer entry; steer at %d, marker at %d", steerMsgAt, markerAt)
	}
}

// userText flattens a persisted user message's content to its text.
func userText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []types.LlmContentBlock:
		out := ""
		for _, b := range c {
			out += b.Text
		}
		return out
	}
	return ""
}

// The wire event carries the steer's classification, so a client never renders
// a machine injection as a person's steer, and never carries the steer's text.
func TestTranslateSteerInjected_CarriesClassificationNotText(t *testing.T) {
	ee := translateToEngineEvent(types.NormalizedEvent{Data: &types.SteerInjectedEvent{
		MessageLength:   14,
		Kind:            string(types.InjectionKindAgentCompletion),
		MachineAuthored: true,
		Text:            "agent finished",
	}}, 200000)
	raw, err := json.Marshal(ee)
	if err != nil {
		t.Fatal(err)
	}
	wire := string(raw)
	if !strings.Contains(wire, `"steerMachineAuthored":true`) || !strings.Contains(wire, `"steerKind":"agent_completion"`) {
		t.Errorf("classification missing from the wire: %s", wire)
	}
	if strings.Contains(wire, "agent finished") {
		t.Errorf("steer text leaked onto the wire: %s", wire)
	}
}
