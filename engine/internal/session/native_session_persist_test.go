package session

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestPersistCliTurn_AppendsToIonTranscript pins the continuity core: a
// delegated-CLI turn's user prompt + assistant text are appended to Ion's
// conversation store, advancing the leaf, so a later cross-provider turn's
// transcript bridge can carry them.
func TestPersistCliTurn_AppendsToIonTranscript(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("persist-turn", defaultConfig())

	const convID = "1784000000000-aaaaaaaaaaaa"
	mgr.mu.Lock()
	s := mgr.sessions["persist-turn"]
	s.conversationID = convID
	s.pendingCliUserTurn = "what is the capital of France?"
	s.pendingCliAssistantText = "Paris."
	mgr.mu.Unlock()

	mgr.persistCliTurn("persist-turn", convID)

	// Pending fields cleared so a later exit cannot double-append.
	mgr.mu.RLock()
	u, d, k, a := s.pendingCliUserTurn, s.pendingCliDisplayText, s.pendingCliInjectionKind, s.pendingCliAssistantText
	mgr.mu.RUnlock()
	if u != "" || d != "" || k != "" || a != "" {
		t.Fatalf("pending turn not cleared: user=%q display=%q kind=%q assistant=%q", u, d, k, a)
	}

	// The Ion transcript now contains the turn.
	msgs, err := conversation.LoadMessages(convID, "")
	if err != nil {
		t.Fatalf("load messages: %v", err)
	}
	var haveUser, haveAssistant bool
	for _, m := range msgs {
		if m.Role == "user" && strings.Contains(m.Content, "capital of France") {
			haveUser = true
		}
		if m.Role == "assistant" && strings.Contains(m.Content, "Paris.") {
			haveAssistant = true
		}
	}
	if !haveUser || !haveAssistant {
		t.Fatalf("persisted turn missing from Ion transcript: user=%v assistant=%v (%d msgs)", haveUser, haveAssistant, len(msgs))
	}
}

func TestPersistCliTurn_UsesDisplayTextAndPreservesModelContext(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("structured-cli-turn", defaultConfig())

	const convID = "1784000000000-eeeeeeeeeeee"
	mgr.mu.Lock()
	s := mgr.sessions["structured-cli-turn"]
	s.conversationID = convID
	s.pendingCliUserTurn = "answers plus provider-only continuation instruction"
	s.pendingCliDisplayText = "**Which store?**\n- Postgres"
	s.pendingCliInjectionKind = string(types.InjectionKindStructuredAnswer)
	s.pendingCliAssistantText = "I will continue."
	mgr.mu.Unlock()

	mgr.persistCliTurn("structured-cli-turn", convID)

	conv, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("load conversation: %v", err)
	}
	if len(conv.Entries) < 1 {
		t.Fatal("expected persisted user entry")
	}
	md, ok := conv.Entries[0].Data.(conversation.MessageData)
	if !ok {
		t.Fatalf("entry data is %T", conv.Entries[0].Data)
	}
	if md.InjectionKind != string(types.InjectionKindStructuredAnswer) || md.MachineAuthored {
		t.Fatalf("classification = kind %q machine=%v", md.InjectionKind, md.MachineAuthored)
	}
	contextMessages := conversation.BuildContextPath(conv)
	if len(contextMessages) < 1 || !strings.Contains(fmt.Sprint(contextMessages[0].Content), "provider-only continuation instruction") {
		t.Fatalf("provider context lost hidden instruction: %#v", contextMessages)
	}
	messages, err := conversation.LoadMessages(convID, "")
	if err != nil {
		t.Fatalf("load messages: %v", err)
	}
	if len(messages) < 1 || !strings.Contains(messages[0].Content, "**Which store?**\n- Postgres") || strings.Contains(messages[0].Content, "provider-only") {
		t.Fatalf("display content = %#v", messages)
	}
}

// TestPersistCliTurn_NoopForEngineOwned verifies an engine-owned run (empty
// pendingCliUserTurn — the ApiBackend persists its own turns) writes nothing.
func TestPersistCliTurn_NoopForEngineOwned(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewApiBackend())
	_, _ = mgr.StartSession("noop-owned", defaultConfig())

	const convID = "1784000000000-bbbbbbbbbbbb"
	mgr.mu.Lock()
	mgr.sessions["noop-owned"].conversationID = convID
	// pendingCliUserTurn intentionally empty (engine-owned run).
	mgr.mu.Unlock()

	mgr.persistCliTurn("noop-owned", convID)

	if conversation.Exists(convID, "") {
		t.Fatal("engine-owned run must not create an Ion conversation file")
	}
}

// TestCliTurnPersistence_RestoresCrossProviderContinuity is the end-to-end
// regression for the reported bug: a claude turn's content must be visible to
// a subsequent (cross-provider) turn's transcript bridge. Before the fix, the
// CLI turn never landed in Ion's store, so the next provider bridged an empty
// transcript and lost the prior turn.
func TestCliTurnPersistence_RestoresCrossProviderContinuity(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("xprov", defaultConfig())

	const convID = "1784000000000-cccccccccccc"
	mgr.mu.Lock()
	s := mgr.sessions["xprov"]
	s.conversationID = convID
	mgr.mu.Unlock()

	// Turn 1 (claude): stash as prompt_dispatch would, then persist as
	// handleRunExit would.
	mgr.mu.Lock()
	s.runCaps = backend.NewClaudeCodeBackend().Capabilities()
	s.pendingCliUserTurn = "remember the secret code is BLUEBIRD"
	s.pendingCliAssistantText = "Understood, the secret code is BLUEBIRD."
	mgr.mu.Unlock()
	mgr.persistCliTurn("xprov", convID)

	// Turn 2 (a different provider): its bridge must carry turn 1's content.
	// Simulate the stale-cursor bridge path directly.
	opts := types.RunOptions{Model: "gpt-5-codex", Prompt: "what was the secret code?"}
	mgr.seedCliHistory(s, &opts)

	if !strings.Contains(opts.Prompt, "BLUEBIRD") {
		t.Fatalf("cross-provider bridge lost the prior claude turn: %q", opts.Prompt)
	}
	if !strings.Contains(opts.Prompt, "<prior-conversation>") {
		t.Fatalf("expected a bridged transcript: %q", opts.Prompt)
	}
	if !strings.HasSuffix(opts.Prompt, "what was the secret code?") {
		t.Fatalf("current prompt must remain at the end: %q", opts.Prompt)
	}
}

// TestPersistCliTurn_PreservesSlashCommandProvenance is the regression test
// for the reported bug: a slash command run on a Claude Code (delegated-CLI)
// conversation must persist the same SlashCommand/SlashArgs/SlashSource/model
// provenance the API backend writes via AddUserMessageWithInvocation, so the
// command pill survives a reload instead of showing the expanded template
// body. Before the fix, persistCliTurn had no pendingCliSlashInvocation to
// consume and always fell back to AddUserMessage/AddUserMessageWithDisplay,
// which carry no slash fields — this test fails on that code with a nil
// MessageData.SlashCommand and passes once the invocation is threaded through.
func TestPersistCliTurn_PreservesSlashCommandProvenance(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("slash-cli-turn", defaultConfig())

	const convID = "1784000000000-ffffffffffff"
	mgr.mu.Lock()
	s := mgr.sessions["slash-cli-turn"]
	s.conversationID = convID
	s.pendingCliUserTurn = "EXPANDED /recap TEMPLATE BODY for the model"
	s.pendingCliAssistantText = "Here is your recap."
	s.pendingCliSlashInvocation = &conversation.SlashInvocation{
		Command:        "/recap",
		Args:           "today",
		Source:         "ion",
		ModelAlias:     "fast",
		ModelEffective: "claude-haiku-4-5-20251001",
	}
	mgr.mu.Unlock()

	mgr.persistCliTurn("slash-cli-turn", convID)

	// Pending slash invocation cleared so a later exit cannot double-stamp it.
	mgr.mu.RLock()
	pending := s.pendingCliSlashInvocation
	mgr.mu.RUnlock()
	if pending != nil {
		t.Fatalf("pendingCliSlashInvocation not cleared: %#v", pending)
	}

	// A fresh reload from disk must show the raw invocation and its
	// provenance, not the expanded body — this is what the pill renders.
	conv, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("load conversation: %v", err)
	}
	if len(conv.Entries) < 1 {
		t.Fatal("expected persisted user entry")
	}
	md, ok := conv.Entries[0].Data.(conversation.MessageData)
	if !ok {
		t.Fatalf("entry data is %T", conv.Entries[0].Data)
	}
	if md.SlashCommand != "/recap" || md.SlashArgs != "today" || md.SlashSource != "ion" {
		t.Fatalf("slash provenance not persisted: command=%q args=%q source=%q", md.SlashCommand, md.SlashArgs, md.SlashSource)
	}
	if md.SlashModelAlias != "fast" || md.SlashModelEffective != "claude-haiku-4-5-20251001" {
		t.Fatalf("slash model provenance not persisted: alias=%q effective=%q", md.SlashModelAlias, md.SlashModelEffective)
	}
	displayJSON, err := json.Marshal(md.Content)
	if err != nil {
		t.Fatalf("marshal display content: %v", err)
	}
	if !strings.Contains(string(displayJSON), "/recap today") || strings.Contains(string(displayJSON), "EXPANDED /recap TEMPLATE BODY") {
		t.Fatalf("display content must be the raw invocation, not the expanded body: %s", displayJSON)
	}

	// The model-visible transcript (conv.Messages, distinct from the flattened
	// display messages checked above) still carries the expanded body.
	if len(conv.Messages) < 1 {
		t.Fatal("expected an LLM message")
	}
	llmJSON, err := json.Marshal(conv.Messages[0].Content)
	if err != nil {
		t.Fatalf("marshal llm content: %v", err)
	}
	if !strings.Contains(string(llmJSON), "EXPANDED /recap TEMPLATE BODY") {
		t.Fatalf("LLM-visible content missing expanded body: %s", llmJSON)
	}
}

// TestPersistCliTurn_CreatesFileForFirstTurn verifies the first CLI turn on a
// pre-minted conversation (no backing file yet) creates the Ion file rather
// than dropping the turn.
func TestPersistCliTurn_CreatesFileForFirstTurn(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("first-turn", defaultConfig())

	const convID = "1784000000000-dddddddddddd"
	mgr.mu.Lock()
	s := mgr.sessions["first-turn"]
	s.conversationID = convID
	s.pendingCliUserTurn = "hello"
	s.pendingCliAssistantText = "hi there"
	mgr.mu.Unlock()

	if conversation.Exists(convID, "") {
		t.Fatal("precondition: conversation file should not exist yet")
	}
	mgr.persistCliTurn("first-turn", convID)
	if !conversation.Exists(convID, "") {
		t.Fatal("first CLI turn did not create the Ion conversation file")
	}
}

// TestPersistCliTurn_RecordsModelChange pins the delegated-CLI half of model
// attribution. A CLI-served conversation runs none of the API runloop, so
// without the SyncModel call in persistCliTurn its header keeps the first
// run's model forever and the switch is never recorded. Revert that call and
// this goes red on both assertions.
func TestPersistCliTurn_RecordsModelChange(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("cli-model-change", defaultConfig())

	const convID = "1784000000000-cccccccccccc"
	persist := func(model, text string) {
		mgr.mu.Lock()
		s := mgr.sessions["cli-model-change"]
		s.conversationID = convID
		s.pendingCliUserTurn = text
		s.pendingCliAssistantText = "ok"
		s.modelMu.Lock()
		s.lastModel = model
		s.modelMu.Unlock()
		mgr.mu.Unlock()
		mgr.persistCliTurn("cli-model-change", convID)
	}

	persist("claude-fable-5-1", "first turn")
	persist("claude-opus-5", "second turn")

	conv, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("load conversation: %v", err)
	}
	if conv.Model != "claude-opus-5" {
		t.Errorf("expected the header to follow the serving model, got %q", conv.Model)
	}
	var changes int
	for _, entry := range conv.Entries {
		if entry.Type == conversation.EntryModelChange {
			changes++
		}
	}
	if changes != 1 {
		t.Fatalf("expected exactly one model_change entry, got %d", changes)
	}
}
