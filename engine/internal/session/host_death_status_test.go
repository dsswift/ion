package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// parkedSessionWithHost starts a session whose extension group holds one host
// and whose outstanding set holds one background command, the shape of a
// session parked on a background command when its run exits.
func parkedSessionWithHost(t *testing.T, key string) (*Manager, *extension.Host) {
	t.Helper()
	mgr := NewManager(newMockBackend())
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("start session: %v", err)
	}
	host := extension.NewHost()
	group := extension.NewExtensionGroup()
	group.Add(host)
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.extGroup = group
	s.outstandingBackgroundTasks = map[string]outstandingBackgroundTask{"bash-1": {}}
	mgr.mu.Unlock()
	return mgr, host
}

func statusEvents(mgr *Manager) *[]*types.StatusFields {
	var got []*types.StatusFields
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_status" && ev.Fields != nil {
			got = append(got, ev.Fields)
		}
	})
	return &got
}

// A run exit with live extensions must not publish a status. A bare idle here
// erased the parked session's pending work, and the ACP bridge ended a turn
// that was waiting on a background command.
func TestRespawnDeadExtensions_LiveHostsEmitNoStatus(t *testing.T) {
	mgr, _ := parkedSessionWithHost(t, "live-hosts")
	got := statusEvents(mgr)

	mgr.respawnDeadExtensions("live-hosts")

	if len(*got) != 0 {
		t.Fatalf("emitted %d engine_status events, want none: %+v", len(*got), (*got)[0])
	}
}

// A real respawn publishes its statuses as complete snapshots: the restarting
// and the settled status both still carry the parked session's work.
func TestRespawnDeadExtensions_StatusesKeepPendingWork(t *testing.T) {
	mgr, host := parkedSessionWithHost(t, "dead-host")
	host.MarkDeadForTest()
	got := statusEvents(mgr)

	mgr.respawnDeadExtensions("dead-host")

	if len(*got) != 2 {
		t.Fatalf("emitted %d engine_status events, want 2", len(*got))
	}
	wantStates := []string{"extension_restarting", "idle"}
	for i, f := range *got {
		if f.State != wantStates[i] {
			t.Errorf("status %d state = %q, want %q", i, f.State, wantStates[i])
		}
		if !f.HasPendingWork || f.BackgroundShells != 1 {
			t.Errorf("status %d = pending %v, shells %d; want pending true, shells 1", i, f.HasPendingWork, f.BackgroundShells)
		}
	}
}
