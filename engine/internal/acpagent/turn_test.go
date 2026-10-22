package acpagent

import (
	"testing"
	"time"
)

func statusAt(state string, epoch int64) map[string]any {
	return map[string]any{"type": "engine_status", "fields": map[string]any{"state": state, "runEpoch": epoch}}
}

// openTurnSession opens a session and lets the start status settle the
// agent's view of the run epoch before a prompt is sent.
func openTurnSession(t *testing.T, f *fakeEngine, c *acpClient, epoch int64) string {
	t.Helper()
	c.initialize(ClientCapabilities{})
	res := c.newSession("/w")
	f.waitCmd("start_session")
	f.emit(res.SessionID, statusAt("idle", epoch))
	f.emit(res.SessionID, map[string]any{"type": "engine_command_registry", "commands": []map[string]any{{"name": "brief"}}})
	c.next(UpdateAvailableCommands)
	return res.SessionID
}

func assertPending(t *testing.T, done <-chan promptResult) {
	t.Helper()
	select {
	case r := <-done:
		t.Fatalf("turn ended early: %+v", r)
	case <-time.After(150 * time.Millisecond):
	}
}

func assertEnded(t *testing.T, done <-chan promptResult) promptResult {
	t.Helper()
	select {
	case r := <-done:
		return r
	case <-time.After(5 * time.Second):
		t.Fatal("turn never ended")
		return promptResult{}
	}
}

// An idle built before the engine took the prompt (its epoch has not passed
// the one seen before the prompt) does not end the turn; the run's own idle
// does.
func TestPreDispatchIdleDoesNotEndTheTurn(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	key := openTurnSession(t, f, c, 4)

	done := c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "go"}}})
	f.waitCmd("send_prompt")
	f.emit(key, statusAt("idle", 4))
	assertPending(t, done)

	f.emit(key, statusAt("running", 5))
	f.emit(key, statusAt("idle", 5))
	if r := assertEnded(t, done); r.err != "" || r.StopReason != StopEndTurn {
		t.Fatalf("turn = %+v", r)
	}
}

// A lower epoch is a recreated session: the baseline is rebased, so the new
// session's first run still ends the turn.
func TestRecreatedSessionRebasesTheEpoch(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	key := openTurnSession(t, f, c, 7)

	done := c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "go"}}})
	f.waitCmd("send_prompt")
	f.emit(key, statusAt("idle", 0))
	assertPending(t, done)
	f.emit(key, statusAt("running", 1))
	f.emit(key, statusAt("idle", 1))
	assertEnded(t, done)
}

// A slash command that never starts a run ends on its command result; one
// that starts a run ends on that run's idle.
func TestCommandTurnsEndOnTheirResultOrTheirRun(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	key := openTurnSession(t, f, c, 2)

	done := c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "/brief"}}})
	f.waitCmd("command")
	f.emit(key, map[string]any{"type": "engine_command_result", "command": "brief"})
	if r := assertEnded(t, done); r.err != "" {
		t.Fatalf("command turn = %+v", r)
	}

	done = c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "/brief"}}})
	f.waitCmd("command")
	f.emit(key, statusAt("running", 3))
	f.emit(key, map[string]any{"type": "engine_command_result", "command": "brief"})
	assertPending(t, done)
	f.emit(key, statusAt("idle", 3))
	assertEnded(t, done)

	done = c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "/brief"}}})
	f.waitCmd("command")
	f.emit(key, map[string]any{"type": "engine_command_result", "command": "brief", "commandError": "boom"})
	if r := assertEnded(t, done); r.err == "" {
		t.Fatal("a failed command should end its turn with the error")
	}
}
