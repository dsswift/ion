package session

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/types"
)

type workspaceSnapshotProducer struct {
	items []types.ResourceItem
	err   error
}

func (p *workspaceSnapshotProducer) HandleQuery(types.ResourceFilter) ([]types.ResourceItem, error) {
	return p.items, p.err
}

func TestManagerWorkspaceResourceSnapshots(t *testing.T) {
	alpha := resource.NewBroker()
	if err := alpha.RegisterProducerFor("briefing", "alpha", &workspaceSnapshotProducer{items: []types.ResourceItem{
		{ID: "a", Kind: "briefing", Content: "alpha"},
		{ID: "scoped", Kind: "briefing", ConversationID: "conversation-1"},
	}}, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatal(err)
	}
	beta := resource.NewBroker()
	if err := beta.RegisterProducerFor("briefing", "beta", &workspaceSnapshotProducer{}, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatal(err)
	}
	failed := resource.NewBroker()
	if err := failed.RegisterProducerFor("briefing", "failed", &workspaceSnapshotProducer{err: errors.New("offline")}, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatal(err)
	}

	manager := &Manager{sessions: map[string]*engineSession{
		"session-z": {resourceBroker: failed},
		"session-b": {resourceBroker: beta},
		"session-a": {resourceBroker: alpha},
	}}
	snapshots := manager.WorkspaceResourceSnapshots(types.ResourceFilter{Kind: resource.WildcardKind})
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v, want one briefing snapshot", snapshots)
	}
	snapshot := snapshots[0]
	if snapshot.Kind != "briefing" {
		t.Fatalf("kind = %q, want briefing", snapshot.Kind)
	}
	if !reflect.DeepEqual(snapshot.Producers, []string{"alpha", "beta"}) {
		t.Fatalf("covered producers = %v, want [alpha beta]", snapshot.Producers)
	}
	if len(snapshot.Items) != 1 || snapshot.Items[0].ID != "a" || snapshot.Items[0].Producer != "alpha" {
		t.Fatalf("workspace items = %+v, want only alpha:a", snapshot.Items)
	}
}

func TestManagerWorkspaceResourceSnapshotsUsesFirstHealthyProducerSession(t *testing.T) {
	failed := resource.NewBroker()
	if err := failed.RegisterProducerFor("note", "shared", &workspaceSnapshotProducer{err: errors.New("starting")}, types.ResourceDeclaration{Kind: "note"}); err != nil {
		t.Fatal(err)
	}
	healthy := resource.NewBroker()
	if err := healthy.RegisterProducerFor("note", "shared", &workspaceSnapshotProducer{items: []types.ResourceItem{{ID: "ready", Kind: "note"}}}, types.ResourceDeclaration{Kind: "note"}); err != nil {
		t.Fatal(err)
	}

	manager := &Manager{sessions: map[string]*engineSession{
		"session-a": {resourceBroker: failed},
		"session-b": {resourceBroker: healthy},
	}}
	snapshots := manager.WorkspaceResourceSnapshots(types.ResourceFilter{Kind: resource.WildcardKind})
	if len(snapshots) != 1 || !reflect.DeepEqual(snapshots[0].Producers, []string{"shared"}) {
		t.Fatalf("snapshots = %+v, want healthy shared producer coverage", snapshots)
	}
	if len(snapshots[0].Items) != 1 || snapshots[0].Items[0].ID != "ready" {
		t.Fatalf("items = %+v, want healthy session item", snapshots[0].Items)
	}
}

// At boot a client subscribes to workspace resources before any session has
// loaded its extensions. A session whose producer comes online afterwards must
// still deliver that producer's workspace items to the subscriber.
func TestManagerAnnouncesProducerThatComesOnlineAfterSubscribe(t *testing.T) {
	manager := &Manager{sessions: map[string]*engineSession{}, globalBroker: resource.NewBroker()}
	got := make(chan resource.ResourceMessage, 4)
	manager.globalBroker.SubscribeDirectWildcard(types.ResourceFilter{Kind: resource.WildcardKind}, func(msg resource.ResourceMessage) { got <- msg },
		func(subID string) []resource.ResourceMessage { return nil })

	session := resource.NewBroker()
	manager.watchWorkspaceProducers("session-a", session)
	if err := session.RegisterProducerFor("briefing", "cos2", &resource.FuncProducerHost{}, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatal(err)
	}
	session.SetQueryHandlerFor("briefing", "cos2", func(types.ResourceFilter) ([]types.ResourceItem, error) {
		return []types.ResourceItem{{ID: "b1", Kind: "briefing"}, {ID: "own", Kind: "briefing", ConversationID: "c1"}}, nil
	})

	select {
	case msg := <-got:
		if msg.Type != "snapshot" || msg.Kind != "briefing" || len(msg.Items) != 1 || msg.Items[0].ID != "b1" {
			t.Fatalf("snapshot = %+v, want the one workspace briefing", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("workspace subscriber never received the late producer's items")
	}
}
