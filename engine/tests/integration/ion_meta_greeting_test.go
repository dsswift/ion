//go:build integration

package integration

// Integration tests for the ion-meta first-session greeting.
//
// The greeting is emitted as an `engine_harness_message` on
// `session_start` only when the conversation is logically new (no
// on-disk persistence file under ~/.ion/conversations/<conversationId>.*).
//
// We exercise both branches by overriding $HOME for the test process.
// Both the engine's persistence layer (Go: os.UserHomeDir() reads HOME
// on Unix) and the extension's fresh-session detector (Node:
// os.homedir() reads HOME on Unix) honour the override, so a single
// t.Setenv("HOME", tmpDir) redirects both layers consistently.
//
// File-size note: keeps ion_meta_v2_test.go untouched. Greeting cases
// have their own test file so the v2 contract suite stays focused on
// tool / persona / agent-state semantics.

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// ─── Fresh conversation: welcome fires exactly once ───

func TestIonMetaGreeting_FreshConversationEmitsWelcome(t *testing.T) {
	requireEsbuild(t)
	metaDir := ionMetaDir(t)
	entry := ionMetaEntry(t)

	// Redirect HOME so the extension's fresh-session check looks at an
	// empty conversations dir. We intentionally do NOT create the
	// conversations directory -- the detector should treat a missing
	// directory as evidence of freshness (ENOENT branch in
	// fresh-session.ts).
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     metaDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load ion-meta: %v", err)
	}

	var (
		emitMu     sync.Mutex
		emitEvents []types.EngineEvent
	)
	ctx := &extension.Context{
		SessionKey:     "ion-meta-greeting-fresh",
		ConversationID: "ion-meta-greeting-fresh-convid",
		Cwd:            "/tmp",
		Emit: func(ev types.EngineEvent) {
			emitMu.Lock()
			emitEvents = append(emitEvents, ev)
			emitMu.Unlock()
		},
	}
	if err := host.FireSessionStart(ctx); err != nil {
		t.Fatalf("FireSessionStart: %v", err)
	}

	emitMu.Lock()
	defer emitMu.Unlock()

	// Find the engine_harness_message emission. Exactly one welcome is
	// expected per session_start.
	welcomeCount := 0
	var welcome *types.EngineEvent
	for i := range emitEvents {
		if emitEvents[i].Type == "engine_harness_message" {
			welcomeCount++
			ev := emitEvents[i]
			welcome = &ev
		}
	}
	if welcomeCount != 1 {
		t.Fatalf("expected exactly 1 engine_harness_message, got %d. emitted types: %v",
			welcomeCount, typesOf(emitEvents))
	}
	if welcome.HarnessSource != "ion-meta" {
		t.Errorf("welcome source: expected %q, got %q", "ion-meta", welcome.HarnessSource)
	}
	// The welcome must carry the renderer-honored dedup key. The desktop
	// uses this to suppress repeated welcomes within a single engine-
	// instance scrollback (e.g. on app restart with no intervening turn,
	// where the filesystem-based freshness check has no persisted file
	// to consult). The engine treats `metadata` as opaque pass-through
	// (types.EngineEvent.Metadata), so this assertion proves the harness
	// set the field and the engine round-tripped it through the JSON
	// codec untouched. See greeting.ts and docs/protocol/server-events.md.
	if welcome.Metadata == nil {
		t.Errorf("welcome metadata: expected map with dedupKey, got nil")
	} else if got, ok := welcome.Metadata["dedupKey"].(string); !ok || got != "ion-meta:welcome" {
		t.Errorf("welcome metadata.dedupKey: expected %q, got %v (type %T)",
			"ion-meta:welcome", welcome.Metadata["dedupKey"], welcome.Metadata["dedupKey"])
	}
	// Canonical first-line marker -- if greeting.ts drifts off the
	// "Welcome to Ion Meta" header this test will catch it.
	if !strings.Contains(welcome.EventMessage, "Welcome to Ion Meta") {
		t.Errorf("welcome message missing canonical marker; first 80 chars: %q",
			truncate(welcome.EventMessage, 80))
	}
	// The greeting must not embed hard-coded counts -- those drift
	// silently when the tool / specialist roster changes. Reject the
	// most likely drift patterns explicitly.
	for _, banned := range []string{
		"nine tools", "nine introspection",
		"six specialists", "seven specialists",
		"seven sub-agents",
	} {
		if strings.Contains(strings.ToLower(welcome.EventMessage), banned) {
			t.Errorf("welcome message embeds hard-coded count %q; "+
				"phrase in suite/family terms per greeting.ts authoring rules",
				banned)
		}
	}
	// The greeting must not embed engine-contributor framing. ion-meta
	// is for people who consume the Ion engine to build their own
	// products on top of it; it is NOT a tool for working on the
	// engine itself. Reject the most likely contributor-leak phrasings
	// explicitly. See greeting.ts authoring rules.
	for _, banned := range []string{
		"contracts are additive",
		"never renamed",
		"never rename a hook",
		"published contract",
		"push back",
		"engine ships zero policy",
		"engine-vs-harness boundary",
	} {
		if strings.Contains(strings.ToLower(welcome.EventMessage), banned) {
			t.Errorf("welcome message embeds engine-contributor phrase %q; "+
				"ion-meta is for consumers building ON TOP OF the engine, "+
				"not for working on the engine itself. Frame from the "+
				"consumer's seat per greeting.ts authoring rules.", banned)
		}
	}
}

// ─── Continued conversation: welcome is suppressed ───

func TestIonMetaGreeting_ContinuedConversationSuppressesWelcome(t *testing.T) {
	requireEsbuild(t)
	metaDir := ionMetaDir(t)
	entry := ionMetaEntry(t)

	// Set up a temp HOME with a pre-existing conversation file. The
	// detector should observe the file via readdirSync and skip the
	// welcome emission. We use the `.llm.jsonl` suffix (v2 split
	// format) and name the file by conversationId (as persistence.go
	// does). SessionKey and ConversationID are intentionally different
	// values so this test exercises the real production correlation and
	// guards against regression to the old sessionKey-named lookup.
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	convDir := filepath.Join(tmpHome, ".ion", "conversations")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conversations dir: %v", err)
	}
	sessionKey := "ion-meta-greeting-continued-sk"
	conversationID := "ion-meta-greeting-continued-convid"
	stubPath := filepath.Join(convDir, conversationID+".llm.jsonl")
	if err := os.WriteFile(stubPath, []byte("{\"header\":\"stub\"}\n"), 0o644); err != nil {
		t.Fatalf("write conversation stub: %v", err)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     metaDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load ion-meta: %v", err)
	}

	var (
		emitMu     sync.Mutex
		emitEvents []types.EngineEvent
	)
	ctx := &extension.Context{
		SessionKey:     sessionKey,
		ConversationID: conversationID,
		Cwd:            "/tmp",
		Emit: func(ev types.EngineEvent) {
			emitMu.Lock()
			emitEvents = append(emitEvents, ev)
			emitMu.Unlock()
		},
	}
	if err := host.FireSessionStart(ctx); err != nil {
		t.Fatalf("FireSessionStart: %v", err)
	}

	emitMu.Lock()
	defer emitMu.Unlock()

	// engine_agent_state should still fire (that emission is
	// unconditional). engine_harness_message must NOT fire.
	sawAgentState := false
	for _, ev := range emitEvents {
		if ev.Type == "engine_harness_message" {
			t.Errorf("continued conversation should suppress welcome; "+
				"got engine_harness_message from source=%q first 80 chars=%q",
				ev.HarnessSource, truncate(ev.EventMessage, 80))
		}
		if ev.Type == "engine_agent_state" {
			sawAgentState = true
		}
	}
	if !sawAgentState {
		t.Errorf("expected engine_agent_state to still emit on continued sessions; "+
			"emitted types: %v", typesOf(emitEvents))
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
