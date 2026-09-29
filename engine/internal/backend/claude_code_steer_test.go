package backend

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// These tests pin the confirmation half of a Claude CLI steer: the steer is
// written to stdin and queued, and only the CLI's own echo of it (a stdout
// "user" line flagged isReplay) announces it, with its text and identity. The
// opening prompt and a forwarded /compact are echoed too and must never be
// announced as steers.

type recordingStdin struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (r *recordingStdin) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.buf.Write(p)
}

func (r *recordingStdin) Close() error { return nil }

func steerTestBackend(t *testing.T) (*ClaudeCodeBackend, *claudeCodeRun, *recordingStdin, *[]types.NormalizedEvent) {
	t.Helper()
	b := NewClaudeCodeBackend()
	pipe := &recordingStdin{}
	run := &claudeCodeRun{requestID: "steer-run", stdinPipe: pipe}
	b.mu.Lock()
	b.activeRuns[run.requestID] = run
	b.mu.Unlock()
	var mu sync.Mutex
	events := []types.NormalizedEvent{}
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, ev)
	})
	return b, run, pipe, &events
}

func replayLine(t *testing.T, text string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"type":     "user",
		"isReplay": true,
		"message": map[string]any{
			"role":    "user",
			"content": []map[string]any{{"type": "text", "text": text}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func steersIn(events []types.NormalizedEvent) []*types.SteerInjectedEvent {
	var out []*types.SteerInjectedEvent
	for _, ev := range events {
		if s, ok := ev.Data.(*types.SteerInjectedEvent); ok {
			out = append(out, s)
		}
	}
	return out
}

func TestSteerViaStdinWritesAUserMessageAndQueuesIt(t *testing.T) {
	b, run, pipe, events := steerTestBackend(t)
	if err := b.SteerViaStdin(run.requestID, "change course", "", "msg-a-1"); err != nil {
		t.Fatal(err)
	}
	var written struct {
		Type    string `json:"type"`
		Message struct {
			Content []struct{ Type, Text string } `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(pipe.buf.Bytes()), &written); err != nil {
		t.Fatalf("stdin line is not one JSON user message: %v", err)
	}
	if written.Type != "user" || len(written.Message.Content) != 1 || written.Message.Content[0].Text != "change course" {
		t.Errorf("stdin carried %+v", written)
	}
	if len(run.pendingSteers) != 1 {
		t.Fatalf("want the steer queued for confirmation, queue is %d", len(run.pendingSteers))
	}
	if n := len(steersIn(*events)); n != 0 {
		t.Errorf("a write alone must not announce the steer; got %d announcements", n)
	}
}

func TestReplayOfQueuedSteerAnnouncesItWithIdentityAndText(t *testing.T) {
	b, run, _, events := steerTestBackend(t)
	if err := b.SteerViaStdin(run.requestID, "first", "", "msg-a-1"); err != nil {
		t.Fatal(err)
	}
	if err := b.SteerViaStdin(run.requestID, "second", "", "msg-a-2"); err != nil {
		t.Fatal(err)
	}

	// The opening prompt's echo arrives first and is not a steer.
	if !b.acknowledgeReplay(run, replayLine(t, "the opening prompt")) {
		t.Fatal("a replay line must be recognised as one")
	}
	if n := len(steersIn(*events)); n != 0 {
		t.Fatalf("the opening prompt was announced as a steer (%d)", n)
	}

	b.acknowledgeReplay(run, replayLine(t, "first"))
	b.acknowledgeReplay(run, replayLine(t, "second"))
	got := steersIn(*events)
	if len(got) != 2 {
		t.Fatalf("want two announcements, got %d", len(got))
	}
	if got[0].ClientMessageID != "msg-a-1" || got[0].Text != "first" || got[0].MessageLength != len("first") {
		t.Errorf("first announcement %+v", got[0])
	}
	if got[1].ClientMessageID != "msg-a-2" || got[1].Text != "second" {
		t.Errorf("second announcement %+v", got[1])
	}
	if len(run.pendingSteers) != 0 {
		t.Errorf("queue must be empty after both echoes, has %d", len(run.pendingSteers))
	}
}

func TestReplayOfMachineSteerNeverCarriesAClientID(t *testing.T) {
	b, run, _, events := steerTestBackend(t)
	kind := string(types.InjectionKindAgentCompletion)
	if err := b.SteerViaStdin(run.requestID, "agent finished", kind, "msg-a-9"); err != nil {
		t.Fatal(err)
	}
	b.acknowledgeReplay(run, replayLine(t, "agent finished"))
	got := steersIn(*events)
	if len(got) != 1 {
		t.Fatalf("want one announcement, got %d", len(got))
	}
	if got[0].ClientMessageID != "" || got[0].Kind != kind || !got[0].MachineAuthored {
		t.Errorf("machine steer announced as %+v", got[0])
	}
}

func TestNonReplayLinesAreNotConsumed(t *testing.T) {
	b, run, _, _ := steerTestBackend(t)
	toolResult := json.RawMessage(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"ok"}]}}`)
	if b.acknowledgeReplay(run, toolResult) {
		t.Error("a tool_result line is not a replay and must reach the normalizer")
	}
	if b.acknowledgeReplay(run, json.RawMessage(`{"type":"assistant"}`)) {
		t.Error("an assistant line is not a replay")
	}
}

func TestBuildClaudeArgs_ReplaysUserMessages(t *testing.T) {
	args := buildClaudeArgs(types.RunOptions{Model: "claude-sonnet-4-5"})
	if !strings.Contains(strings.Join(args, " "), "--replay-user-messages") {
		t.Fatal("without --replay-user-messages the CLI never confirms a steer, so none is announced or persisted")
	}
}
