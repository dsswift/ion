package backend

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// A client that inserts an optimistic user row can only collapse it against
// the persisted turn when the run announces that turn's entry id. This backend
// used to announce nothing, so every client-sent turn rendered twice after the
// next history load.
func TestClaudeCodeAnnouncesPrePersistedUserTurn(t *testing.T) {
	b := NewClaudeCodeBackend()
	var got []types.NormalizedEvent
	var gotRun string
	b.OnNormalized(func(runID string, ev types.NormalizedEvent) {
		gotRun = runID
		got = append(got, ev)
	})

	b.announceUserTurnPersisted("run-1", types.RunOptions{
		PrePersistedUserEntryID: "entry-abc",
		ResolvedSlashModelAlias: "fast",
	})

	if len(got) != 1 {
		t.Fatalf("want exactly one event, got %d", len(got))
	}
	ev, ok := got[0].Data.(*types.UserTurnPersistedEvent)
	if !ok {
		t.Fatalf("want *UserTurnPersistedEvent, got %T", got[0].Data)
	}
	if gotRun != "run-1" || ev.EntryID != "entry-abc" || ev.SlashModelAlias != "fast" {
		t.Errorf("run=%q entry=%q alias=%q", gotRun, ev.EntryID, ev.SlashModelAlias)
	}
}

func TestClaudeCodeAnnouncesNothingWithoutAPersistedTurn(t *testing.T) {
	b := NewClaudeCodeBackend()
	emitted := 0
	b.OnNormalized(func(string, types.NormalizedEvent) { emitted++ })

	b.announceUserTurnPersisted("run-2", types.RunOptions{})

	if emitted != 0 {
		t.Errorf("want no event without a persisted turn, got %d", emitted)
	}
}

// Pins the wiring: a run announces its persisted turn before anything that can
// fail. The parent context is already cancelled, so no CLI process is spawned
// whether or not a claude binary is installed.
func TestClaudeCodeRunAnnouncesBeforeAnythingCanFail(t *testing.T) {
	b := NewClaudeCodeBackend()
	var mu sync.Mutex
	var events []types.NormalizedEvent
	done := make(chan struct{})
	var once sync.Once
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		mu.Lock()
		events = append(events, ev)
		mu.Unlock()
	})
	b.OnExit(func(string, *int, *string, string) { once.Do(func() { close(done) }) })
	b.OnError(func(string, error) {})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	b.StartRun("run-3", types.RunOptions{ParentCtx: ctx, PrePersistedUserEntryID: "entry-first"})

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("run did not exit")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(events) == 0 {
		t.Fatal("run emitted no events")
	}
	ev, ok := events[0].Data.(*types.UserTurnPersistedEvent)
	if !ok || ev.EntryID != "entry-first" {
		t.Fatalf("first event = %T %+v, want the persisted-turn announcement", events[0].Data, events[0].Data)
	}
}
