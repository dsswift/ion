package acpagent

import (
	"testing"
)

// releaseSession delivers an engine release for key and waits until the
// session loop has handled it: the loop is the only consumer, so a later
// event's update proves the release was seen first.
func releaseSession(t *testing.T, f *fakeEngine, c *acpClient, key string) {
	t.Helper()
	f.emit(key, map[string]any{"type": "engine_session_released", "sessionReleaseReason": "idle_timeout", "sessionReleaseConversationId": "c-1"})
	f.emit(key, map[string]any{"type": "engine_command_registry", "commands": []map[string]any{{"name": "brief"}}})
	c.next(UpdateAvailableCommands)
}

// commandsFor returns the names of the commands sent for key, in order,
// starting after the first `skip` of them.
func commandsFor(f *fakeEngine, key string, skip int) ([]string, []map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var names []string
	var cmds []map[string]any
	for _, cmd := range f.commands {
		if cmd["key"] != key {
			continue
		}
		if skip > 0 {
			skip--
			continue
		}
		names = append(names, cmd["cmd"].(string))
		cmds = append(cmds, cmd)
	}
	return names, cmds
}

func countFor(f *fakeEngine, key string) int {
	names, _ := commandsFor(f, key, 0)
	return len(names)
}

func runPrompt(t *testing.T, f *fakeEngine, c *acpClient, key string, epoch int64) {
	t.Helper()
	done := c.sendPrompt(PromptRequest{SessionID: key, Prompt: []ContentBlock{{Type: "text", Text: "go"}}})
	f.waitCmd("send_prompt")
	f.emit(key, statusAt("running", epoch))
	f.emit(key, statusAt("idle", epoch))
	if r := assertEnded(t, done); r.err != "" || r.StopReason != StopEndTurn {
		t.Fatalf("turn = %+v", r)
	}
}

// A prompt to a session the engine released reopens it on its bound
// conversation before the prompt is sent, instead of failing.
func TestReleasedSessionReopensOnNextPrompt(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	key := openTurnSession(t, f, c, 0)
	releaseSession(t, f, c, key)
	before := countFor(f, key)

	runPrompt(t, f, c, key, 1)

	names, cmds := commandsFor(f, key, before)
	if len(names) != 2 || names[0] != "start_session" || names[1] != "send_prompt" {
		t.Fatalf("commands after release = %v, want [start_session send_prompt]", names)
	}
	config, _ := cmds[0]["config"].(map[string]any)
	if _, forced := config["forceNewConversation"]; forced {
		t.Fatalf("reopen forced a new conversation: %v", config)
	}

	// Reopened once: the next prompt goes straight through.
	before = countFor(f, key)
	runPrompt(t, f, c, key, 2)
	if names, _ := commandsFor(f, key, before); len(names) != 1 || names[0] != "send_prompt" {
		t.Fatalf("commands on the reopened session = %v, want [send_prompt]", names)
	}
}

// The reopened engine session starts in build mode; the plan mode the client
// set is restored before the prompt runs.
func TestReleasedSessionReopenRestoresPlanMode(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	key := openTurnSession(t, f, c, 0)
	if msg := c.call(MethodSessionSetMode, SetSessionModeRequest{SessionID: key, ModeID: ModePlan}, nil); msg != "" {
		t.Fatalf("set mode: %s", msg)
	}
	releaseSession(t, f, c, key)
	before := countFor(f, key)

	runPrompt(t, f, c, key, 1)

	names, cmds := commandsFor(f, key, before)
	if len(names) != 3 || names[0] != "start_session" || names[1] != "set_plan_mode" || names[2] != "send_prompt" {
		t.Fatalf("commands after release = %v, want [start_session set_plan_mode send_prompt]", names)
	}
	if cmds[1]["enabled"] != true {
		t.Fatalf("restored plan mode = %v, want enabled", cmds[1])
	}
}

// A live session is never reopened.
func TestLiveSessionPromptDoesNotReopen(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{})
	key := openTurnSession(t, f, c, 0)
	before := countFor(f, key)

	runPrompt(t, f, c, key, 1)

	if names, _ := commandsFor(f, key, before); len(names) != 1 || names[0] != "send_prompt" {
		t.Fatalf("commands = %v, want [send_prompt]", names)
	}
}
