package resource

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

type recorded struct {
	mu   sync.Mutex
	msgs []ResourceMessage
}

func (r *recorded) add(msg ResourceMessage) {
	r.mu.Lock()
	r.msgs = append(r.msgs, msg)
	r.mu.Unlock()
}

func (r *recorded) snapshots() []ResourceMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []ResourceMessage
	for _, msg := range r.msgs {
		if msg.Type == "snapshot" {
			out = append(out, msg)
		}
	}
	return out
}

func briefingQuery(types.ResourceFilter) ([]types.ResourceItem, error) {
	return []types.ResourceItem{
		{ID: "b1", Kind: "briefing", Title: "workspace"},
		{ID: "r1", Kind: "briefing", Title: "owned", ConversationID: "conv-1"},
	}, nil
}

// A workspace subscriber that subscribed before any session loaded the
// producer receives that producer's workspace items once, however many
// sessions later offer it.
func TestAnnounceWorkspaceProducer_OncePerSubscriber(t *testing.T) {
	global := NewBroker()
	rec := &recorded{}
	global.SubscribeDirectWildcard(types.ResourceFilter{Kind: WildcardKind}, rec.add, func(string) []ResourceMessage { return nil })

	for i := 0; i < 3; i++ {
		global.AnnounceWorkspaceProducer("briefing", "cos2", briefingQuery)
	}

	snaps := rec.snapshots()
	if len(snaps) != 1 {
		t.Fatalf("want 1 snapshot, got %d", len(snaps))
	}
	if len(snaps[0].Items) != 1 || snaps[0].Items[0].ID != "b1" {
		t.Fatalf("want only the workspace item, got %+v", snaps[0].Items)
	}
	if snaps[0].Items[0].Producer != "cos2" {
		t.Fatalf("want producer stamped, got %q", snaps[0].Items[0].Producer)
	}
	if len(snaps[0].Producers) != 1 || snaps[0].Producers[0] != "cos2" {
		t.Fatalf("want coverage [cos2], got %v", snaps[0].Producers)
	}
}

// A producer the subscriber's initial snapshot already covered is not sent again.
func TestAnnounceWorkspaceProducer_SkipsInitialCoverage(t *testing.T) {
	global := NewBroker()
	rec := &recorded{}
	global.SubscribeDirectWildcard(types.ResourceFilter{Kind: WildcardKind}, rec.add, func(subID string) []ResourceMessage {
		return []ResourceMessage{{Type: "snapshot", Kind: "briefing", SubID: subID, Producers: []string{"cos2"}}}
	})

	if got := global.AnnounceWorkspaceProducer("briefing", "cos2", briefingQuery); got != 0 {
		t.Fatalf("want 0 deliveries, got %d", got)
	}
	if len(rec.snapshots()) != 1 {
		t.Fatalf("want only the initial snapshot, got %d", len(rec.snapshots()))
	}
}

// A failed query leaves the producer uncovered so the next session retries it.
func TestAnnounceWorkspaceProducer_RetriesAfterQueryFailure(t *testing.T) {
	global := NewBroker()
	rec := &recorded{}
	global.SubscribeDirectWildcard(types.ResourceFilter{Kind: WildcardKind}, rec.add, nil)

	failing := func(types.ResourceFilter) ([]types.ResourceItem, error) { return nil, errTest }
	if got := global.AnnounceWorkspaceProducer("briefing", "cos2", failing); got != 0 {
		t.Fatalf("want 0 deliveries on failure, got %d", got)
	}
	if got := global.AnnounceWorkspaceProducer("briefing", "cos2", briefingQuery); got != 1 {
		t.Fatalf("want 1 delivery on retry, got %d", got)
	}
}

// A session broker reports a producer the first time it can answer queries.
func TestOnQueryHandlerSet_FiresOnFirstHandlerOnly(t *testing.T) {
	session := NewBroker()
	var calls []string
	session.OnQueryHandlerSet(func(kind, producer string) { calls = append(calls, kind+"/"+producer) })
	if err := session.RegisterProducerFor("briefing", "cos2", &FuncProducerHost{}, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatal(err)
	}
	session.SetQueryHandlerFor("briefing", "cos2", briefingQuery)
	session.SetQueryHandlerFor("briefing", "cos2", briefingQuery)
	if len(calls) != 1 || calls[0] != "briefing/cos2" {
		t.Fatalf("want one notice, got %v", calls)
	}
}

type testError string

func (e testError) Error() string { return string(e) }

const errTest = testError("query failed")
