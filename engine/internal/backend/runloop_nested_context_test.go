package backend

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// newNestedTestRun builds a minimal activeRun with an initialized sink and
// dedup set, suitable for driving drainNestedContext directly.
func newNestedTestRun(requestID string) *activeRun {
	return &activeRun{
		requestID:           requestID,
		touchedSink:         types.NewTouchedPathSink(),
		injectedNestedPaths: make(map[string]bool),
	}
}

// lastUserMessageText returns the rendered text of the last user message in
// the conversation, or "" if none. Nested-context injections carry their
// rendered "# Context from <path>" body in a typed context_injection block's
// Text field, so this reads the first block's Text directly.
func lastUserMessageText(conv *conversation.Conversation) string {
	for i := len(conv.Messages) - 1; i >= 0; i-- {
		if conv.Messages[i].Role != "user" {
			continue
		}
		if blocks, ok := conv.Messages[i].Content.([]types.LlmContentBlock); ok {
			for _, b := range blocks {
				if b.Text != "" {
					return b.Text
				}
			}
		}
		return ""
	}
	return ""
}

// TestDrainNestedContext_InjectsAndDedups pins the end-to-end behavior: a
// touched path under cwd/sub with sub/AGENTS.md produces exactly one nested
// injection containing the file content, and a second drain of the same path
// injects nothing (conversation-lifetime dedup via injectedNestedPaths).
//
// Revert-check: clearing run.injectedNestedPaths between drains re-injects.
func TestDrainNestedContext_InjectsAndDedups(t *testing.T) {
	cwd := t.TempDir()
	sub := filepath.Join(cwd, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	agentsContent := "# sub agents\nfollow sub rules"
	os.WriteFile(filepath.Join(sub, "AGENTS.md"), []byte(agentsContent), 0o644)
	target := filepath.Join(sub, "foo.go")
	os.WriteFile(target, []byte("package sub"), 0o644)

	b := NewApiBackend()
	run := newNestedTestRun("req-nested-1")
	conv := conversation.CreateConversation("nested-conv", "", "claude-3")

	// SuppressSystemMessages keeps the injection transient (in-memory), so the
	// test does not write to ~/.ion/conversations.
	opts := types.RunOptions{
		ProjectPath:            cwd,
		SuppressSystemMessages: true,
	}

	// First drain: record the touched path, drain, expect one injection.
	run.touchedSink.Add(target)
	b.drainNestedContext(run, conv, RunHooks{}, opts, cwd, 1, 0)

	got := lastUserMessageText(conv)
	if !strings.Contains(got, nestedContextMarkerPrefix+filepath.Join(sub, "AGENTS.md")) {
		t.Fatalf("expected nested injection marker for sub/AGENTS.md, got:\n%s", got)
	}
	if !strings.Contains(got, "follow sub rules") {
		t.Fatalf("expected nested injection to contain file content, got:\n%s", got)
	}
	if !run.injectedNestedPaths[filepath.Join(sub, "AGENTS.md")] {
		t.Error("expected sub/AGENTS.md recorded in injectedNestedPaths")
	}
	msgCountAfterFirst := len(conv.Messages)

	// Second drain of the same path: dedup must suppress re-injection.
	run.touchedSink.Add(target)
	b.drainNestedContext(run, conv, RunHooks{}, opts, cwd, 2, 0)
	if len(conv.Messages) != msgCountAfterFirst {
		t.Errorf("second drain re-injected: messages %d -> %d (dedup failed)", msgCountAfterFirst, len(conv.Messages))
	}

	// Revert-check: clear the dedup set, drain again, re-injection occurs.
	run.mu.Lock()
	run.injectedNestedPaths = make(map[string]bool)
	run.mu.Unlock()
	run.touchedSink.Add(target)
	b.drainNestedContext(run, conv, RunHooks{}, opts, cwd, 3, 0)
	if len(conv.Messages) == msgCountAfterFirst {
		t.Error("revert-check: clearing dedup set should have re-injected, but message count was unchanged")
	}
}

// TestDrainNestedContext_DisableGate pins that DisableNestedContext suppresses
// injection (and still drains the sink so it does not grow unbounded).
func TestDrainNestedContext_DisableGate(t *testing.T) {
	cwd := t.TempDir()
	sub := filepath.Join(cwd, "sub")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(filepath.Join(sub, "AGENTS.md"), []byte("x"), 0o644)
	target := filepath.Join(sub, "f.go")
	os.WriteFile(target, []byte("x"), 0o644)

	b := NewApiBackend()
	run := newNestedTestRun("req-nested-disabled")
	conv := conversation.CreateConversation("nested-conv-2", "", "claude-3")
	opts := types.RunOptions{ProjectPath: cwd, SuppressSystemMessages: true, DisableNestedContext: true}

	run.touchedSink.Add(target)
	before := len(conv.Messages)
	b.drainNestedContext(run, conv, RunHooks{}, opts, cwd, 1, 0)
	if len(conv.Messages) != before {
		t.Error("DisableNestedContext should inject nothing")
	}
	// Sink must be drained even when disabled.
	if remaining := run.touchedSink.DrainAndClear(); remaining != nil {
		t.Errorf("sink should be drained when disabled, got %v", remaining)
	}
}

// TestDrainNestedContext_ClaudeGate pins that a nested CLAUDE.md is injected
// only when ClaudeCompat is true.
func TestDrainNestedContext_ClaudeGate(t *testing.T) {
	cwd := t.TempDir()
	sub := filepath.Join(cwd, "sub")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(filepath.Join(sub, "CLAUDE.md"), []byte("claude sub"), 0o644)
	target := filepath.Join(sub, "f.go")
	os.WriteFile(target, []byte("x"), 0o644)

	b := NewApiBackend()
	conv := conversation.CreateConversation("nested-conv-3", "", "claude-3")

	// Gate off: no injection.
	runOff := newNestedTestRun("req-claude-off")
	optsOff := types.RunOptions{ProjectPath: cwd, SuppressSystemMessages: true, ClaudeCompat: false}
	runOff.touchedSink.Add(target)
	beforeOff := len(conv.Messages)
	b.drainNestedContext(runOff, conv, RunHooks{}, optsOff, cwd, 1, 0)
	if len(conv.Messages) != beforeOff {
		t.Error("claudeCompat=false: nested CLAUDE.md must not be injected")
	}

	// Gate on: injection occurs.
	runOn := newNestedTestRun("req-claude-on")
	optsOn := types.RunOptions{ProjectPath: cwd, SuppressSystemMessages: true, ClaudeCompat: true}
	runOn.touchedSink.Add(target)
	beforeOn := len(conv.Messages)
	b.drainNestedContext(runOn, conv, RunHooks{}, optsOn, cwd, 1, 0)
	if len(conv.Messages) == beforeOn {
		t.Error("claudeCompat=true: nested CLAUDE.md must be injected")
	}
	if !strings.Contains(lastUserMessageText(conv), "claude sub") {
		t.Error("expected CLAUDE.md content in the injection")
	}
}

// TestSeedInjectedNestedPaths pins that markers in conv.System (text) and a
// typed context_injection block in conv.Messages (structural) are both
// recovered so the drain does not re-inject an already-present file.
func TestSeedInjectedNestedPaths(t *testing.T) {
	conv := conversation.CreateConversation("seed-conv", "", "claude-3")
	conv.System = "preamble\n" + nestedContextMarkerPrefix + "/repo/AGENTS.md\n# repo agents\nmore"
	// A real prior-session nested injection is a typed context_injection block,
	// not plain prose — seeding recovers it from the block's ContextPaths.
	conversation.AddContextInjectionMessage(conv,
		[]string{"/repo/desktop/AGENTS.md"},
		nestedContextMarkerPrefix+"/repo/desktop/AGENTS.md\n# desktop agents",
		false)

	seeded := seedInjectedNestedPaths(conv, types.RunOptions{})
	if !seeded[filepath.Clean("/repo/AGENTS.md")] {
		t.Error("expected /repo/AGENTS.md seeded from conv.System")
	}
	if !seeded["/repo/desktop/AGENTS.md"] {
		t.Error("expected /repo/desktop/AGENTS.md seeded from the typed context_injection block")
	}

	// And from opts.AppendSystemPrompt.
	seeded2 := seedInjectedNestedPaths(conv, types.RunOptions{
		AppendSystemPrompt: nestedContextMarkerPrefix + "/repo/engine/AGENTS.md\n# engine",
	})
	if !seeded2[filepath.Clean("/repo/engine/AGENTS.md")] {
		t.Error("expected /repo/engine/AGENTS.md seeded from opts.AppendSystemPrompt")
	}
}

// TestSeedIgnoresMarkerProseInMessages is the regression test for the dedup
// false-positive fix. A plain user message whose body merely CONTAINS a
// "# Context from <path>" line (a user pasting an Ion log, the model echoing
// the marker, another harness using the same header) must NOT seed that path
// as already-injected — only a typed context_injection block may. Before the
// fix, the seeder text-scanned every message body and would falsely suppress a
// legitimate nested load for /repo/foreign/AGENTS.md.
//
// Revert-check: restoring the old message-body text scan makes this fail
// (the foreign path would be present in the seed set).
func TestSeedIgnoresMarkerProseInMessages(t *testing.T) {
	conv := conversation.CreateConversation("seed-prose", "", "claude-3")
	// Foreign content that happens to contain the marker line, but is NOT a
	// context_injection block — e.g. the user pasted a transcript.
	conversation.AddUserMessage(conv,
		"here is a log I pasted:\n"+nestedContextMarkerPrefix+"/repo/foreign/AGENTS.md\nsome body")

	seeded := seedInjectedNestedPaths(conv, types.RunOptions{})
	if seeded["/repo/foreign/AGENTS.md"] || seeded[filepath.Clean("/repo/foreign/AGENTS.md")] {
		t.Error("marker prose in a plain user message must not seed the dedup set; " +
			"only a typed context_injection block may")
	}
	if len(seeded) != 0 {
		t.Errorf("expected empty seed set from prose-only message, got %v", seeded)
	}
}

// TestSeedPreventsReinjection pins the reload guarantee: a file already present
// in conversation history as a typed context_injection block (seeded) is not
// re-injected even though the sink records its directory.
func TestSeedPreventsReinjection(t *testing.T) {
	cwd := t.TempDir()
	sub := filepath.Join(cwd, "sub")
	os.MkdirAll(sub, 0o755)
	agentsPath := filepath.Join(sub, "AGENTS.md")
	os.WriteFile(agentsPath, []byte("sub agents"), 0o644)
	target := filepath.Join(sub, "f.go")
	os.WriteFile(target, []byte("x"), 0o644)

	b := NewApiBackend()
	conv := conversation.CreateConversation("seed-reinj", "", "claude-3")
	// Simulate a prior-session nested injection already in history as the
	// typed block the live injector now writes.
	conversation.AddContextInjectionMessage(conv,
		[]string{agentsPath},
		nestedContextMarkerPrefix+agentsPath+"\nsub agents",
		false)

	run := newNestedTestRun("req-seed-reinj")
	opts := types.RunOptions{ProjectPath: cwd, SuppressSystemMessages: true}
	run.mu.Lock()
	run.injectedNestedPaths = seedInjectedNestedPaths(conv, opts)
	run.mu.Unlock()

	before := len(conv.Messages)
	run.touchedSink.Add(target)
	b.drainNestedContext(run, conv, RunHooks{}, opts, cwd, 1, 0)
	if len(conv.Messages) != before {
		t.Error("seeded path must not be re-injected after reload")
	}
}

// TestDrainNestedContext_ConcurrentSink pins that concurrent sink writes plus a
// drain do not race (run with -race).
func TestDrainNestedContext_ConcurrentSink(t *testing.T) {
	cwd := t.TempDir()
	sub := filepath.Join(cwd, "sub")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(filepath.Join(sub, "AGENTS.md"), []byte("x"), 0o644)
	target := filepath.Join(sub, "f.go")
	os.WriteFile(target, []byte("x"), 0o644)

	b := NewApiBackend()
	run := newNestedTestRun("req-conc")
	conv := conversation.CreateConversation("conc-conv", "", "claude-3")
	opts := types.RunOptions{ProjectPath: cwd, SuppressSystemMessages: true}

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			run.touchedSink.Add(target)
		}()
	}
	go b.drainNestedContext(run, conv, RunHooks{}, opts, cwd, 1, 0)
	wg.Wait()
	b.drainNestedContext(run, conv, RunHooks{}, opts, cwd, 2, 0)
}

// TestSeedNotSpoofedByAssistantMessageProse is the spoof-case regression test
// for the structural-seed path. A model response (role "assistant") whose text
// body happens to contain a "# Context from <path>" line must NOT cause
// seedInjectedNestedPaths to treat that path as already-injected, and must NOT
// suppress a subsequent genuine nested-context injection of the same path.
//
// Attack vector: the model echoes back an earlier context block verbatim (e.g.
// in a summary or a diff), producing an assistant message whose prose contains
// the marker prefix. Before the structural-seed fix, the seeder text-scanned
// every message body regardless of role or block type, so this false-positive
// could permanently prevent a directory's AGENTS.md from ever being re-injected
// in that conversation. The structural seed (CollectInjectedContextPaths) reads
// only typed context_injection blocks; a plain assistant text block carries no
// such block and cannot seed.
//
// Revert-check: restoring a message-body text scan in seedInjectedNestedPaths
// (e.g. calling collectMarkers over every message's text) makes this test fail:
// the assistant message prose seeds the path, drainNestedContext dedupes it,
// and no injection message is appended.
func TestSeedNotSpoofedByAssistantMessageProse(t *testing.T) {
	cwd := t.TempDir()
	sub := filepath.Join(cwd, "agents")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	agentsContent := "# real agents\nfollow real rules"
	agentsPath := filepath.Join(sub, "AGENTS.md")
	os.WriteFile(agentsPath, []byte(agentsContent), 0o644)
	target := filepath.Join(sub, "work.go")
	os.WriteFile(target, []byte("package agents"), 0o644)

	conv := conversation.CreateConversation("spoof-conv", "", "claude-3")

	// Inject a plain assistant message whose text body contains the marker
	// for agentsPath. This simulates the model echoing back context prose —
	// NOT a real engine injection (no context_injection block, no ContextPaths).
	spoofText := nestedContextMarkerPrefix + agentsPath + "\n" + agentsContent
	conversation.AddAssistantMessage(conv,
		[]types.LlmContentBlock{{Type: "text", Text: spoofText}},
		types.LlmUsage{},
	)

	// Seed must NOT pick up the path from the assistant prose.
	seeded := seedInjectedNestedPaths(conv, types.RunOptions{})
	if seeded[agentsPath] || seeded[filepath.Clean(agentsPath)] {
		t.Fatal("seedInjectedNestedPaths seeded a path from assistant message prose — " +
			"only typed context_injection blocks may seed; prose in any role must not")
	}

	// Attempt a genuine injection. Because the path was not falsely seeded,
	// drainNestedContext must inject it.
	b := NewApiBackend()
	run := newNestedTestRun("req-spoof-assistant")
	run.mu.Lock()
	run.injectedNestedPaths = seeded // use the (correctly empty) seed set
	run.mu.Unlock()

	opts := types.RunOptions{ProjectPath: cwd, SuppressSystemMessages: true}
	before := len(conv.Messages)
	run.touchedSink.Add(target)
	b.drainNestedContext(run, conv, RunHooks{}, opts, cwd, 1, 0)

	if len(conv.Messages) <= before {
		t.Fatal("genuine nested injection was suppressed by assistant message prose — " +
			"spoof defense failed: seedInjectedNestedPaths must only read typed context_injection blocks")
	}
	got := lastUserMessageText(conv)
	if !strings.Contains(got, agentsPath) {
		t.Errorf("expected injected message to contain %s, got:\n%s", agentsPath, got)
	}
	if !strings.Contains(got, "follow real rules") {
		t.Errorf("expected injected message to contain AGENTS.md content, got:\n%s", got)
	}
}
