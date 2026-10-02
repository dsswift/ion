package extcontext

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// conversationRegistry builds two branches under the root. Branch A: a (live)
// -> a1 (ended) -> a2 (live). Branch B: b (live). Each dispatch has its own
// conversation, named "conv-<id>", except a-noconv, which never started one.
func conversationRegistry() *DispatchRegistry {
	r := NewDispatchRegistry()
	register := func(id, parent string, depth int, conv string) {
		r.RegisterWithID(id, "agent-"+id, func(string) {}, nil, "s", parent, depth)
		if conv != "" {
			r.SetChildConvID(id, conv)
		}
	}
	register("a", "", 1, "conv-a")
	register("a1", "a", 2, "conv-a1")
	register("a2", "a1", 3, "conv-a2")
	register("a-noconv", "a", 2, "")
	register("b", "", 1, "conv-b")
	r.Deregister("a1", DispatchOutcome{Status: DispatchStatusCancelled, Reason: "superseded", ExitCode: 2})
	return r
}

// TestResolveOwnedConversation_Lineage pins the authorization rule: the root
// reads every dispatch's conversation, a dispatched agent reads its direct and
// transitive descendants (through an ancestor that already ended), and
// nothing else: not itself, an ancestor, a sibling branch, or a conversation
// no dispatch wrote.
func TestResolveOwnedConversation_Lineage(t *testing.T) {
	r := conversationRegistry()
	cases := []struct {
		name, owner, conv string
		want              bool
	}{
		{"root reads child", "", "conv-a", true},
		{"root reads grandchild", "", "conv-a2", true},
		{"parent reads ended child", "a", "conv-a1", true},
		{"parent reads grandchild through ended child", "a", "conv-a2", true},
		{"ended child's own descendant", "a1", "conv-a2", true},
		{"agent does not read itself", "a", "conv-a", false},
		{"agent does not read ancestor", "a2", "conv-a", false},
		{"agent does not read sibling branch", "a", "conv-b", false},
		{"sibling branch does not read across", "b", "conv-a2", false},
		{"root does not read an unrelated conversation", "", "conv-unrelated", false},
		{"unknown owner reads nothing", "ghost", "conv-a2", false},
	}
	for _, tc := range cases {
		if _, ok := r.ResolveOwnedConversation(tc.owner, tc.conv, ""); ok != tc.want {
			t.Errorf("%s: authorized = %v, want %v", tc.name, ok, tc.want)
		}
	}
}

// TestResolveOwnedConversation_ReportsDispatchState pins what an authorized
// lookup reports: live status for a running dispatch, the terminal status,
// reason, and exit code for an ended one, and that a dispatch ID addresses the
// same target as its conversation ID.
func TestResolveOwnedConversation_ReportsDispatchState(t *testing.T) {
	r := conversationRegistry()

	live, ok := r.ResolveOwnedConversation("", "conv-a2", "")
	if !ok || live.DispatchID != "a2" || live.Status != "running" || live.Terminal || live.ConversationID != "conv-a2" {
		t.Errorf("live = %+v, ok %v", live, ok)
	}
	ended, ok := r.ResolveOwnedConversation("a", "", "a1")
	if !ok || ended.ConversationID != "conv-a1" || ended.Status != DispatchStatusCancelled || !ended.Terminal ||
		ended.Reason != "superseded" || ended.ExitCode == nil || *ended.ExitCode != 2 {
		t.Errorf("ended = %+v, ok %v", ended, ok)
	}
	if noConv, ok := r.ResolveOwnedConversation("a", "", "a-noconv"); !ok || noConv.ConversationID != "" {
		t.Errorf("dispatch without a conversation = %+v, ok %v; want owned with no conversation", noConv, ok)
	}
	if _, ok := r.ResolveOwnedConversation("", "conv-b", "a2"); ok {
		t.Error("a dispatch ID and a conversation ID naming different dispatches were authorized")
	}
	if _, ok := r.ResolveOwnedConversation("", "", ""); ok {
		t.Error("an empty target was authorized")
	}
}

// TestResolveOwnedConversation_FailsClosedPastRetention pins that lineage
// which has aged out of the registry no longer authorizes a read.
func TestResolveOwnedConversation_FailsClosedPastRetention(t *testing.T) {
	r := conversationRegistry()
	if _, ok := r.ResolveOwnedConversation("", "conv-a1", ""); !ok {
		t.Fatal("retained dispatch was not readable before eviction")
	}
	r.SetHistoryLimits(&types.DispatchHistoryConfig{MaxEntries: -1})
	if _, ok := r.ResolveOwnedConversation("", "conv-a1", ""); ok {
		t.Error("evicted dispatch's conversation is still readable")
	}
	// a2's parent a1 is no longer known, so a cannot prove it owns a2.
	if _, ok := r.ResolveOwnedConversation("a", "conv-a2", ""); ok {
		t.Error("a grandchild behind an evicted ancestor is still readable by the grandparent")
	}
}

// TestResolveOwnedConversation_SeededHistoryAuthorizes pins the restart path:
// a registry holding only history seeded from durable records still
// authorizes the root, and a seeded "lost" dispatch reports as terminal.
func TestResolveOwnedConversation_SeededHistoryAuthorizes(t *testing.T) {
	r := NewDispatchRegistry()
	now := time.Now()
	r.SeedHistory([]DispatchTerminalEntry{
		{DispatchID: "d-1", Name: "lead", Depth: 1, Status: DispatchStatusDone, CompletedAt: now, ChildConversationID: "conv-d-1"},
		{DispatchID: "d-2", Name: "worker", ParentDispatchID: "d-1", Depth: 2, Status: DispatchStatusLost, Reason: "engine restarted", CompletedAt: now, ChildConversationID: "conv-d-2"},
	})
	lost, ok := r.ResolveOwnedConversation("", "conv-d-2", "")
	if !ok || lost.Status != DispatchStatusLost || !lost.Terminal || lost.Reason != "engine restarted" {
		t.Errorf("seeded lost dispatch = %+v, ok %v", lost, ok)
	}
	if _, ok := r.ResolveOwnedConversation("d-1", "conv-d-2", ""); !ok {
		t.Error("seeded lineage does not authorize the parent dispatch")
	}
	if _, ok := r.ResolveOwnedConversation("", "conv-never-dispatched", ""); ok {
		t.Error("a conversation with no seeded dispatch was authorized after restart")
	}
}

// limitedSA is a session accessor that supplies only the engine config.
type limitedSA struct {
	noopSA
	cfg *types.EngineRuntimeConfig
}

func (s limitedSA) EngineConfig() *types.EngineRuntimeConfig { return s.cfg }

// TestReadDispatchConversation_Outcomes pins the four machine-readable
// outcomes end to end against a real conversation file.
func TestReadDispatchConversation_Outcomes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	conv := conversation.CreateConversation("conv-a1", "", "model-a")
	conversation.AddUserMessage(conv, "task")
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "partial work"}}, types.LlmUsage{})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	r := conversationRegistry()
	sa := limitedSA{cfg: &types.EngineRuntimeConfig{DispatchConversationRead: &types.DispatchConversationReadConfig{MaxEntries: 1}}}
	read := BuildReadDispatchConversationFunc(sa, r, "a")
	call := func(opts extension.ReadDispatchConversationOpts) *extension.DispatchConversationResult {
		t.Helper()
		result, err := read(opts)
		if err != nil {
			t.Fatalf("read(%+v): %v", opts, err)
		}
		return result
	}

	// The recalled child's transcript is readable, bounded by the engine
	// maximum even though the caller asked for more, and its recall reason
	// rides beside the transcript rather than inside it.
	ok := call(extension.ReadDispatchConversationOpts{ConversationID: "conv-a1", Limit: 500})
	if ok.Outcome != extension.DispatchConversationOK || len(ok.Entries) != 1 || !ok.HasMore || ok.NextCursor == "" || ok.TotalEntries != 2 {
		t.Fatalf("ok page = %+v", ok)
	}
	if ok.Status != DispatchStatusCancelled || !ok.Terminal || ok.Reason != "superseded" || ok.DispatchID != "a1" || ok.AgentName != "agent-a1" {
		t.Errorf("dispatch state on ok page = %+v", ok)
	}
	if ok.Limits == nil || ok.Limits.Entries != 1 || ok.Limits.MaxEntries != 1 || ok.Limits.Bytes != types.DefaultDispatchConversationReadBytes {
		t.Errorf("limits = %+v, want the engine maximum applied", ok.Limits)
	}
	rest := call(extension.ReadDispatchConversationOpts{ConversationID: "conv-a1", Cursor: ok.NextCursor})
	if len(rest.Entries) != 1 || rest.HasMore || rest.Entries[0].Blocks[0].Text != "partial work" {
		t.Errorf("second page = %+v", rest)
	}

	denied := call(extension.ReadDispatchConversationOpts{ConversationID: "conv-b"})
	if denied.Outcome != extension.DispatchConversationUnauthorized || denied.DispatchID != "" || denied.ConversationID != "" || len(denied.Entries) != 0 {
		t.Errorf("sibling read = %+v, want unauthorized with nothing disclosed", denied)
	}

	notCreated := call(extension.ReadDispatchConversationOpts{DispatchID: "a-noconv"})
	if notCreated.Outcome != extension.DispatchConversationUnavailable || notCreated.UnavailableReason != extension.DispatchConversationNotCreated || notCreated.Status != "running" {
		t.Errorf("dispatch with no conversation = %+v", notCreated)
	}
	// a2 is owned and has a conversation ID, but no file was ever written.
	notFound := call(extension.ReadDispatchConversationOpts{ConversationID: "conv-a2"})
	if notFound.Outcome != extension.DispatchConversationUnavailable || notFound.UnavailableReason != extension.DispatchConversationNotFound {
		t.Errorf("conversation missing from the store = %+v", notFound)
	}

	badCursor := call(extension.ReadDispatchConversationOpts{ConversationID: "conv-a1", Cursor: "garbage"})
	if badCursor.Outcome != extension.DispatchConversationInvalidCursor || len(badCursor.Entries) != 0 {
		t.Errorf("garbage cursor = %+v", badCursor)
	}
}

// persistRecordingSA records the conversation ID a dispatch persists.
type persistRecordingSA struct {
	noopSA
	persisted map[string]string
}

func (s persistRecordingSA) PersistDispatchConversationID(agentID, conversationID string) {
	s.persisted[agentID] = conversationID
}

// TestRecordChildConvID_PersistsConversationID pins that the moment a child
// reports its conversation, the ID is handed to durable persistence and not
// only to in-memory agent state.
func TestRecordChildConvID_PersistsConversationID(t *testing.T) {
	sa := persistRecordingSA{persisted: map[string]string{}}
	recordChildConvID(sa, "d-1", "conv-d-1", "worker", time.Now())
	if sa.persisted["d-1"] != "conv-d-1" {
		t.Errorf("persisted = %v, want d-1 -> conv-d-1", sa.persisted)
	}
}
